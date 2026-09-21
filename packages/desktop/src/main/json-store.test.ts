import { afterEach, describe, expect, test } from "vitest"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyUpdate, createJsonStore, writeFileAtomic } from "./json-store"

const dirs: string[] = []
const tempFile = (name = "yoma.settings") => {
  const dir = mkdtempSync(join(tmpdir(), "yoma-json-store-"))
  dirs.push(dir)
  return join(dir, name)
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

// electron-store 11 / conf 15 实际写出来的样子(制表符缩进的一个 JSON 对象,文件名不带扩展名):
// 渲染器的名字空间里值是字符串(序列化过的 store),主进程自己的设置里值是原样的 JSON。
const ELECTRON_STORE_FILE =
  '{\n\t"layout": "{\\"sidebar\\":{\\"width\\":344}}",\n\t"autoCheck": false,\n\t"settings": {\n\t\t"remote": "git@example.com:bench.git",\n\t\t"role": "runner"\n\t}\n}'

describe("createJsonStore", () => {
  test("读得了 electron-store 留下的老文件;写回去的格式和它一样,旧版本照样读得了", () => {
    const file = tempFile()
    writeFileSync(file, ELECTRON_STORE_FILE)
    const store = createJsonStore(file)
    expect(store.get("autoCheck")).toBe(false)
    expect(store.get("settings")).toEqual({ remote: "git@example.com:bench.git", role: "runner" })
    expect(store.get("layout")).toBe('{"sidebar":{"width":344}}')
    // 改一个键再改回去:文件逐字节回到 electron-store 写的那样
    store.set("autoCheck", true)
    store.set("autoCheck", false)
    expect(readFileSync(file, "utf8")).toBe(ELECTRON_STORE_FILE)
  })

  test("没有文件 = 空;第一次写才建文件(连同目录)", () => {
    const file = join(tempFile(), "nested", "yoma.updater")
    rmSync(join(file, "..", ".."), { recursive: true, force: true })
    const store = createJsonStore(file)
    expect(store.get("ready")).toBeUndefined()
    expect(store.entries()).toEqual({})
    expect(existsSync(file)).toBe(false)
    store.set("ready", { version: "1.2.3" })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ready: { version: "1.2.3" } })
    dirs.push(join(file, "..", ".."))
  })

  test("文件只读一次:之后的读不碰磁盘,另一个实例读到的是已经落盘的内容", () => {
    const file = tempFile()
    const store = createJsonStore(file)
    store.set("a", 1)
    writeFileSync(file, '{"a": 999}')
    expect(store.get("a")).toBe(1)
    expect(createJsonStore(file).get("a")).toBe(999)
  })

  test("update:一批插入 / 覆盖 / 删除只写一次盘", () => {
    const file = tempFile()
    let writes = 0
    const store = createJsonStore(file, {
      persist: (target, content) => {
        writes += 1
        writeFileAtomic(target, content)
      },
    })
    store.update({ keep: "k", replace: "old", drop: "d" }, [])
    writes = 0
    store.update({ replace: "new", add: "a" }, ["drop", "never-existed"])
    expect(writes).toBe(1)
    expect(store.entries()).toEqual({ keep: "k", replace: "new", add: "a" })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ keep: "k", replace: "new", add: "a" })
  })

  test("delete 不存在的键不写盘;clear 清空", () => {
    const file = tempFile()
    let writes = 0
    const store = createJsonStore(file, { persist: (target, content) => (writes++, writeFileAtomic(target, content)) })
    store.set("a", 1)
    store.delete("missing")
    expect(writes).toBe(1)
    store.delete("a")
    expect(store.entries()).toEqual({})
    store.set("b", 2)
    store.clear()
    expect(readFileSync(file, "utf8")).toBe("{}")
  })

  test("set undefined 抛(和 electron-store 一样):JSON 里没有 undefined,要清掉用 delete", () => {
    const store = createJsonStore(tempFile())
    expect(() => store.set("a", undefined)).toThrow(TypeError)
  })

  test("写盘抛了:内存里还是旧值,和磁盘一致,错误照抛给调用方", () => {
    const file = tempFile()
    let fail = false
    const store = createJsonStore(file, {
      persist: (target, content) => {
        if (fail) throw new Error("ENOSPC")
        writeFileAtomic(target, content)
      },
    })
    store.set("a", 1)
    fail = true
    expect(() => store.set("a", 2)).toThrow("ENOSPC")
    expect(store.get("a")).toBe(1)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 1 })
  })

  test("读不出来的文件挪到一边(.corrupt),当作空的继续 —— 不挡启动", () => {
    const file = tempFile()
    writeFileSync(file, '{"a": 1,,, not json')
    const seen: unknown[] = []
    const store = createJsonStore(file, { onCorrupt: (error) => seen.push(error) })
    expect(store.entries()).toEqual({})
    expect(seen).toHaveLength(1)
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe('{"a": 1,,, not json')
    store.set("b", 2)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ b: 2 })
  })

  test("文件是合法 JSON 但不是对象(数组、字符串):同样挪到一边", () => {
    const file = tempFile()
    writeFileSync(file, "[1, 2, 3]")
    expect(createJsonStore(file).entries()).toEqual({})
    expect(existsSync(`${file}.corrupt`)).toBe(true)
  })
})

describe("writeFileAtomic", () => {
  test("写完不留临时文件;覆盖已有文件", () => {
    const file = tempFile("window-state.json")
    writeFileAtomic(file, "one")
    writeFileAtomic(file, "two")
    expect(readFileSync(file, "utf8")).toBe("two")
    expect(readdirSync(join(file, ".."))).toEqual(["window-state.json"])
  })
})

describe("applyUpdate", () => {
  test("不改传进来的那份;同一批里又插又删同一个键,删赢", () => {
    const data = { a: "1" }
    expect(applyUpdate(data, { b: "2", c: "3" }, ["a", "c"])).toEqual({ b: "2" })
    expect(data).toEqual({ a: "1" })
  })
})
