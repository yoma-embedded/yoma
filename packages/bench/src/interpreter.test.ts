/**
 * 解释器解析:同一份任务书在 Mac 和 Windows 上都要能跑判据。
 *
 * 用例都跑**真实的 PATH**(不 mock):这个模块存在的意义就是"问这台机器",
 * mock 掉之后验证的只是我们对 PATH 的记忆。
 */

import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { onPath, probeInterpreter, resetInterpreterProbeCache, resolveScriptArgv } from "./interpreter.ts"

const dirs: string[] = []
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "interp-"))
  dirs.push(dir)
  return dir
}
function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

describe("resolveScriptArgv", () => {
  test("按扩展名挑本机有的解释器,参数原样跟在脚本后面", () => {
    const dir = temp()
    const script = path.join(dir, "alive.py")
    writeFileSync(script, "print(1)")
    const resolved = resolveScriptArgv(script, ["--port", "COM3"])
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      // 这台机器上一定有 python3 或 python 其中之一(CI 与开发机都装了)。
      expect(["python3", "python", "py"]).toContain(path.basename(resolved.argv[0]!))
      expect(resolved.argv.slice(-3)).toEqual([script, "--port", "COM3"])
    }
    cleanup()
  })

  test("没有扩展名 → 直接执行,但必须有可执行位,报错要给出改法", () => {
    const dir = temp()
    const script = path.join(dir, "check")
    writeFileSync(script, "#!/bin/sh\nexit 0\n")

    const noExec = resolveScriptArgv(script)
    if (process.platform === "win32") {
      expect(noExec.ok).toBe(true)
    } else {
      expect(noExec.ok).toBe(false)
      if (!noExec.ok) expect(noExec.error).toContain("chmod +x")
      chmodSync(script, 0o755)
      const withExec = resolveScriptArgv(script)
      expect(withExec.ok).toBe(true)
      if (withExec.ok) expect(withExec.argv).toEqual([script])
    }
    cleanup()
  })

  test("脚本不存在时说清是哪个文件 —— 别让人对着 ENOENT 猜", () => {
    const resolved = resolveScriptArgv(path.join(temp(), "没有.py"))
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.error).toContain("没有.py")
    cleanup()
  })

  test("认不出的扩展名当自带 shebang 的程序,不瞎猜解释器", () => {
    const dir = temp()
    const script = path.join(dir, "run.weird")
    writeFileSync(script, "#!/bin/sh\nexit 0\n")
    if (process.platform !== "win32") chmodSync(script, 0o755)
    const resolved = resolveScriptArgv(script)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.argv).toEqual([script])
    cleanup()
  })
})

describe("onPath", () => {
  test("认得出 PATH 上有没有这个可执行文件", () => {
    expect(onPath("git")).toBe(true)
    expect(onPath("这个命令肯定不存在-yoma")).toBe(false)
  })
})

describe("解释器自检:PATH 命中不等于能用", () => {
  test("真跑得起来的解释器过自检,假的不过", () => {
    resetInterpreterProbeCache()
    expect(probeInterpreter("node", ["node", "--version"])).toBe(true)
    expect(probeInterpreter("不存在", ["这个命令肯定不存在-yoma", "--version"])).toBe(false)
    resetInterpreterProbeCache()
  })

  test("PATH 上有、但一跑就 exit 9009 的桩要报成环境问题,不能当解释器用", () => {
    // 这里在 macOS 上复现 Windows 的"应用执行别名":`%LOCALAPPDATA%\Microsoft\
    // WindowsApps\python3.exe` 在 PATH 上、stat 得到,执行却打印 "Python was not
    // found" 并 exit 9009。工位机第一次真跑就死在这儿,而且被归成了"判据没过"——
    // 于是研发端会接着烧轮次去修一个不存在的代码 bug。必须归成环境问题。
    if (process.platform === "win32") return // 这个造法依赖 POSIX 可执行位
    const dir = temp()
    for (const name of ["python3", "python", "py"]) {
      const stub = path.join(dir, name)
      writeFileSync(stub, "#!/bin/sh\necho 'Python was not found' >&2\nexit 9009\n")
      chmodSync(stub, 0o755)
    }
    const script = path.join(dir, "check.py")
    writeFileSync(script, "print(1)")

    const savedPath = process.env.PATH
    process.env.PATH = dir // PATH 上只剩这些桩,真解释器一个都够不着
    resetInterpreterProbeCache()
    try {
      const resolved = resolveScriptArgv(script)
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) {
        // 报错要指向真因:不是"没装 Python"(人已经"装过"了),而是那个桩。
        expect(resolved.error).toContain("在 PATH 上找得到")
        expect(resolved.error).toContain("应用执行别名")
      }
    } finally {
      process.env.PATH = savedPath
      resetInterpreterProbeCache()
    }
    cleanup()
  })

  test("桩挡在前面时会继续往后挑,后面有能用的就用后面的", () => {
    if (process.platform === "win32") return
    const dir = temp()
    // python3 是桩,python 是好的 —— 解析必须落到 python 上,而不是直接放弃。
    const bad = path.join(dir, "python3")
    writeFileSync(bad, "#!/bin/sh\nexit 9009\n")
    chmodSync(bad, 0o755)
    const good = path.join(dir, "python")
    writeFileSync(good, "#!/bin/sh\nexit 0\n")
    chmodSync(good, 0o755)
    const script = path.join(dir, "check.py")
    writeFileSync(script, "print(1)")

    const savedPath = process.env.PATH
    process.env.PATH = dir
    resetInterpreterProbeCache()
    try {
      const resolved = resolveScriptArgv(script)
      expect(resolved.ok).toBe(true)
      if (resolved.ok) expect(path.basename(resolved.argv[0]!)).toBe("python")
    } finally {
      process.env.PATH = savedPath
      resetInterpreterProbeCache()
    }
    cleanup()
  })
})
