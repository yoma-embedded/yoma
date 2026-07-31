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
 * 覆盖位置用环境变量 MY_PI_DIR;默认是仓库的兄弟目录 ../my-pi。
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

/** 认领标志:my-pi 一定有这个文件。用它把"路径算错"从静默变成响亮。 */
const MARKER = "packages/agent/src/index.ts"

function resolveMyPiDir(): string {
  const candidates: string[] = []
  if (process.env.MY_PI_DIR) candidates.push(path.resolve(process.env.MY_PI_DIR))
  // 正常路径:<repo>/packages/kernel/mypi.ts → 上两级是 <repo>,兄弟目录 ../my-pi。
  const here = path.dirname(fileURLToPath(import.meta.url))
  candidates.push(path.resolve(here, "..", "..", "..", "my-pi"))
  // 本文件可能被 vite 的 config 加载器内联进别的位置,所以再从 cwd 兜一层。
  candidates.push(path.resolve(process.cwd(), "..", "my-pi"))
  candidates.push(path.resolve(process.cwd(), "..", "..", "my-pi"))
  candidates.push(path.resolve(process.cwd(), "..", "..", "..", "my-pi"))

  for (const dir of candidates) if (existsSync(path.join(dir, MARKER))) return dir
  throw new Error(
    `找不到 my-pi 内核。试过:\n${candidates.map((c) => `  ${c}`).join("\n")}\n` +
      `把 my-pi 检出成本仓库的兄弟目录,或设置 MY_PI_DIR 指向它。`,
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
