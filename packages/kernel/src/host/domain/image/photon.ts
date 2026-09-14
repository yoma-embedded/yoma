/**
 * Photon(Rust/WASM 的图像库)的加载口。
 *
 * 【为什么是 createRequire + 绝对路径,而不是 import】
 * photon-node 的入口是 CJS,文件末尾**在加载那一刻**就
 * `readFileSync(__dirname + "/photon_rs_bg.wasm")` 把 1.8 MB 的 wasm 读进来实例化。一旦让打包器看见
 * 这个包,三件事会一起出问题(2026-09-14 实测):
 *
 * 1. `out/main/mailbox-*.mjs` 与 bench 的评测入口是**带顶层 await 的 ESM**;把 CJS 的 photon inline 进去,
 *    产物里同时出现 `__dirname` 与顶层 await,node 判不出模块类型,加载那一刻就
 *    `ERR_AMBIGUOUS_MODULE_SYNTAX` —— 整个信箱守护起不来,而症状与图片毫无关系。
 * 2. 即便侥幸能加载,`__dirname` 被重写成产物目录,wasm 就找不着了。
 * 3. 1.8 MB 的 wasm 也没法跟着 JS 产物走。
 *
 * 所以这里**一个 import 说明符都不给打包器**:入口路径在运行期算出来,用 `createRequire` 按绝对路径
 * require。实测三种运行环境(tsx/vitest、带顶层 await 的 ESM 包、CJS 包)产物里 photon 的痕迹都是 0,
 * 而 wasm 由 photon 自己的 `__dirname` 找到 —— 它就躺在包目录里,原样可用,一行补丁都不用打。
 *
 * 【找不到就降级,不抛】一台没有 photon 的机器(打包漏了、评测容器里没有 node_modules)照样该能跑,
 * 只是图片不缩放。调用方按 undefined 决定说什么(见 process.ts)。
 */

import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

export type Photon = typeof import("@silvia-odwyer/photon-node")

const PACKAGE = "@silvia-odwyer/photon-node"
const ENTRY_FILE = "photon_rs.js"

/**
 * photon 的 CJS 入口的绝对路径;找不到返回 undefined。
 *
 * 三档,按优先级:
 * 1. `YOMA_PHOTON_DIR` —— 桌面端的正路:打包后 photon 走 extraResources 落在 `resources/photon`,
 *    由 main 解析好塞进 env,内核 utilityProcess 与信箱守护都从 `process.env` 继承(信箱那条是纯 node,
 *    没有 process.resourcesPath 可查)。**指了就只认它**:说在那儿却不在,悄悄换用别处的副本只会让
 *    "打包漏了"这件事到用户机器上才发作。
 * 2. `process.resourcesPath/photon` —— 在 Electron 进程里的兜底,不必依赖 main 设过环境变量。
 * 3. 按 node 的解析规则找 node_modules,先从 **本模块自己**、再从 **cwd** 往上走。两个锚点都要:
 *    源码直接跑时本模块躺在 packages/kernel/src 下,一路往上必到仓库根的 node_modules —— 而 cwd 未必,
 *    bench 每一轮子进程的 cwd 是**被评测的工程目录**(那儿当然没有我们的依赖),只认 cwd 的话评测里
 *    永远没有图像后端,于是评测量的 agent 和发出去的 agent 不是同一个。打包之后本模块的锚点会落空,
 *    那时靠的是上面两档。
 */
export function resolvePhotonEntry(): string | undefined {
  const explicit = process.env.YOMA_PHOTON_DIR?.trim()
  if (explicit) {
    const entry = path.join(explicit, ENTRY_FILE)
    return existsSync(entry) ? entry : undefined
  }
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (resources) {
    const entry = path.join(resources, "photon", ENTRY_FILE)
    if (existsSync(entry)) return entry
  }
  for (const anchor of moduleAnchors()) {
    try {
      return createRequire(anchor).resolve(PACKAGE)
    } catch {
      // 这个锚点往上没有,换下一个。
    }
  }
  return undefined
}

/** 解析 node_modules 的锚点:本模块自己(打包后可能没有)、然后是 cwd。 */
function moduleAnchors(): string[] {
  const out: string[] = []
  // 打包产物里 import.meta 可能被替换成空对象,所以取到了才用。
  const here = typeof import.meta.url === "string" ? import.meta.url : undefined
  if (here) out.push(here)
  out.push(path.join(process.cwd(), "anchor.js"))
  return out
}

let cached: Photon | null | undefined

/** 进程内加载 photon(同步:CJS + 内嵌 wasm,require 回来就能用)。加载不起来返回 undefined 并记住。 */
export function loadPhoton(): Photon | undefined {
  if (cached !== undefined) return cached ?? undefined
  const entry = resolvePhotonEntry()
  if (!entry) {
    cached = null
    return undefined
  }
  try {
    cached = createRequire(entry)(entry) as Photon
    return cached
  } catch {
    cached = null
    return undefined
  }
}

/** 只给测试:下一次调用重新解析(测试会改 YOMA_PHOTON_DIR)。 */
export function resetPhotonCache(): void {
  cached = undefined
}
