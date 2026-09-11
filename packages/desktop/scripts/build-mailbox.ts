/**
 * 打包信箱守护的两个纯 node 产物(施工指南 P1):
 *
 *   out/main/mailbox-host.mjs        守护入口(runner/mother/init/status/sim 五角色)
 *   out/main/mailbox-turn-entry.mjs  agent 轮子进程入口(一轮一进程,探针清理靠进程边界)
 *
 * 与 out/main/kernel.js 同一个道理:内核必须被 inline(raw TS 的 strip-only 报错、
 * TS 参数属性,见根 CLAUDE.md"内核接缝")。@yoma-desktop/kernel 经 workspace 软链加
 * 它自己的 package.json exports 解析,esbuild 直接吃 raw TS,不需要别名。
 *
 * 走 esbuild 的 **JS API** 而不是 `npx esbuild`:这条脚本进的是**发布产物管线**
 * (`npm run build` → CI 打包),npx 每次按 npm latest 解析,既不可复现(esbuild
 * 的 0.x minor 会做行为变更,而下面正好依赖它的 CJS interop),
 * 离线打包机上还会因为冷缓存直接联网失败。版本钉在根 workspaces.catalog。
 *
 * 产物是 .mjs:desktop 的 package.json 没有 "type":"module",.js 会被 node 当 CJS,
 * 而两个入口都有顶层 await。
 *
 * 挂在 `npm run build` 的 electron-vite 之后跑 —— electron-vite 会清 out/,
 * 先跑就被清掉。
 */

import { build } from "esbuild"
import path from "node:path"

const desktopDir = path.resolve(import.meta.dirname, "..")
const benchSrc = path.resolve(desktopDir, "..", "bench", "src")

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
    // usb(node-usb 3)是 napi 原生模块:esbuild 打不了 .node,留给运行时解析。打包 app 里 mailbox-host 以
    // RUN_AS_NODE 起、没有 asar 读法,解析不到就走 kernel 工具间 scope 里 loadUsb() 的退化路径("USB 不可用,走 LAN")
    // —— 工位机的示波器本来就该走 LAN。
    external: ["electron", "usb"],
    logLevel: "warning",
    // 被 inline 的 CJS 依赖(yaml 等)会动态 require node 内置模块;ESM 产物里
    // esbuild 的 shim 只认作用域里的 `require`,不给它就是运行时直接 throw(实测)。
    banner: {
      js: 'import { createRequire as __yomaCreateRequire } from "node:module"; const require = __yomaCreateRequire(import.meta.url);',
    },
  })
}

console.log("✓ 信箱守护产物已就位:out/main/mailbox-host.mjs + out/main/mailbox-turn-entry.mjs")
