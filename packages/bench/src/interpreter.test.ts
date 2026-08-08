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

import { onPath, resolveScriptArgv } from "./interpreter.ts"

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
