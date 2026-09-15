/** 大结果留在工程内,每次调用独立目录;模型只拿有界预览和完整文件的路径。 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"

import { capEngineOutput, MAX_ENGINE_OUTPUT_CHARS } from "./engines.ts"

export async function createToolOutputDir(cwd: string, name: string): Promise<string> {
  const root = path.join(cwd, ".yoma", "tool-output")
  await mkdir(root, { recursive: true })
  // 只管理自己的目录,不改用户的 .yoma/.gitignore。
  await writeFile(path.join(root, ".gitignore"), "*\n", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  return mkdtemp(path.join(root, `${name}-`))
}

export async function previewToolOutput(
  cwd: string,
  name: string,
  text: string,
  hint: string,
  limit = MAX_ENGINE_OUTPUT_CHARS,
): Promise<{ text: string; file?: string }> {
  if (text.length <= limit) return { text }
  const dir = await createToolOutputDir(cwd, name)
  const file = path.join(dir, "output.txt")
  await writeFile(file, text, "utf8")
  return { text: capEngineOutput(text, `read ${file} for the complete output; ${hint}`, limit), file }
}

/** Python traceback 的原因在末尾;限制错误长度时必须保留这一端。 */
export function engineErrorText(text: string): string {
  let trimmed = text.trim()
  if (trimmed.includes("Traceback (most recent call last):")) {
    trimmed = trimmed.split("\n").at(-1) ?? trimmed
  }
  return trimmed.length > 8_000 ? `[earlier output omitted]\n${trimmed.slice(-8_000)}` : trimmed
}

export function parseEngineObject(text: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // 包装为引擎契约错误,不把 JSON.parse 的实现细节交给模型。
  }
  throw new Error(`${label} returned invalid JSON output: ${engineErrorText(text) || "(empty output)"}`)
}
