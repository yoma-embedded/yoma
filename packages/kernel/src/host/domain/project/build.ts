import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { runEngine } from "../engines.ts"
import { inspectProject, recordBaseline } from "./store.ts"

/** Explicit user-triggered build, never invoked by detection or context loading. */
export async function checkProjectBuild(cwd: string, revision: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const view = await inspectProject(cwd)
  if (!view.saved || view.revision !== revision) throw new Error("请先保存工程档案并刷新，再运行构建")
  const command = view.profile.buildCommand.trim()
  if (!command) throw new Error("请先填写构建命令")
  signal.throwIfAborted()
  const overflow = new AbortController()
  const combined = AbortSignal.any([signal, overflow.signal])
  let outputBytes = 0
  const windows = process.platform === "win32"
  const result = await runEngine(
    windows ? (env.ComSpec ?? env.comspec ?? "cmd.exe") : "/bin/sh",
    // Match Node's shell:true cmd.exe quoting; libuv's ordinary argv escaping breaks quoted tool paths.
    windows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command],
    {
      windowsVerbatimArguments: windows,
      cwd: view.root,
      env,
      signal: combined,
      timeoutMs: 5 * 60_000,
      onOutput: ({ text }) => {
        outputBytes += Buffer.byteLength(text)
        if (outputBytes > 1024 * 1024) overflow.abort()
      },
    },
  )
  const ok = result.exitCode === 0 && !result.aborted && !result.timedOut
  let firmwareHash: string | undefined
  let artifactNote = ""
  if (ok && view.profile.firmware) {
    try {
      const file = await realpath(path.resolve(view.root, view.profile.firmware))
      const relative = path.relative(view.root, file)
      if (relative.startsWith("..") || path.isAbsolute(relative) || !(await stat(file)).isFile())
        throw new Error("固件路径不在工程内")
      const hash = createHash("sha256")
      for await (const chunk of createReadStream(file)) {
        signal.throwIfAborted()
        hash.update(chunk)
      }
      firmwareHash = hash.digest("hex")
    } catch (error) {
      artifactNote = `\n固件产物未核验：${String(error)}`
    }
  }
  return recordBaseline(view.root, view.profile, {
    command,
    profile: view.profile,
    checkedAt: new Date().toISOString(),
    exitCode: result.exitCode ?? -1,
    ok: ok && !signal.aborted,
    firmwareHash,
    output: [
      result.stdout,
      result.stderr,
      result.timedOut ? "构建超时（5 分钟），已停止进程树。" : "",
      result.aborted || signal.aborted
        ? overflow.signal.aborted
          ? "输出超过 1 MB，已停止构建。"
          : "构建已取消。"
        : "",
      artifactNote,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(-16000),
  })
}
