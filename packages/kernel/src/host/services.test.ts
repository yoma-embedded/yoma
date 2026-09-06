/**
 * 宿主文件服务:file.list 交出的相对路径要能原样喂回 file.read,而且读不出工作目录之外。
 *
 * 2026-09-06 的教训:内核只有一个进程、服务多个项目,它的 cwd(桌面端里是 homedir)
 * 不可能是任何项目根。file.read 曾经拿相对路径直接 stat,于是每个文件都被拼到 ~/ 下面 ——
 * 文件树列得出来,点开全是 ENOENT。这里的临时目录刻意不是 cwd,相对路径读得通才算数。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { listFiles, readFile } from "./services.ts"

let root: string
let outside: string

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "yoma-services-"))
  mkdirSync(path.join(root, "docs"))
  writeFileSync(path.join(root, "docs", "readme.md"), "# hi\n")
  writeFileSync(path.join(root, "stop-all.ps1"), "exit 0\n")
  outside = mkdtempSync(path.join(tmpdir(), "yoma-services-outside-"))
  writeFileSync(path.join(outside, "secret.txt"), "nope\n")
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe("readFile", () => {
  test("file.list 交出的相对路径原样喂回去就能读,与进程 cwd 无关", async () => {
    expect(path.resolve(root)).not.toBe(process.cwd())

    const top = await listFiles(root)
    const script = top.find((entry) => entry.name === "stop-all.ps1")
    expect(script?.path).toBe("stop-all.ps1")
    expect((await readFile(root, script!.path)).content).toBe("exit 0\n")

    const docs = await listFiles(root, "docs")
    const readme = docs.find((entry) => entry.name === "readme.md")
    expect(readme?.path).toBe(path.join("docs", "readme.md"))
    expect(await readFile(root, readme!.path)).toEqual({ content: "# hi\n", mime: "text/markdown", truncated: false })
  })

  test("正斜杠写法各平台都认(前端一律用 / 拼路径)", async () => {
    expect((await readFile(root, "docs/readme.md")).content).toBe("# hi\n")
  })

  test("工作目录内的绝对路径也收", async () => {
    expect((await readFile(root, path.join(root, "docs", "readme.md"))).content).toBe("# hi\n")
  })

  test("越界一律拒绝:.. 爬出去、外部绝对路径,不管文件存不存在", async () => {
    const climb = path.relative(root, path.join(outside, "secret.txt"))
    expect(climb.startsWith("..")).toBe(true)
    await expect(readFile(root, climb)).rejects.toThrow("路径越界")
    await expect(readFile(root, path.join(outside, "secret.txt"))).rejects.toThrow("路径越界")
    await expect(readFile(root, "../nope.txt")).rejects.toThrow("路径越界")
  })

  test("不存在的文件报 ENOENT,而且报的是工作目录下的路径,不是 cwd 下的", async () => {
    const error = (await readFile(root, "missing.md").catch((e: unknown) => e)) as NodeJS.ErrnoException
    expect(error.code).toBe("ENOENT")
    expect(error.message).toContain(path.join(root, "missing.md"))
  })
})
