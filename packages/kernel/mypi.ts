/**
 * my-pi 内核的解析位置 —— 全仓唯一的一份。
 *
 * my-pi 只发 raw TypeScript(`exports` 直接指向 `src/*.ts`,153 处 `./x.ts` 后缀说明符),
 * 而且它内部用 `workspace:*` 互相引用。所以它 **不能** 作为 npm 依赖装进来:
 *   - 声明成 file:/link: 依赖 → bun 解析不了它内部的 `workspace:*`,install 直接失败;
 *   - 真装进 node_modules → Node 的 strip-only 加载器对 node_modules 下的 .ts
 *     报 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING,无 flag 可关。
 *
 * 所以走 alias:构建期由 esbuild/rollup 把 my-pi 源码整个 inline 进 bundle
 * (参数属性和 .ts 说明符在这一步一起消失),typecheck 期由 tsconfig 的 paths 走同一组映射。
 * 结果是 my-pi 一个字节都不用改,而且它一旦挪文件,我们这边是编译期硬失败,不是运行时惊喜。
 *
 * **位置的真源是 `tsconfig.mypi.json`**,不是这里。本文件从它的 paths 反推根目录。
 *
 * 这个方向是刻意的。反过来(这里定义、tsconfig 手抄)在切换检出时会 **半切**:
 * 打包跟着环境变量走了,typecheck 和 bun test 还在验旧的那一份,两边都绿,说的却不是
 * 同一份代码。换检出用 `bun use-mypi <目录>` —— 它改 tsconfig,这里自动跟上。
 *
 * 顺带解释为什么不是一个 `.mypi` 软链(试过,退回来了):tsconfig 的 paths 走软链、
 * 而 my-pi 内部的相对 import 走真实路径,TypeScript 会把同一个 `ProviderStreams`
 * 当成两个不同的类型(private 字段让它们名义上不兼容),typecheck 直接红。
 */
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

/** 认领标志:my-pi 一定有这个文件。用它把"路径算错"从静默变成响亮。 */
const MARKER = "packages/agent/src/index.ts"
const SHARED_TSCONFIG = "tsconfig.mypi.json"

/** 从 tsconfig.mypi.json 的 `@yoma/my-pi` 条目反推 my-pi 根目录。 */
function fromSharedTsconfig(start: string): string | undefined {
  let dir = start
  for (let depth = 0; depth < 8; depth += 1) {
    const file = path.join(dir, SHARED_TSCONFIG)
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")
      const entry = (JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, string[]> } }).compilerOptions
        ?.paths?.["@yoma/my-pi"]?.[0]
      // 条目形如 <root>/packages/agent/src/index.ts,上溯四级就是 <root>。
      if (entry) return path.resolve(dir, entry, "..", "..", "..", "..")
      return undefined
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function resolveMyPiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates: string[] = []
  // 环境变量只影响打包期,tsconfig 跟不了 —— 留着做一次性实验,别当成切换手段。
  if (process.env.MY_PI_DIR) candidates.push(path.resolve(process.env.MY_PI_DIR))
  // 本文件可能被 vite 的 config 加载器内联进别的位置,所以从两个起点各往上找一遍。
  for (const start of [here, process.cwd()]) {
    const found = fromSharedTsconfig(start)
    if (found) candidates.push(found)
  }
  // tsconfig 都找不到时才退回猜:兄弟目录 ../my-pi。
  candidates.push(path.resolve(here, "..", "..", "..", "my-pi"))
  candidates.push(path.resolve(process.cwd(), "..", "my-pi"))
  candidates.push(path.resolve(process.cwd(), "..", "..", "my-pi"))

  for (const dir of candidates) if (existsSync(path.join(dir, MARKER))) return dir
  throw new Error(
    `找不到 my-pi 内核。试过:\n${candidates.map((c) => `  ${c}`).join("\n")}\n` +
      `把 my-pi 检出成本仓库的兄弟目录,或跑 \`bun use-mypi <目录>\`。`,
  )
}

export const MY_PI_DIR = resolveMyPiDir()

const agent = path.join(MY_PI_DIR, "packages/agent/src")
const codingAgent = path.join(MY_PI_DIR, "packages/coding-agent/src")
const ai = path.join(MY_PI_DIR, "packages/ai/dist")

/**
 * 打包器用的精确别名表(键是完整说明符,不做前缀匹配)。
 *
 * 深引用的两条(`/system-prompt`、`/models`)故意绕过 my-pi 的 exports map ——
 * `buildSystemPrompt` 和 `resolveModel` 不在里面,但系统提示词编码了嵌入式工具的
 * 使用指导,重写等于产品行为分叉。走别名既拿到真实现,又保住 typecheck 可见性。
 */
export const MY_PI_ALIASES: Record<string, string> = {
  "@yoma/my-pi": path.join(agent, "index.ts"),
  "@yoma/my-pi/node": path.join(agent, "node.ts"),
  "@yoma/my-pi-coding-agent": path.join(codingAgent, "index.ts"),
  "@yoma/my-pi-coding-agent/system-prompt": path.join(codingAgent, "core/system-prompt.ts"),
  "@yoma/my-pi-coding-agent/models": path.join(codingAgent, "acp/models.ts"),
  "@earendil-works/pi-ai": path.join(ai, "index.js"),
  "@earendil-works/pi-ai/providers/anthropic": path.join(ai, "providers/anthropic.js"),
  "@earendil-works/pi-ai/providers/openai": path.join(ai, "providers/openai.js"),
  "@earendil-works/pi-ai/providers/faux": path.join(ai, "providers/faux.js"),
}

/** vite/rollup 的 `resolve.alias` 形态。 */
export const MY_PI_VITE_ALIAS = Object.entries(MY_PI_ALIASES).map(([find, replacement]) => ({
  find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  replacement,
}))
