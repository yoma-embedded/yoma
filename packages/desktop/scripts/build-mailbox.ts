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
 *
 * ## 为什么导出成函数
 *
 * 命令行行为一个字没变,但打包这件事另有一个调用方:授权的 e2e 要往**临时目录**打一份带
 * 一次性公钥的商业产物,再对它跑产物检查 / 真进程验证。那份产物必须与正式包同一套 esbuild
 * 选项(banner、external、format)出自同一处 —— 两套选项各写一遍的话,e2e 验过的东西
 * 和用户装的东西就不是一回事了。
 */

import { build, type BuildOptions } from "esbuild"
import path from "node:path"

import { describeLicenseBuild, licenseDefine, resolveLicenseBuild } from "./license-build.ts"

const desktopDir = path.resolve(import.meta.dirname, "..")
const benchSrc = path.resolve(desktopDir, "..", "bench", "src")

export interface BundleOptions {
  /** 产物落在哪个目录(正式管线是 `packages/desktop/out/main`)。 */
  outDir: string
  /**
   * 编译期常量。正式管线传 `licenseDefine(resolveLicenseBuild(process.env))`;
   * **不传 = 不注入**,那时 `policy.ts` 落到社区版(不检查授权)。
   */
  define?: Record<string, string>
  logLevel?: "silent" | "warning" | "info"
}

/** 所有 node 侧产物共用的 esbuild 选项。 */
const SHARED: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron", "usb"],
  // 被 inline 的 CJS 依赖(yaml 等)会动态 require node 内置模块;ESM 产物里
  // esbuild 的 shim 只认作用域里的 `require`,不给它就是运行时直接 throw(实测)。
  banner: {
    js: 'import { createRequire as __yomaCreateRequire } from "node:module"; const require = __yomaCreateRequire(import.meta.url);',
  },
}

/** 打信箱守护的两个产物,返回产物的绝对路径。 */
export async function buildMailboxBundles(options: BundleOptions): Promise<string[]> {
  const bundles = [
    { entry: path.join(benchSrc, "mailbox", "host-entry.ts"), outfile: path.join(options.outDir, "mailbox-host.mjs") },
    { entry: path.join(benchSrc, "turn-entry.ts"), outfile: path.join(options.outDir, "mailbox-turn-entry.mjs") },
  ]
  for (const bundle of bundles) {
    await build({
      ...SHARED,
      entryPoints: [bundle.entry],
      outfile: bundle.outfile,
      logLevel: options.logLevel ?? "warning",
      ...(options.define ? { define: options.define } : {}),
    })
  }
  return bundles.map((bundle) => bundle.outfile)
}

/**
 * 把内核进程入口单独打成一个 node 产物。
 *
 * **不在正式构建管线上** —— 正式的 out/main/kernel.js 由 electron-vite 出(它同时出 index.js,
 * 两个入口共享一份 main.define)。这里只服务授权 e2e:它要一份"带某把临时公钥"的 kernel.js,
 * 而不必为此跑一整趟 electron-vite。选项与信箱产物同一套,所以 e2e 里的加载行为与正式产物一致。
 */
export async function buildKernelEntryBundle(options: BundleOptions): Promise<string> {
  const outfile = path.join(options.outDir, "kernel.js")
  await build({
    ...SHARED,
    entryPoints: [path.join(desktopDir, "src", "main", "kernel-entry.ts")],
    outfile,
    logLevel: options.logLevel ?? "warning",
    ...(options.define ? { define: options.define } : {}),
  })
  return outfile
}

// 命令行:正式管线的那一步。行为与从前一致,只多了编译期注入与一行日志。
if (import.meta.filename === path.resolve(process.argv[1] ?? "")) {
  // 解析失败(商业构建缺公钥之类)就让构建在这里非零退出 —— 这一步已经在 electron-vite
  // 之后,但 prebuild 早就先拦过一次;两处都拦是因为 out/ 里四个产物必须口径一致,
  // 少任何一个吃到注入都不行。
  const licenseBuild = resolveLicenseBuild(process.env)
  await buildMailboxBundles({ outDir: path.join(desktopDir, "out", "main"), define: licenseDefine(licenseBuild) })
  console.log("✓ 信箱守护产物已就位:out/main/mailbox-host.mjs + out/main/mailbox-turn-entry.mjs")
  console.log(`  ${describeLicenseBuild(licenseBuild).split("\n").join("\n  ")}`)
}
