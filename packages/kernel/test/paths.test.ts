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

import { fromMsysPath, resolveToCwd } from "../src/host/domain/paths.ts"

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
