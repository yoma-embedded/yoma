/**
 * `@` 提及的候选怎么来 —— 纯函数,不碰 DOM、不碰 solid。
 *
 * 三种形态,由光标前那段 `@…` 的样子决定:
 *
 * | 输入 | 形态 | 候选 |
 * |---|---|---|
 * | `@` | list(根) | 当前打开的文件(置顶)+ 项目根的一层 |
 * | `@packages/` | list(目录) | 该目录的一层 |
 * | `@promp` | search | `file.search` 的结果 |
 *
 * **空查询从前只回"当前打开的文件标签页"**,于是一个文件都没开过的新会话一敲 `@` 就弹
 * "没有匹配的结果" —— 它压根没去列目录(2026-09-07 的报障)。
 *
 * ## 分隔符
 *
 * 这条链路上只有 `/` 一种,`toPosix` 是唯一的入口。理由是显示层不给选择:popover 的
 * 目录段走 `util/path.ts` 的 `getDirectory`,那个函数 `split(/[/\\]/)` 之后无条件 `join("/")`。
 * 而候选的路径同时还要**原样插进提示词正文**给模型看。所以显示、匹配、插入必须是同一个
 * 字符串;放任 Windows 的 `\` 漏进来的后果是用户照着屏幕上的 `/` 打,一个都撞不上。
 */

import { MENTION_HIDDEN_NAMES, type FileEntry } from "@yoma-desktop/kernel"

/**
 * `@` 提及只剩文件与目录。
 *
 * 删掉的三种 —— agent(内核只有一个系统提示词,没有 persona)、resource(没有 MCP)、
 * reference(没有 config 里的 reference 注册表)。
 */
export type AtOption = { type: "file"; path: string; display: string; recent?: boolean }

/** 路径一律用 `/`。 */
export const toPosix = (input: string) => input.replaceAll("\\", "/")

/** 目录候选一律以 `/` 收尾 —— popover 的图标、Tab 下钻、提交时要不要当附件,都看这个尾巴。 */
export const isDirectoryPath = (value: string) => value.endsWith("/")

/**
 * 候选行拆成两段:父目录(灰)与名字(亮)。
 *
 * 不能直接用 `util/path.ts` 的 `getDirectory`:它对没有分隔符的路径回的是 `"/"`
 * (`[].join("/") + "/"`)。从前 `@` 只列搜索结果,根上的条目少见所以没人注意;现在空查询
 * 列的**就是**根那一层,每一行都会顶着一个假斜杠显示成 `/package.json`。
 */
export function splitAtOptionLabel(path: string): { directory: string; name: string } {
  const directoryPath = isDirectoryPath(path)
  const trimmed = directoryPath ? path.slice(0, -1) : path
  const cut = trimmed.lastIndexOf("/")
  return {
    directory: cut === -1 ? "" : trimmed.slice(0, cut + 1),
    name: (cut === -1 ? trimmed : trimmed.slice(cut + 1)) + (directoryPath ? "/" : ""),
  }
}

/** 光标前那段 `@…` 想要什么。 */
export type AtQuery = { mode: "list"; dir: string } | { mode: "search"; needle: string }

/**
 * `@` 后面那串(不含 `@` 本身)想要什么。
 *
 * 以 `/` 收尾 = 用户已经选定了一层目录,列它;否则当搜索词。`@packages/ap` 这种半截的
 * 走搜索 —— 服务端是拿整条相对路径做子串匹配的,`packages/ap` 照样能命中
 * `packages/app/...`,不需要在这里拆成"目录 + 前缀"。
 */
export function parseAtQuery(raw: string): AtQuery {
  const query = toPosix(raw)
  if (!query) return { mode: "list", dir: "" }
  if (query.endsWith("/")) return { mode: "list", dir: query.slice(0, -1) }
  return { mode: "search", needle: query }
}

/** 当前打开的文件标签页,置顶用。顺序即输入顺序(活动标签页在最前),去重。 */
export function recentOptions(recent: string[]): AtOption[] {
  const seen = new Set<string>()
  const out: AtOption[] = []
  for (const raw of recent) {
    const path = toPosix(raw)
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({ type: "file", path, display: path, recent: true })
  }
  return out
}

/**
 * `file.list` 的一层 → 候选。
 *
 * `FileEntry.path` 已经是相对**项目根**的路径(不是相对被列的那一层),所以不用再拼前缀。
 * 目录补上尾 `/`;排除名单与搜索共用一份,否则会出现"列得出来却搜不到"的 node_modules。
 * 条目顺序原样保留 —— `listFiles` 已经排好(目录在前,各自按字母)。
 */
export function entryOptions(entries: FileEntry[]): AtOption[] {
  const out: AtOption[] = []
  for (const entry of entries) {
    if (MENTION_HIDDEN_NAMES.has(entry.name)) continue
    const base = toPosix(entry.path)
    if (!base) continue
    const path = entry.type === "directory" ? `${base}/` : base
    out.push({ type: "file", path, display: path })
  }
  return out
}

/** `file.search` 的结果 → 候选。服务端已经交的是 `/` 形式,这里只兜底再归一化一次。 */
export function searchOptions(paths: string[]): AtOption[] {
  return paths.map((raw) => {
    const path = toPosix(raw)
    return { type: "file" as const, path, display: path }
  })
}

/**
 * 拼成最终候选:置顶项在前,其余去重跟在后面,整体封顶。
 *
 * 去重按路径,置顶的那份赢 —— 同一个文件既在"最近打开"又在列目录/搜索结果里时,
 * 留下带 `recent` 标记的那条(它进的是另一个分组,而且不参与服务端过滤)。
 *
 * 两种形态都从这里出去,所以 `MAX_AT_OPTIONS` 落在这一个地方就够。
 */
export function mergeAtOptions(pinned: AtOption[], rest: AtOption[]): AtOption[] {
  const seen = new Set(pinned.map((item) => item.path))
  const out = [...pinned]
  for (const item of rest) {
    if (seen.has(item.path)) continue
    seen.add(item.path)
    out.push(item)
  }
  return out.slice(0, MAX_AT_OPTIONS)
}

/**
 * 候选上限。
 *
 * **截的是候选集合本身,不是渲染。** popover 从前渲染 `slice(0, 10)`,而方向键导航的是
 * 全量列表 —— 第 11 项开始"选得中、看不见"。从前 `@` 只列已打开的文件所以撞不到,
 * 空查询改成列整层目录之后天天会撞。两者必须是同一批,所以上限落在这里、渲染不再截。
 * 100 行装得下绝大多数目录,更大的目录直接打字搜(服务端那边的上限是 50)。
 */
export const MAX_AT_OPTIONS = 100
