/**
 * my-pi 的路径映射存在四份,这是被工具链逼出来的,不是懒:
 *
 *   1. `packages/kernel/mypi.ts` 的 MY_PI_ALIASES —— 打包期(electron-vite / esbuild)用;
 *   2. `tsconfig.mypi.json` 的 paths —— typecheck 期(tsgo)用,被 desktop/app 继承;
 *   3. `packages/kernel/tsconfig.json` 里 **内联** 的同一份 paths —— `bun test` 用。
 *      bun 不跟随数组形式的 extends,所以这份必须就地展开,否则单测直接
 *      "Cannot find module '@yoma/my-pi'"。
 *   4. `packages/bench/tsconfig.json` 的内联副本 —— 同理:bench 直接跑源码(不打包),
 *      `bun test` 和 CLI 都靠它解析 my-pi。
 *
 * 三份不一致的后果是分裂的:构建能过但类型是错的,或者类型对但运行时找不到模块 ——
 * 都不会在改动的当下报错。所以用这个测试把它们钉死。
 *
 * 三份现在都穿过 `<repo>/.mypi` 软链,所以"换一个 my-pi 检出"是原子的:动软链,三份
 * 一起走。只设 MY_PI_DIR 环境变量是半切(打包跟着走,typecheck 和本测试留在原地),
 * 这个测试的最后一条就是专门用来在半切时炸响的。
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { MY_PI_ALIASES, MY_PI_DIR } from "../mypi.ts"

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

describe("my-pi 别名映射", () => {
  const shared = resolvePaths(path.join(repoRoot, "tsconfig.mypi.json"))
  const inlined = resolvePaths(path.join(kernelDir, "tsconfig.json"))
  const benchInlined = resolvePaths(path.join(repoRoot, "packages", "bench", "tsconfig.json"))

  test("MY_PI_DIR 指向一个真的 my-pi 检出", () => {
    // 认标志文件,不认目录名 —— 换成 worktree 之后目录可能叫任何名字。
    expect(existsSync(path.join(MY_PI_DIR, "packages/agent/src/index.ts"))).toBe(true)
  })

  test("tsconfig 里的路径在磁盘上真的存在(.mypi 悬空会在这里炸)", () => {
    // 别的断言只比较字符串,三份可以一致地全指向一个不存在的地方 —— 软链断了、
    // 或者指到一个不是 my-pi 的目录,typecheck 会安静地把模块解析成 any。
    for (const [key, target] of Object.entries(shared)) {
      if (key.includes("*")) continue
      expect([key, existsSync(target)]).toEqual([key, true])
    }
  })

  test("tsconfig.mypi.json 与 kernel/tsconfig.json 的内联副本一致", () => {
    expect(Object.keys(inlined).sort()).toEqual(Object.keys(shared).sort())
    for (const key of Object.keys(shared)) {
      expect(inlined[key]).toBe(shared[key]!)
    }
  })

  test("bench 的内联副本与共享 tsconfig 一致", () => {
    // bench 是第二个直接跑 my-pi 源码的包(第一个是 kernel 的 bun test)。
    // 漏钉这一份的后果与 kernel 那份相同:bench 跑的和 typecheck 验的不是同一份代码。
    expect(Object.keys(benchInlined).sort()).toEqual(Object.keys(shared).sort())
    for (const key of Object.keys(shared)) {
      expect(benchInlined[key]).toBe(shared[key]!)
    }
  })

  test("打包别名表与 tsconfig 覆盖同一组说明符", () => {
    // 通配的 providers/* 在 MY_PI_ALIASES 里是逐个列举的,所以只比较非通配项。
    const tsKeys = Object.keys(shared)
      .filter((key) => !key.includes("*"))
      .sort()
    const aliasKeys = Object.keys(MY_PI_ALIASES)
      .filter((key) => !key.startsWith("@earendil-works/pi-ai/providers/"))
      .sort()
    expect(aliasKeys).toEqual(tsKeys)
  })

  test("打包别名与 tsconfig 指向同一个文件", () => {
    for (const [key, target] of Object.entries(shared)) {
      if (key.includes("*")) continue
      expect(normalize(MY_PI_ALIASES[key]!)).toBe(normalize(target))
    }
  })
})
