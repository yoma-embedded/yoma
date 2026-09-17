import { defineConfig } from "vitest/config"

// CI 上没写期限的用例给 20 秒(本机仍是 vitest 缺省的 5 秒),见 vitest.config.ts 与 test/patience.ts。
const testTimeout = process.env.CI ? 20_000 : 5_000
// afterEach 里的 removeTempDir(test/cleanup.ts)会真的等被 abort 的子进程退出,CI 下它的期限是放大过的(24 秒)。
const hookTimeout = process.env.CI ? 30_000 : 10_000

export default defineConfig({
  test: { name: "kernel-domain", environment: "node", include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout, hookTimeout },
})
