/**
 * 仓库根的定位 —— 一处实现,trial(夹具的 `from`)与 CLI(默认 tasks/ 与 engines/)共用。
 *
 * **认标志而不是数目录层数**:`import.meta.url` 往上走,找第一个 `package.json` 里
 * `name === "yoma-pi"` 的那层。数层数(`dirname × 3`)的那种写法在 bench 的
 * `inferProjectDir` 上踩过 —— 目录一深就把工程根推歪,而且**不报错**,症状是
 * "agent 说它看不到代码"。worktree 里目录可能叫任何名字,认名字也不行。
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT_PACKAGE_NAME = "yoma-pi"

function isRepoRoot(dir: string): boolean {
  const manifest = path.join(dir, "package.json")
  if (!existsSync(manifest)) return false
  try {
    return (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === ROOT_PACKAGE_NAME
  } catch {
    return false
  }
}

let cached: string | undefined

export function findRepoRoot(from?: string): string {
  if (from === undefined && cached) return cached
  const start = path.resolve(from ?? path.dirname(fileURLToPath(import.meta.url)))
  let dir = start
  for (;;) {
    if (isRepoRoot(dir)) {
      if (from === undefined) cached = dir
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(`从 ${start} 往上找不到仓库根(package.json 里 name 为 ${ROOT_PACKAGE_NAME} 的那层)`)
    }
    dir = parent
  }
}

export function defaultTasksDir(): string {
  return path.join(findRepoRoot(), "packages", "evals", "tasks")
}
