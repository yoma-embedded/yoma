#!/usr/bin/env bun
/**
 * 跨平台启动 e2e:* —— package.json 里不能再写死 macOS 的 Electron.app 路径,
 * 也不能依赖 Unix 的 `$PWD` 环境变量展开(Windows CI 上两者都会静默跑错)。
 *
 *   bun ./scripts/run-e2e.ts ipc
 *   bun ./scripts/run-e2e.ts renderer
 *   bun ./scripts/run-e2e.ts mailbox
 *
 * 前置:bun --cwd packages/desktop run build
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"
import { resolveElectron } from "./electron-bin.ts"

const KIND = {
  ipc: { entry: "e2e-kernel-ipc.ts", out: "e2e-ipc.mjs" },
  renderer: { entry: "e2e-renderer-kernel.ts", out: "e2e-renderer.mjs" },
  mailbox: { entry: "e2e-mailbox-ipc.ts", out: "e2e-mailbox.mjs" },
} as const

const kind = process.argv[2]
if (kind !== "ipc" && kind !== "renderer" && kind !== "mailbox") {
  console.error("用法: bun ./scripts/run-e2e.ts <ipc|renderer|mailbox>")
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, "..")
const kernel = join(desktop, "out", "main", "kernel.js")
if (!existsSync(kernel)) {
  console.error(`没有构建产物 ${kernel} —— 先跑 bun --cwd packages/desktop run build`)
  process.exit(1)
}

const spec = KIND[kind]
const outfile = join(desktop, "out", "main", spec.out)
mkdirSync(dirname(outfile), { recursive: true })
await esbuild.build({
  entryPoints: [join(here, spec.entry)],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
  outfile,
  logLevel: "warning",
})

const electron = resolveElectron(desktop)
const result = spawnSync(electron, [outfile], {
  cwd: desktop,
  env: { ...process.env, YOMA_DESKTOP_DIR: desktop },
  stdio: "inherit",
  windowsHide: true,
})
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status === null ? 1 : result.status)
