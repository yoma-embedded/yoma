/**
 * 守门测试:把四个盒子之间的规矩交给机器。
 *
 *   1. 菜单里没有 Node —— kernel/src 根目录(门 `.`)以及它沿相对 import 能走到的每个文件,
 *      都不许 import node:*、Node 内建、electron、只在 Node 里能跑的依赖(usb、zip.js)、host/、发动机。
 *   2. 工具间不反调会话间 —— host/domain/** 与 host/tools/** 往外只许拿 host/models.ts、
 *      host/datasheet-server.ts,碰不到 session-manager、projector、protocol;也不许绕道包名回到自家门口。
 *   3. 餐厅只走门 —— app/session-ui/ui/util 与 desktop 的 renderer/preload 引用 kernel 只许
 *      `@yoma-desktop/kernel`(菜单)或 `@yoma-desktop/kernel/tools/<名字>/contract`(契约门),
 *      不许相对路径钻进 kernel/src。
 *   4. 壳的 main 进程不拖发动机 —— 只有 kernel-entry.ts 可以走 `@yoma-desktop/kernel/host` 大门,
 *      其余文件只许走叶子门,也不许相对路径钻进 kernel/src。
 *   5. 契约文件不含 Node —— host/tools/星/contract.ts 以及它沿相对 import 能走到的每个文件,
 *      都不许 import node:*、electron、发动机。tools/ 目录今天还不存在;一旦存在,这条必须真的扫到文件。
 *
 * 顶替了合库时代的 kernel-alias.test.ts(别名表已删)。
 * 已知边界:注释剥离只认整行 // 和 /* ... *\/ 块;字符串字面量里伪装的注释或 import 不在守卫范围。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const kernelSrc = path.resolve(import.meta.dirname, "..")
const hostDir = path.join(kernelSrc, "host")
const toolsDir = path.join(hostDir, "tools")
const repoRoot = path.resolve(kernelSrc, "..", "..", "..")

const SKIP_DIRS = new Set(["node_modules", "attic", "out", "dist", ".turbo"])
const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https", "module", "net", "os",
  "path", "process", "readline", "stream", "tty", "url", "util", "worker_threads", "zlib",
])
/** kernel 自己的依赖里,只能在 Node 里跑的那几个。 */
const NODE_ONLY_DEPS = new Set(["usb", "@zip.js/zip.js", "@earendil-works/pi-agent-core"])

function walk(dir: string, out: string[] = []): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith(".d.ts")) out.push(full)
  }
  return out
}

/** 去掉注释后收集所有 import/export 说明符(静态的、动态的、裸的)。 */
function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\n)[ \t]*\/\/[^\n]*/g, "$1")
  const out: string[] = []
  for (const m of text.matchAll(/\bfrom\s*["']([^"']+)["']/g)) out.push(m[1])
  for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1])
  for (const m of text.matchAll(/(^|\n)[ \t]*import\s*["']([^"']+)["']/g)) out.push(m[2])
  return out
}

function isNodeish(spec: string): boolean {
  if (spec.startsWith("node:") || spec === "electron" || spec.startsWith("electron/")) return true
  const bare = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
  return NODE_BUILTINS.has(bare) || NODE_ONLY_DEPS.has(bare)
}

function resolveTs(p: string): string | undefined {
  for (const c of [p, `${p}.ts`, `${p}.tsx`, path.join(p, "index.ts")]) {
    if (statSync(c, { throwIfNoEntry: false })?.isFile()) return c
  }
  return undefined
}

/** 相对说明符落在 kernel/src 里(含 .ts 后缀与 index 写法)。 */
function reachesKernelSrc(spec: string, file: string): boolean {
  if (!spec.startsWith(".")) return false
  const target = path.resolve(path.dirname(file), spec)
  return target === kernelSrc || target.startsWith(kernelSrc + path.sep)
}

/** 相对说明符落在 host/ 里。 */
function reachesHost(spec: string, file: string): boolean {
  if (!spec.startsWith(".")) return false
  const target = path.resolve(path.dirname(file), spec)
  return target === hostDir || target.startsWith(hostDir + path.sep)
}

/** 从这些文件出发,沿相对 import 走遍 kernel/src 内可达的文件(含起点)。 */
function closure(starts: string[]): string[] {
  const seen = new Set<string>()
  const stack = [...starts]
  while (stack.length) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of specifiers(file)) {
      if (!spec.startsWith(".")) continue
      const target = resolveTs(path.resolve(path.dirname(file), spec))
      if (target && target.startsWith(kernelSrc + path.sep)) stack.push(target)
    }
  }
  return [...seen]
}

