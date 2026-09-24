export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

export const IMAGE_EXTENSION_MIME = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])

/**
 * 内容要读进渲染器的只有图片(编成 data-URL 送进模型)。desktop 的原生选择器拿这份清单
 * 决定哪些文件读字节、哪些只交路径 —— 和 attachmentMime 认图片用的是同一张表。
 */
export const INLINE_ATTACHMENT_EXTENSIONS = Array.from(IMAGE_EXTENSION_MIME.keys())

/**
 * 只给 web 的 <input accept> 用。Web 没有可读路径,图片之外的东西 attachments 会明确拒绝,
 * 清单是为了别让人白选。Desktop 的原生选择器不设类型过滤:有真实路径的文件(原理图 PDF、
 * 源码、固件产物 .elf / .bin / .hex)一律转成 @path 交给工具去读；数据手册仍走手册库。
 */
export const ACCEPTED_FILE_TYPES = [
  ...ACCEPTED_IMAGE_TYPES,
  "application/pdf",
  "text/*",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  ".c",
  ".cc",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hh",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]
