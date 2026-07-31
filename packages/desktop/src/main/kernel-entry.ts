/**
 * utilityProcess 的入口。electron-vite 把它编成 out/main/kernel.js 作为 main 的第三个 rollup 入口。
 *
 * my-pi 的源码在这一步被 esbuild 整个 inline 进来:它只发 raw `.ts`,而 Electron 的
 * strip-only 加载器既吃不下 TS 参数属性(gdb.ts:485、acp/agent.ts:209),也拒绝 strip
 * node_modules 下的 `.ts`。打包一步同时解掉这两个,而 my-pi 一个字节都不用改。
 */
import { kernelSelfCheck } from "@yoma-desktop/kernel/host"

// P4 会把这里换成真正的 MessagePort 宿主。现在先做自检,把 P0 闸门钉在构建产物上。
const report = kernelSelfCheck({ enginesDir: process.env.YOMA_ENGINES_DIR })
process.parentPort?.postMessage({ type: "kernel.selfcheck", report })

if (process.env.YOMA_KERNEL_SELFCHECK === "1") {
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.tools.length === 11 ? 0 : 1)
}
