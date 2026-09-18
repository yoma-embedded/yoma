import { defineConfig } from "vitest/config"

// python-stdio 要起解释器,upstream.test 一条用例里 git init/clone/fetch 十几次;Windows 上起进程
// 比 POSIX 贵一个数量级。v0.3.1 的 ci 里 cp1252 那条冷启动跑了 13 秒才回来(缺省 5 秒已过期),
// 三条 git 用例卡在 5.0–5.2 秒,afterEach 再撞 EBUSY。期限与 bench 同表:活就有这么多,不是"等不到"。
const testTimeout = process.env.CI ? 60_000 : process.platform === "win32" ? 20_000 : 5_000
const hookTimeout = process.env.CI ? 30_000 : 10_000

export default defineConfig({
  test: { name: "scripts", environment: "node", include: ["test/**/*.test.ts"], testTimeout, hookTimeout },
})
