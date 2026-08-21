/**
 * yoma 的路径映射存在五份,这是被工具链逼出来的,不是懒:
 *
 *   1. `packages/kernel/kernel-alias.ts` 的 KERNEL_ALIASES —— 打包期(electron-vite / esbuild)用;
 *   2. `tsconfig.yoma.json` 的 paths —— typecheck 期(tsgo)用,被 desktop/app 继承;
 *   3. `packages/kernel/tsconfig.json` 里 **内联** 的同一份 paths —— `bun test` 用。
 *      bun 不跟随数组形式的 extends,所以这份必须就地展开,否则单测直接
 *      "Cannot find module '@yoma/agent'"。
 *   4. `packages/bench/tsconfig.json` 的内联副本 —— 同理:bench 直接跑源码(不打包),
 *      `bun test` 和 CLI 都靠它解析 yoma。
 *   5. `packages/evals/tsconfig.json` 的内联副本 —— 同理:evals 也直接跑源码
 *      (它 import bench 的 runner 起 turn-entry 子进程,那条路上全是 yoma 源码)。
 *
 * 五份不一致的后果是分裂的:构建能过但类型是错的,或者类型对但运行时找不到模块 ——
 * 都不会在改动的当下报错。所以用这个测试把它们钉死。
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { KERNEL_ALIASES, KERNEL_DIR } from "../kernel-alias.ts"

const kernelDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(kernelDir, "..", "..")

function readJsonc(file: string): { compilerOptions?: { paths?: Record<string, string[]> } } {
  // tsconfig 允许注释和尾逗号,JSON.parse 不允许。这里只需要粗暴地剥掉它们。
  const raw = readFileSync(file, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(raw)
}

/** 把 tsconfig 的 paths 解析成绝对路径,便于跨三份配置比较。 */
function resolvePaths(configFile: string): Record<string, string> {
  const config = readJsonc(configFile)
  const base = path.dirname(configFile)
  const out: Record<string, string> = {}
  for (const [key, values] of Object.entries(config.compilerOptions?.paths ?? {})) {
    const first = values[0]
    if (first) out[key] = path.resolve(base, first)
  }
  return out
}

/**
 * pi-ai 的路径必须指向 **运行时的 .js**,不能指向 .d.ts:bun 会照着 tsconfig paths
 * 真去加载那个文件,声明文件执行不了(实测 "Cannot find module './api/lazy.ts'")。
 * 指向 .js 之后 TypeScript 仍然能从同目录的 .d.ts 拿到类型,两边都满意。
 */
function normalize(file: string): string {
  return file
}

describe("yoma 别名映射", () => {
  const shared = resolvePaths(path.join(repoRoot, "tsconfig.yoma.json"))
  const inlined = resolvePaths(path.join(kernelDir, "tsconfig.json"))
  const benchInlined = resolvePaths(path.join(repoRoot, "packages", "bench", "tsconfig.json"))
  const evalsInlined = resolvePaths(path.join(repoRoot, "packages", "evals", "tsconfig.json"))

  test("KERNEL_DIR 指向本仓根", () => {
    // 认标志文件,不认目录名 —— 换成 worktree 之后目录可能叫任何名字。
    expect(existsSync(path.join(KERNEL_DIR, "packages/agent/src/index.ts"))).toBe(true)
  })

  test("tsconfig 里的路径在磁盘上真的存在", () => {
    // 别的断言只比较字符串,三份可以一致地全指向一个不存在的地方 —— 软链断了、
    // 或者指到一个不是 yoma 的目录,typecheck 会安静地把模块解析成 any。
    for (const [key, target] of Object.entries(shared)) {
      if (key.includes("*")) continue
      expect([key, existsSync(target)]).toEqual([key, true])
    }
  })

  test("tsconfig.yoma.json 与 kernel/tsconfig.json 的内联副本一致", () => {
    expect(Object.keys(inlined).sort()).toEqual(Object.keys(shared).sort())
    for (const key of Object.keys(shared)) {
      expect(inlined[key]).toBe(shared[key]!)
    }
  })

  test("bench 的内联副本与共享 tsconfig 一致", () => {
    // bench 是第二个直接跑 yoma 源码的包(第一个是 kernel 的 bun test)。
    // 漏钉这一份的后果与 kernel 那份相同:bench 跑的和 typecheck 验的不是同一份代码。
    expect(Object.keys(benchInlined).sort()).toEqual(Object.keys(shared).sort())
    for (const key of Object.keys(shared)) {
      expect(benchInlined[key]).toBe(shared[key]!)
    }
  })

  test("evals 的内联副本与共享 tsconfig 一致", () => {
    // 第三个直接跑 yoma 源码的包。它经 bench 的 runTurnInChildProcess 起 turn-entry
    // 子进程,子进程从 evals 的 cwd 出发解析 —— 漏钉这一份,评测跑的和 typecheck 验的
    // 就不是同一份代码,而分数看起来完全正常。
    expect(Object.keys(evalsInlined).sort()).toEqual(Object.keys(shared).sort())
    for (const key of Object.keys(shared)) {
      expect(evalsInlined[key]).toBe(shared[key]!)
    }
  })

  test("打包别名表与 tsconfig 覆盖同一组说明符", () => {
    // 通配的 providers/* 在 KERNEL_ALIASES 里是逐个列举的,所以只比较非通配项。
    const tsKeys = Object.keys(shared)
      .filter((key) => !key.includes("*"))
      .sort()
    const aliasKeys = Object.keys(KERNEL_ALIASES)
      .filter((key) => !key.startsWith("@earendil-works/pi-ai/providers/"))
      .sort()
    expect(aliasKeys).toEqual(tsKeys)
  })

  test("打包别名与 tsconfig 指向同一个文件", () => {
    for (const [key, target] of Object.entries(shared)) {
      if (key.includes("*")) continue
      expect(normalize(KERNEL_ALIASES[key]!)).toBe(normalize(target))
    }
  })
})
