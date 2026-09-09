import { describe, expect, test } from "vitest"
import type { FileEntry } from "@yoma-desktop/kernel"
import {
  entryOptions,
  isDirectoryPath,
  MAX_AT_OPTIONS,
  mergeAtOptions,
  parseAtQuery,
  recentOptions,
  searchOptions,
  splitAtOptionLabel,
  toPosix,
} from "./at-options"

const entry = (path: string, type: FileEntry["type"] = "file"): FileEntry => ({
  path,
  name: path.split(/[/\\]/).pop() ?? path,
  type,
})

describe("parseAtQuery", () => {
  test("空查询要的是项目根那一层,不是空列表", () => {
    // 从前空查询只回"当前打开的文件标签页",一个都没开过的新会话于是弹"没有匹配的结果"。
    expect(parseAtQuery("")).toEqual({ mode: "list", dir: "" })
    expect(parseAtQuery("/")).toEqual({ mode: "list", dir: "" })
  })

  test("以分隔符收尾 = 列这一层,两种分隔符都认", () => {
    expect(parseAtQuery("packages/")).toEqual({ mode: "list", dir: "packages" })
    expect(parseAtQuery("packages\\app\\")).toEqual({ mode: "list", dir: "packages/app" })
  })

  test("半截的路径走搜索 —— 服务端拿整条相对路径做子串匹配,不用在这里拆", () => {
    expect(parseAtQuery("prompt")).toEqual({ mode: "search", needle: "prompt" })
    expect(parseAtQuery("packages/ap")).toEqual({ mode: "search", needle: "packages/ap" })
    expect(parseAtQuery("packages\\ap")).toEqual({ mode: "search", needle: "packages/ap" })
  })
})

describe("分隔符只有一种", () => {
  test("toPosix 把 Windows 的反斜杠全换掉", () => {
    expect(toPosix("packages\\app\\src\\x.ts")).toBe("packages/app/src/x.ts")
  })

  test("候选的 path 与 display 都是正斜杠 —— 显示、匹配、插进正文的是同一个字符串", () => {
    const [option] = recentOptions(["packages\\app\\src\\x.ts"])
    expect(option!.path).toBe("packages/app/src/x.ts")
    expect(option!.display).toBe("packages/app/src/x.ts")

    const [found] = searchOptions(["docs\\readme.md"])
    expect(found!.path).toBe("docs/readme.md")

    const [listed] = entryOptions([entry("docs\\readme.md")])
    expect(listed!.path).toBe("docs/readme.md")
  })
})

describe("entryOptions", () => {
  test("目录带尾 /,文件不带;顺序原样保留(listFiles 已排好:目录在前)", () => {
    const options = entryOptions([entry("docs", "directory"), entry("packages", "directory"), entry("README.md")])
    expect(options.map((option) => option.path)).toEqual(["docs/", "packages/", "README.md"])
    expect(options.map((option) => isDirectoryPath(option.path))).toEqual([true, true, false])
  })

  test("排除名单与搜索共用一份,否则会出现列得出来却搜不到的 node_modules", () => {
    const options = entryOptions([
      entry("node_modules", "directory"),
      entry("dist", "directory"),
      entry("src", "directory"),
    ])
    expect(options.map((option) => option.path)).toEqual(["src/"])
  })

  test("FileEntry.path 是相对项目根的,列子目录时不用再拼前缀", () => {
    const options = entryOptions([entry("packages/app/src", "directory"), entry("packages/app/package.json")])
    expect(options.map((option) => option.path)).toEqual(["packages/app/src/", "packages/app/package.json"])
  })
})

describe("recentOptions / mergeAtOptions", () => {
  test("最近打开去重,带 recent 标记(分组置顶靠它)", () => {
    const options = recentOptions(["a.ts", "a.ts", "b.ts", ""])
    expect(options.map((option) => option.path)).toEqual(["a.ts", "b.ts"])
    expect(options.every((option) => option.recent)).toBe(true)
  })

  test("同一个文件既在最近打开又在目录列表里时,留置顶的那份", () => {
    const pinned = recentOptions(["src/a.ts"])
    const merged = mergeAtOptions(pinned, entryOptions([entry("src/a.ts"), entry("src/b.ts")]))
    expect(merged.map((option) => option.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(merged[0]!.recent).toBe(true)
  })

  test("候选集合本身封顶 —— 只截渲染的话方向键会走到看不见的项上去", () => {
    const many = entryOptions(Array.from({ length: MAX_AT_OPTIONS + 20 }, (_, i) => entry(`src/f${i}.ts`)))
    expect(mergeAtOptions([], many).length).toBe(MAX_AT_OPTIONS)
  })
})

describe("splitAtOptionLabel", () => {
  test("根上的条目没有父目录段", () => {
    // getDirectory("package.json") 回的是 "/"(`[].join("/") + "/"`)。空查询列的就是根那一层,
    // 直接用会让每一行都顶着一个假斜杠显示成 /package.json。
    expect(splitAtOptionLabel("package.json")).toEqual({ directory: "", name: "package.json" })
    expect(splitAtOptionLabel("docs/")).toEqual({ directory: "", name: "docs/" })
  })

  test("嵌套路径拆成灰的父目录与亮的名字,目录的名字带尾 /", () => {
    expect(splitAtOptionLabel("packages/app/src/x.ts")).toEqual({
      directory: "packages/app/src/",
      name: "x.ts",
    })
    expect(splitAtOptionLabel("packages/app/")).toEqual({ directory: "packages/", name: "app/" })
  })
})
