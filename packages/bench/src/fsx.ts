/**
 * 打包面的文件小工具 —— node:fs/promises 版,语义对齐 Bun.file。
 *
 * bench 曾经全用 Bun.file/Bun.write,但产品形态的守护进程要跑在 Electron 的
 * ELECTRON_RUN_AS_NODE(纯 node)里 —— exe 里没有 bun。三个函数覆盖打包面的
 * 全部用法;bun 跑 node API 无损,开发态不回归。
 *
 * fileExists 只认"存在且是普通文件":worktree 判定依赖这一点(`.git` 是文件才算
 * worktree,是目录时它必须返回 false),别"顺手"放宽成 stat 成功即真。
 */

import { readFile, stat } from "node:fs/promises"

export async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    (stats) => stats.isFile(),
    () => false,
  )
}

export async function readTextFile(file: string): Promise<string> {
  return readFile(file, "utf8")
}

export async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T
}
