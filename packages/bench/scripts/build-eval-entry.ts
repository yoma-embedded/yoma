/**
 * 把评测无头入口打成一个纯 node 产物:`packages/bench/dist/yoma-eval-entry.mjs`。
 *
 * 用途:被 Harbor 这类跑批器上传进任务容器,`node yoma-eval-entry.mjs …` 跑一轮 agent。
 * 容器里只有 node、没有 tsx、没有本仓检出,所以内核必须整个 inline —— 与
 * `packages/desktop/scripts/build-mailbox.ts` 同一个道理、同一份别名表(`KERNEL_ALIASES`,
 * 不新增第五份映射)、同一个 createRequire banner(被 inline 的 CJS 依赖会动态 require
 * node 内置模块)。
 *
 *   npm run build:eval -w packages/bench
 *   node packages/bench/dist/yoma-eval-entry.mjs --help
 */

import { execSync } from "node:child_process"
import path from "node:path"

import { build } from "esbuild"

import { KERNEL_ALIASES } from "../../kernel/kernel-alias.ts"

const benchDir = path.resolve(import.meta.dirname, "..")
const entry = path.join(benchDir, "src", "eval", "entry.ts")
const outfile = path.join(benchDir, "dist", "yoma-eval-entry.mjs")

// 只别名 @yoma/* 裸源码树。pi-ai 是有 dist + exports 的真包,交给 node 解析(理由见 build-mailbox.ts)。
const alias = Object.fromEntries(Object.entries(KERNEL_ALIASES).filter(([from]) => from.startsWith("@yoma/")))

function stamp(): string {
  let sha = "unknown"
  try {
    sha = execSync("git rev-parse --short HEAD", { cwd: benchDir, encoding: "utf8" }).trim()
  } catch {
    // 没有 git 也能打包;戳里只是少了 sha。
  }
  return `${sha}@${new Date().toISOString().slice(0, 10)}`
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["electron"],
  alias,
  logLevel: "warning",
  define: { "process.env.YOMA_EVAL_BUILD": JSON.stringify(stamp()) },
  banner: {
    js: 'import { createRequire as __yomaCreateRequire } from "node:module"; const require = __yomaCreateRequire(import.meta.url);',
  },
})

console.log(`✓ ${path.relative(process.cwd(), outfile)}`)
