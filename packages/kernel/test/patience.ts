/**
 * CI 上的等待倍数。用例里那些"轮询直到成立"的等待(waitFor / waitForCall / until …)的期限过它一道。
 *
 * 为什么要有:2026-09 起 develop 的 CI 时红时绿,每次挂的用例都不一样,全是超时 —— 用例自己的期限
 * 大多已经给到 20–30 秒,先到期的是**里面**这些 5 / 10 / 15 秒的等待,和没写期限、吃 vitest 缺省 5 秒的用例。
 * 拿一次绿的 Windows 运行对过:同一条用例平时 1.2–1.3 秒,挂的那次是 5 秒、10.4 秒(慢了 4–8 倍);
 * 「真实 PowerShell 退出 0」平时就要 5.9 秒。runner 只有 4 核,vitest 的 4 个 worker 把它吃满,而这些用例
 * 还要再起子进程(PowerShell、假引擎、git),被饿到的那一条就过期。
 *
 * 只放大**正向等待**(成立即返回,放大不花时间)。"这段时间内不该发生"的断言窗口不过这里 ——
 * 放大它们只会让 CI 白等。本机不放大:5 秒等不到的东西在开发机上就是坏了,该马上看见。
 * 慢机器(电池模式的笔记本)可以用 YOMA_TEST_PATIENCE=<倍数> 自己调。
 */
const fromEnv = Number(process.env.YOMA_TEST_PATIENCE)
export const PATIENCE = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : process.env.CI ? 4 : 1

export const patient = (ms: number): number => ms * PATIENCE
