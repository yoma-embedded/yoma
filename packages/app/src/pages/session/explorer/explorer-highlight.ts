/**
 * 资源管理器编辑器的语法高亮。
 *
 * 复用 pierre 的共享 shiki 实例和 "OpenCode" 主题（token 颜色全是 CSS 变量，
 * 随亮暗模式自动换色）。实例经 @yoma-desktop/ui 的 marked 模块转出口获取，
 * 顺带保证 "OpenCode" 主题已注册（模块副作用）。
 */
import { getSharedHighlighter } from "@yoma-desktop/ui/context/marked"
import { bundledLanguages, type BundledLanguage, type ThemedToken } from "shiki"

export type { ThemedToken }

/** 超过任一上限就退化为纯文本渲染（编辑仍可用） */
export const HIGHLIGHT_MAX_BYTES = 300_000
export const HIGHLIGHT_MAX_LINES = 8000

/** 无扩展名的特殊文件名 → 语言 */
const FILENAME_LANGS: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  "cmakelists.txt": "cmake",
}

/** shiki bundledLanguages 没直接收录的常见扩展名别名 */
const EXTENSION_ALIASES: Record<string, string> = {
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cc: "cpp",
  cxx: "cpp",
  ino: "cpp",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  yml: "yaml",
  wxml: "html",
  wxss: "css",
  conf: "ini",
  s: "asm",
}

/** 从文件路径推断 shiki 语言 id；认不出返回 "text"（纯文本渲染） */
export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ""
  const byName = FILENAME_LANGS[name]
  if (byName && byName in bundledLanguages) return byName
  const idx = name.lastIndexOf(".")
  if (idx <= 0) return "text"
  const ext = name.slice(idx + 1)
  const alias = EXTENSION_ALIASES[ext]
  if (alias) return alias in bundledLanguages ? alias : "text"
  return ext in bundledLanguages ? ext : "text"
}

export function canHighlight(text: string, lang: string): boolean {
  if (lang === "text") return false
  if (text.length > HIGHLIGHT_MAX_BYTES) return false
  return true
}

/**
 * 整篇 tokenize 成逐行 token。返回 undefined 表示不可高亮（调用方渲染纯文本）。
 * 行数与传入文本的 split("\n") 一一对应。
 */
export async function tokenizeLines(text: string, lang: string): Promise<ThemedToken[][] | undefined> {
  if (!canHighlight(text, lang)) return undefined
  const highlighter = await getSharedHighlighter({
    themes: ["OpenCode"],
    langs: [],
    preferredHighlighter: "shiki-wasm",
  })
  if (!highlighter.getLoadedLanguages().includes(lang)) {
    await highlighter.loadLanguage(lang as BundledLanguage)
  }
  const result = highlighter.codeToTokens(text, {
    lang: lang as BundledLanguage,
    theme: "OpenCode",
  })
  return result.tokens
}
