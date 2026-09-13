/**
 * "这个路径是目录还是文件":一次跟随符号链接的种类判断,grep / find / ls 共用。
 *
 * 内核的 env.fileInfo 是 lstat 语义:符号链接与 Windows 的目录 junction(mklink /J,
 * STM32Cube 仓库、OneDrive 迁移后的工程目录常见)都只答 "symlink",从不答 "directory"。
 * 2026-09-13 猎漏实测:`find path:"deps"`(deps -> /opt/STM32Cube)被拒成
 * "path must be a directory (got a file)",而 grep 在同一个路径上悄悄退化成单文件模式。
 * ls 早在 2026-09-12 单独修过一次 —— 三个工具各修一遍就是三份会各自漂移的拷贝,所以搬到这里。
 *
 * 只跟随一层:canonicalPath 会解到最终目标,链到链的情况一次就够。
 */

import type { Context, ExecutionEnv, FileError, FileKind } from "@earendil-works/pi-agent-core"

export type FileKindResult = { ok: true; kind: FileKind } | { ok: false; error: FileError }

export async function fileKindFollowingLinks(
  env: ExecutionEnv,
  filePath: string,
  context: Context,
): Promise<FileKindResult> {
  const info = await env.fileInfo(filePath, context)
  if (!info.ok) return { ok: false, error: info.error }
  if (info.value.kind !== "symlink") return { ok: true, kind: info.value.kind }
  const target = await env.canonicalPath(filePath, context)
  if (!target.ok) return { ok: false, error: target.error }
  const targetInfo = await env.fileInfo(target.value, context)
  if (!targetInfo.ok) return { ok: false, error: targetInfo.error }
  return { ok: true, kind: targetInfo.value.kind }
}
