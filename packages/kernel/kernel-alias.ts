/**
 * 内核源码的解析位置 —— 全仓唯一的一份。
 *
 * ## 为什么还需要这个文件(合库之后)
 *
 * 内核(packages/{ai,agent,coding-agent})现在和桌面端在同一棵树上,裸说明符
 * `@yoma/agent` 已经能靠 bun workspace 解析。但**打包期仍然要显式别名**:
 * electron-vite 默认会把 node_modules 里的东西外部化,而内核必须被 **inline 进
 * `out/main/kernel.js`** —— 它只有 raw TypeScript(`exports` 指向 `src/*.ts`,
 * 内部大量 `./x.ts` 后缀说明符),外部化之后 Electron 的 strip-only 加载器直接报
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING,无 flag 可关。
 *
 * 而且别名指的是**真实路径**而不是 node_modules 里的软链,这一点是有意的:
 * 走软链时 TypeScript 会把同一个 `ProviderStreams` 当成两个类型(private 字段让
 * 它们名义上不兼容),typecheck 直接红。踩过。
 *
 * **位置的真源是 `tsconfig.yoma.json`**,不是这里。本文件从它的 paths 反推根目录,
 * 于是"改了映射却忘了改另一份"变成不可能。三份映射的一致性由
 * `src/kernel-alias.test.ts` 钉住。
 *
 * 2026-08 合库之前这里还有一堆东西:KERNEL_DIR 环境变量、兄弟目录猜测、
 * `bun use-yoma` 切检出。那些全部是为"内核在另一个仓库"服务的,一并删掉了 ——
 * 现在内核和它的消费者在同一次提交里,不存在"指错检出"这回事。
 */
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

/** 认领标志:内核一定有这个文件。用它把"路径算错"从静默变成响亮。 */
const MARKER = "packages/agent/src/index.ts"
const SHARED_TSCONFIG = "tsconfig.yoma.json"

/** 从 tsconfig.yoma.json 的 `@yoma/agent` 条目反推仓库根目录。 */
function fromSharedTsconfig(start: string): string | undefined {
  let dir = start
  for (let depth = 0; depth < 8; depth += 1) {
    const file = path.join(dir, SHARED_TSCONFIG)
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")
      const entry = (JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, string[]> } }).compilerOptions
        ?.paths?.["@yoma/agent"]?.[0]
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

function resolveKernelDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates: string[] = []
  // 本文件可能被 vite 的 config 加载器内联进别的位置,所以从两个起点各往上找一遍。
  for (const start of [here, process.cwd()]) {
    const found = fromSharedTsconfig(start)
    if (found) candidates.push(found)
  }
  // tsconfig 找不到时退回:从本文件往上走,认 MARKER。
  let dir = here
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  for (const dir of candidates) if (existsSync(path.join(dir, MARKER))) return dir
  throw new Error(
    `找不到内核源码(应在本仓 ${MARKER})。试过:\n${candidates.map((c) => `  ${c}`).join("\n")}`,
  )
}

export const KERNEL_DIR = resolveKernelDir()

const agent = path.join(KERNEL_DIR, "packages/agent/src")
const codingAgent = path.join(KERNEL_DIR, "packages/coding-agent/src")
const ai = path.join(KERNEL_DIR, "packages/ai/dist")

/**
 * 打包器用的精确别名表(键是完整说明符,不做前缀匹配)。
 *
 * 深引用的三条(`/system-prompt`、`/models`、`/resources`)故意绕过 yoma 的 exports map ——
 * `buildSystemPrompt`、`resolveModel`、`discoverSkills` 都不在里面,但系统提示词编码了
 * 嵌入式工具的使用指导、资源发现编码了"技能与 AGENTS.md 从哪些目录找"这条产品决定,
 * 重写等于产品行为分叉。走别名既拿到真实现,又保住 typecheck 可见性。
 */
export const KERNEL_ALIASES: Record<string, string> = {
  "@yoma/agent": path.join(agent, "index.ts"),
  "@yoma/agent/node": path.join(agent, "node.ts"),
  "@yoma/coding-agent": path.join(codingAgent, "index.ts"),
  "@yoma/coding-agent/system-prompt": path.join(codingAgent, "core/system-prompt.ts"),
  "@yoma/coding-agent/models": path.join(codingAgent, "acp/models.ts"),
  "@yoma/coding-agent/resources": path.join(codingAgent, "core/resources.ts"),
  "@earendil-works/pi-ai": path.join(ai, "index.js"),
  "@earendil-works/pi-ai/providers/anthropic": path.join(ai, "providers/anthropic.js"),
  "@earendil-works/pi-ai/providers/openai": path.join(ai, "providers/openai.js"),
  "@earendil-works/pi-ai/providers/faux": path.join(ai, "providers/faux.js"),
}

/** vite/rollup 的 `resolve.alias` 形态。 */
export const KERNEL_VITE_ALIAS = Object.entries(KERNEL_ALIASES).map(([find, replacement]) => ({
  find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  replacement,
}))
