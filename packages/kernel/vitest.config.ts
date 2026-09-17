import { defineConfig } from "vitest/config"

// CI 上没写期限的用例给 20 秒(本机仍是 vitest 缺省的 5 秒)。理由与倍数的来历见 test/patience.ts:
// 4 核的 runner 被 4 个 worker 吃满,要起子进程的用例会被饿到平时的 4–8 倍。
const testTimeout = process.env.CI ? 20_000 : 5_000

export default defineConfig({
  test: { name: "kernel", environment: "node", include: ["src/**/*.test.ts"], testTimeout },
})
