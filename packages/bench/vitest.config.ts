import { defineConfig } from "vitest/config"

// 信箱用例全是真 git(与 git.test.ts 同一条纪律),一条用例几十次 spawn;而 Windows 上起一个进程比 POSIX 贵
// 一个数量级。实测(2026-09-18,Windows 开发机):mother / runner / sync 的用例普遍 3–5 秒,loop.test 的
// 「两轮修复剧本」5.3 秒 —— 正好压过 vitest 缺省的 5 秒,在 Windows 上一直是红的(超时之后 afterEach 清目录时
// git 还没退,再连带报一条 EBUSY)。这不是"等不到",是活就有这么多,所以 Windows 本机也放宽;
// CI 的 runner 比开发机再慢 4–8 倍(见 kernel/test/patience.ts 的说明)。POSIX 本机仍是缺省的 5 秒。
const testTimeout = process.env.CI ? 60_000 : process.platform === "win32" ? 20_000 : 5_000

export default defineConfig({
  test: { name: "bench", environment: "node", include: ["src/**/*.test.ts"], testTimeout },
})
