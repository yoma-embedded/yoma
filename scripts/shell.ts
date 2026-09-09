import { spawn, type SpawnOptions } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import path from "node:path"

export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const win = process.platform === "win32"
  if (command.includes("/") || (win && command.includes("\\"))) {
    return isExecutable(command) ? path.resolve(command) : null
  }
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const exts = win ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase()) : [""]
  for (const dir of dirs) {
    if (win && path.extname(command)) {
      const direct = path.join(dir, command)
      if (isExecutable(direct)) return direct
    }
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform !== "win32") accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface ShellOutput {
  exitCode: number
  stdout: Buffer
  stderr: Buffer
  text(): string
}

export class ShellError extends Error {
  constructor(
    readonly argv: string[],
    readonly output: ShellOutput,
  ) {
    super(`${argv.join(" ")} exited with ${output.exitCode}\n${output.stderr.toString("utf8")}`)
    this.name = "ShellError"
  }
}

interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  quiet: boolean
  nothrow: boolean
}

function winQuote(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

function runArgv(argv: string[], options: RunOptions): Promise<ShellOutput> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv
    if (!command) return reject(new Error("$: empty command"))
    const file = which(command, options.env)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const finish = (exitCode: number) => {
      const output: ShellOutput = {
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        text: () => Buffer.concat(stdout).toString("utf8"),
      }
      if (exitCode !== 0 && !options.nothrow) reject(new ShellError(argv, output))
      else resolve(output)
    }
    if (!file) {
      stderr.push(Buffer.from(`${command}: command not found\n`))
      return finish(127)
    }
    const spawnOptions: SpawnOptions = { cwd: options.cwd, env: options.env, stdio: ["inherit", "pipe", "pipe"] }
    const child =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(file)
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[file, ...args].map(winQuote).join(" ")}"`], {
            ...spawnOptions,
            windowsVerbatimArguments: true,
          })
        : spawn(file, args, spawnOptions)
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk)
      if (!options.quiet) process.stdout.write(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk)
      if (!options.quiet) process.stderr.write(chunk)
    })
    child.on("error", reject)
    child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0)))
  })
}

export class ShellPromise implements PromiseLike<ShellOutput> {
  #argv: string[]
  #cwd?: string
  #env?: NodeJS.ProcessEnv
  #quiet = false
  #nothrow = false
  #promise?: Promise<ShellOutput>

  constructor(argv: string[]) {
    this.#argv = argv
  }

  quiet(): this {
    this.#quiet = true
    return this
  }

  nothrow(): this {
    this.#nothrow = true
    return this
  }

  cwd(dir: string): this {
    this.#cwd = dir
    return this
  }

  env(env: NodeJS.ProcessEnv): this {
    this.#env = env
    return this
  }

  async text(): Promise<string> {
    return (await this.#run()).text()
  }

  then<R1 = ShellOutput, R2 = never>(
    onfulfilled?: ((value: ShellOutput) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#run().then(onfulfilled, onrejected)
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<ShellOutput | R> {
    return this.#run().catch(onrejected)
  }

  #run(): Promise<ShellOutput> {
    this.#promise ??= runArgv(this.#argv, { cwd: this.#cwd, env: this.#env, quiet: this.#quiet, nothrow: this.#nothrow })
    return this.#promise
  }
}

export function $(strings: TemplateStringsArray, ...values: unknown[]): ShellPromise {
  const argv: string[] = []
  let current: string | null = null
  const push = () => {
    if (current !== null) argv.push(current)
    current = null
  }
  const literal = (text: string) => {
    let i = 0
    while (i < text.length) {
      const ch = text[i]!
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        push()
        i++
        continue
      }
      if (ch === '"' || ch === "'") {
        const end = text.indexOf(ch, i + 1)
        if (end < 0) throw new Error(`$: unterminated ${ch} in template`)
        current = (current ?? "") + text.slice(i + 1, end)
        i = end + 1
        continue
      }
      current = (current ?? "") + ch
      i++
    }
  }
  strings.forEach((chunk, i) => {
    literal(chunk)
    if (i >= values.length) return
    const value = values[i]
    const items = Array.isArray(value) ? value : [value]
    items.forEach((item, j) => {
      if (item === null || item === undefined) throw new Error(`$: interpolation ${i} is ${String(item)}`)
      if (j > 0) push()
      current = (current ?? "") + String(item)
    })
    if (Array.isArray(value)) push()
  })
  push()
  return new ShellPromise(argv)
}