const rel = (file: string) => path.relative(repoRoot, file).split(path.sep).join("/")

function violations(files: string[], bad: (spec: string, file: string) => boolean): string[] {
  const out: string[] = []
  for (const file of files) for (const spec of specifiers(file)) if (bad(spec, file)) out.push(`${rel(file)} -> ${spec}`)
  return out
}

describe("四个盒子的边界", () => {
  it("菜单里没有 Node:kernel/src 根目录不 import node:*、Node 专用依赖、electron、./host、发动机", () => {
    const menu = walk(kernelSrc).filter((f) => !f.startsWith(hostDir + path.sep) && !f.endsWith(".test.ts"))
    expect(menu.length).toBeGreaterThan(5)
    const bad = violations(closure(menu), (spec, file) =>
      isNodeish(spec) || reachesHost(spec, file) || spec.startsWith("@earendil-works/"),
    )
    expect(bad).toEqual([])
  })

  it("工具间不反调会话间:host/domain 与 host/tools 往外只拿 models.ts、datasheet-server.ts", () => {
    const rooms = [path.join(hostDir, "domain"), toolsDir]
    const files = rooms.flatMap((d) => walk(d))
    expect(files.length).toBeGreaterThan(10)
    const allowed = new Set([path.join(hostDir, "models.ts"), path.join(hostDir, "datasheet-server.ts")])
    const bad = violations(files, (spec, file) => {
      if (spec.startsWith("@yoma-desktop/")) return true
      if (!spec.startsWith(".")) return false
      const target = path.resolve(path.dirname(file), spec)
      const insideRoom = rooms.some((r) => target.startsWith(r + path.sep))
      return !insideRoom && !allowed.has(target)
    })
    expect(bad).toEqual([])
  })

  it("餐厅只走门:界面包引用 kernel 只许 `.` 或 `./tools/*/contract`,不许相对路径钻进 kernel/src", () => {
    const dirs = [
      "packages/app/src",
      "packages/session-ui/src",
      "packages/ui/src",
      "packages/util/src",
      "packages/desktop/src/renderer",
      "packages/desktop/src/preload",
    ].map((d) => path.join(repoRoot, d))
    for (const d of dirs) expect(existsSync(d), d).toBe(true)
    const files = dirs.flatMap((d) => walk(d))
    expect(files.length).toBeGreaterThan(50)
    const door = /^@yoma-desktop\/kernel(\/tools\/contracts|\/tools\/[^/]+\/contract)?$/
    const bad = violations(files, (spec, file) =>
      (spec.startsWith("@yoma-desktop/kernel") && !door.test(spec)) ||
      spec.startsWith("@yoma-desktop/bench") ||
      reachesKernelSrc(spec, file),
    )
    expect(bad).toEqual([])
  })

  it("壳的 main 进程不拖发动机:只有 kernel-entry.ts 走 `./host` 大门", () => {
    const mainDir = path.join(repoRoot, "packages/desktop/src/main")
    const files = walk(mainDir)
    expect(files.length).toBeGreaterThan(10)
    const entry = path.join(mainDir, "kernel-entry.ts")
    const bad = violations(
      files.filter((f) => f !== entry),
      (spec, file) => spec === "@yoma-desktop/kernel/host" || reachesKernelSrc(spec, file),
    )
    expect(bad).toEqual([])
  })

  it("契约文件只许 typebox 与工具间内部的相对路径;每个工具目录都得有 contract.ts", () => {
    if (!existsSync(toolsDir)) {
      expect(walk(toolsDir)).toEqual([])
      return
    }
    // 白名单而不是黑名单:黑名单挡不住 `@yoma-desktop/kernel/host` 或 ../../types.ts 这种绕道回自家门口。
    const toolDirs = readdirSync(toolsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    expect(toolDirs.length).toBeGreaterThan(0)
    for (const name of toolDirs) expect(existsSync(path.join(toolsDir, name, "contract.ts")), name).toBe(true)
    const roots = [
      ...toolDirs.map((name) => path.join(toolsDir, name, "contract.ts")),
      path.join(toolsDir, "contracts.ts"),
      path.join(toolsDir, "contract-types.ts"),
    ].filter((f) => existsSync(f))
    const bad = violations(closure(roots), (spec, file) => {
      if (spec === "typebox") return false
      if (!spec.startsWith(".")) return true
      const target = path.resolve(path.dirname(file), spec)
      return !target.startsWith(toolsDir + path.sep) || /[\\/]session\.ts$/.test(target)
    })
    expect(bad).toEqual([])
  })
})
