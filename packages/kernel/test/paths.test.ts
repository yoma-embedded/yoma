/**
 * 路径解析(host/domain/paths.ts)的验收。
 *
 * MSYS 盘符翻译只在 win32 上生效,而开发机与 CI 的主力岗都不是 Windows —— 按
 * `process.platform === "win32"` 写条件断言等于一道永不会响的闸门。所以这里临时改写
 * process.platform 再调用:被测函数每次调用都现读它,这样那条分支在每台机器上都真跑。
 */

import { afterEach, describe, expect, it } from "vitest"
import os from "node:os"
import path from "node:path"

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

import { fromMsysPath, insideGitRepo, matchesToolGlob, resolveToCwd } from "../src/host/domain/paths.ts"

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform })
}

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor)
})

describe("fromMsysPath", () => {
  it("Windows 上把 Git Bash 的盘符路径翻回真盘符", () => {
    setPlatform("win32")
    expect(fromMsysPath("/d/proj/build/fw.elf")).toBe("D:/proj/build/fw.elf")
    // 只有盘符、没有后续路径时要补回根斜杠,否则 "D:" 是"D 盘的当前目录"。
    expect(fromMsysPath("/d")).toBe("D:/")
    expect(fromMsysPath("/c/Users/ben")).toBe("C:/Users/ben")
  })

  it("Windows 上不碰反斜杠路径与多段首目录", () => {
    setPlatform("win32")
    expect(fromMsysPath("D:\\proj\\build\\fw.elf")).toBe("D:\\proj\\build\\fw.elf")
    // "\d\proj" 不是 MSYS 形状(MSYS 用正斜杠),翻译它会凭空造出一个盘。
    expect(fromMsysPath("\\d\\proj")).toBe("\\d\\proj")
    // 首段不是单个字母就不是盘符,照样别动。
    expect(fromMsysPath("/usr/local/bin")).toBe("/usr/local/bin")
  })

  it("非 Windows 上原样返回:POSIX 的 /d/foo 本来就是正经绝对路径", () => {
    setPlatform("linux")
    expect(fromMsysPath("/d/proj/build/fw.elf")).toBe("/d/proj/build/fw.elf")
    expect(fromMsysPath("/d")).toBe("/d")
  })
})

describe("resolveToCwd", () => {
  const cwd = path.resolve("project-root")

  it("相对路径对着会话的 cwd 解,不是进程的 cwd", () => {
    expect(resolveToCwd(cwd, path.join("build", "fw.elf"))).toBe(path.join(cwd, "build", "fw.elf"))
    expect(resolveToCwd(cwd, "fw.elf")).toBe(path.join(cwd, "fw.elf"))
  })

  it("绝对路径原样返回", () => {
    const absolute = path.resolve(path.sep === "\\" ? "C:\\tmp" : "/tmp", "fw.elf")
    expect(resolveToCwd(cwd, absolute)).toBe(absolute)
  })

  it("不要求文件存在:这里只做路径算术,存在性由调用方自己报错", () => {
    const missing = resolveToCwd(cwd, path.join("nope", "missing.elf"))
    expect(missing).toBe(path.join(cwd, "nope", "missing.elf"))
  })

  it("和 read / edit 吃同样的写法:~ 展开、绝对路径把 .. 收掉", () => {
    expect(resolveToCwd(cwd, "~")).toBe(os.homedir())
    expect(resolveToCwd(cwd, path.join("~", "proj", "fw.elf"))).toBe(path.join(os.homedir(), "proj", "fw.elf"))
    expect(resolveToCwd(cwd, path.join(cwd, "a", "..", "fw.elf"))).toBe(path.join(cwd, "fw.elf"))
  })

  it("file:// 正常的解成路径,畸形的不抛、当普通路径走", () => {
    expect(resolveToCwd(cwd, `file://${path.join(cwd, "fw.elf")}`)).toBe(path.join(cwd, "fw.elf"))
    // 带主机名的 file URL 在 POSIX 上是非法的:不抛,落成 cwd 下的相对路径,调用方报 "not found"。
    expect(() => resolveToCwd(cwd, "file://server/share/fw.elf")).not.toThrow()
    expect(() => resolveToCwd(cwd, "file:///tmp/a%ZZb.elf")).not.toThrow()
  })

  it("Windows 上 MSYS 盘符与相对路径都落到会话 cwd 所在的盘", () => {
    setPlatform("win32")
    expect(resolveToCwd("D:\\proj", "/d/proj/build/fw.elf")).toBe("D:\\proj\\build\\fw.elf")
    expect(resolveToCwd("D:\\proj", "build/fw.elf")).toBe("D:\\proj\\build\\fw.elf")
    expect(resolveToCwd("D:\\proj", "C:\\tools\\fw.elf")).toBe("C:\\tools\\fw.elf")
  })
})

describe("matchesToolGlob(gitignore 味)", () => {
  it("不含斜杠只看文件名、任意深度;含斜杠锚在搜索根;** 跨目录", () => {
    expect(matchesToolGlob("src/deep/main.c", "*.c")).toBe(true)
    expect(matchesToolGlob("src/deep/main.c", "src/*.c")).toBe(false)
    expect(matchesToolGlob("src/deep/main.c", "src/**/*.c")).toBe(true)
    expect(matchesToolGlob("src/deep/x.spec.ts", "**/x.spec.ts")).toBe(true)
    expect(matchesToolGlob("src/main.c", "src/**")).toBe(true)
    expect(matchesToolGlob("lib/main.c", "./lib/*.c")).toBe(true)
  })

  it("没闭合的 [ 不抛,当作匹不到", () => {
    expect(() => matchesToolGlob("a.c", "[")).not.toThrow()
    expect(matchesToolGlob("a.c", "[")).toBe(false)
  })

  it("全平台都不分大小写(Node 的 matchesGlob 在 Linux 上分、mac / Windows 上不分)", () => {
    expect(matchesToolGlob("MAIN.C", "*.c")).toBe(true)
    expect(matchesToolGlob("Core/Src/main.c", "core/src/*.C")).toBe(true)
  })
})

describe("insideGitRepo", () => {
  it("向上找 .git,子目录也算在仓库里;没有 .git 的临时目录不算", () => {
    const root = mkdtempSync(path.join(tmpdir(), "yoma-ingit-"))
    try {
      mkdirSync(path.join(root, "a", "b"), { recursive: true })
      expect(insideGitRepo(path.join(root, "a", "b"))).toBe(false)
      execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" })
      expect(insideGitRepo(path.join(root, "a", "b"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
