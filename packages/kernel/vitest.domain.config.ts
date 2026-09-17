import { defineConfig } from "vitest/config"

// CI 上没写期限的用例给 20 秒(本机仍是 vitest 缺省的 5 秒),见 vitest.config.ts 与 test/patience.ts。
const testTimeout = process.env.CI ? 20_000 : 5_000

export default defineConfig({
  test: { name: "kernel-domain", environment: "node", include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout },
})
