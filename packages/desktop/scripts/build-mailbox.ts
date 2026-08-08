#!/usr/bin/env bun
/**
 * 打包信箱守护的两个纯 node 产物(施工指南 P1):
 *
 *   out/main/mailbox-host.mjs        守护入口(runner/mother/init/status/sim 五角色)
 *   out/main/mailbox-turn-entry.mjs  agent 轮子进程入口(一轮一进程,探针清理靠进程边界)
 *
 * 与 out/main/kernel.js 同一个道理:内核必须被 inline(raw TS 的 strip-only 报错、
 * TS 参数属性,见根 CLAUDE.md"内核接缝"),别名走 MY_PI_ALIASES 同一份 —— 不新增
 * 第五份映射。
 *
 * 走 esbuild 的 **JS API** 而不是 `bunx esbuild`:这条脚本进的是**发布产物管线**
 * (`bun run build` → CI 打包),bunx 每次按 npm latest 解析,既不可复现(esbuild
 * 的 0.x minor 会做行为变更,而下面正好依赖 alias 解析与 CJS interop 两处),
 * 离线打包机上还会因为冷缓存直接联网失败。版本钉在根 workspaces.catalog。
 *
 * 产物是 .mjs:desktop 的 package.json 没有 "type":"module",.js 会被 node 当 CJS,
 * 而两个入口都有顶层 await。
 *
 * 挂在 `bun run build` 的 electron-vite 之后跑 —— electron-vite 会清 out/,
 * 先跑就被清掉。
 */

import { build } from "esbuild"
import path from "node:path"

import { MY_PI_ALIASES } from "../../kernel/mypi.ts"

const desktopDir = path.resolve(import.meta.dir, "..")
const benchSrc = path.resolve(desktopDir, "..", "bench", "src")

// 只别名 @yoma/* 裸源码树(它们没有 package exports,非别名不可达)。
// pi-ai 不别名:esbuild 的 alias 是**前缀匹配**,`@earendil-works/pi-ai` 的映射会把
// 没列进表的子路径(如 /api/openai-completions.lazy)拼到 dist/index.js 后面直接炸掉;
// 它是有 dist + exports 的真包,交给 node 解析天然全覆盖。
// (vite 那份没这个问题 —— MY_PI_VITE_ALIAS 包的是精确 ^…$ 正则。)
const alias = Object.fromEntries(Object.entries(MY_PI_ALIASES).filter(([from]) => from.startsWith("@yoma/")))

const bundles = [
  { entry: path.join(benchSrc, "mailbox", "host-entry.ts"), outfile: path.join(desktopDir, "out/main/mailbox-host.mjs") },
  { entry: path.join(benchSrc, "turn-entry.ts"), outfile: path.join(desktopDir, "out/main/mailbox-turn-entry.mjs") },
]

for (const bundle of bundles) {
  await build({
    entryPoints: [bundle.entry],
    outfile: bundle.outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron"],
    alias,
    logLevel: "warning",
    // 被 inline 的 CJS 依赖(yaml 等)会动态 require node 内置模块;ESM 产物里
    // esbuild 的 shim 只认作用域里的 `require`,不给它就是运行时直接 throw(实测)。
    banner: {
      js: 'import { createRequire as __yomaCreateRequire } from "node:module"; const require = __yomaCreateRequire(import.meta.url);',
    },
  })
}

console.log("✓ 信箱守护产物已就位:out/main/mailbox-host.mjs + out/main/mailbox-turn-entry.mjs")
