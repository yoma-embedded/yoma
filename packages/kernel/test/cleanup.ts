import { rmSync } from "node:fs"
import { patient } from "./patience.ts"

/** 别的进程还攥着目录时 Windows 给的几种说法;其余错误(路径写错、权限真不够)不该被重试盖住。 */
const RETRYABLE = new Set(["EPERM", "EBUSY", "ENOTEMPTY"])

/**
 * 删临时目录;删不动就**真的等一会儿**再试,直到期限。
 *
 * 为什么不用 `rmSync(dir, { maxRetries, retryDelay })`:用例里 abort 一个正在跑的假引擎之后,Windows 上那条
 * detached 的 taskkill 还没把它杀掉,`<临时目录>\stm32kernel.exe` 这个映像还在运行,目录就删不掉(EPERM)。
 * 而 Node 24 的 `fs.rmSync` 把重试交给原生实现,实测那里的 retryDelay 并不真的等 —— 设成 10 次 × 200 ms
 * (线性退避,名义上最多 11 秒)之后,整个用例文件仍然只跑了 7.2 秒就报了 EPERM。同步重试还会占住事件循环。
 * 这里每次失败都让出事件循环、真睡 100 ms;那个假引擎自己最多活 5 秒,所以一定等得到。
 * 这条在 ci 上挂过两次(2026-09-17 两个不同的提交),第二次挡住了 v0.2.9 的发版。
 */
export async function removeTempDir(
  dir: string,
  options: { timeoutMs?: number; rm?: (dir: string) => void } = {},
): Promise<void> {
  const rm = options.rm ?? ((target: string) => rmSync(target, { recursive: true, force: true }))
  const deadline = Date.now() + patient(options.timeoutMs ?? 6000)
  for (;;) {
    try {
      rm(dir)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !RETRYABLE.has(code) || Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}
