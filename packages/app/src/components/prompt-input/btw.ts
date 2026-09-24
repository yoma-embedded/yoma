/**
 * `/btw 问题` 的识别(docs/btw顺便问-设计方案-20260924.md §4.8)。
 *
 * 比 CC 严一点:CC 只要求 `/btw` 后面是单词边界(`/btw?`、`/btw-x` 也算),这里要求空白或结尾 —— 跟 @ 提及那次
 * "光标后须空白"的取舍一致。不分大小写。返回去掉首尾空白的问题(可能是空串:只打了 `/btw`);不是 /btw 就是 undefined。
 */
export function parseBtw(text: string): string | undefined {
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text)
  return match ? (match[1] ?? "").trim() : undefined
}
