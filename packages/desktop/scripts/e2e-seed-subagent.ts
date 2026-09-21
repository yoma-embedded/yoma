/**
 * 首屏闸门的子 agent 种子:在 Electron 起来**之前**,用 faux 模型 + 真内核宿主在一个暂存会话根里跑一段真会话 ——
 * 主会话派一个前台 Explore(结果回到那次工具调用)和一个后台 general-purpose(完成通知回到主会话,主会话被叫醒
 * 再答一句)。主会话的 JSONL 里有 agent 工具调用、结果与通知,子会话的 JSONL 带 parentSessionId 与 yoma/subagent
 * 元数据 —— 全是内核自己写的,不手拼上游的文件格式。
 *
 * 为什么不直接种进 app 的会话目录:那个目录(userData/sessions)要等 Electron 起来才知道在哪
 * (TEST_ONBOARDING 的 userData 带随机 uuid);而两个进程同时往同一个会话根里建会话,会撞上游仓库
 * create / list 的 `.jsonl.tmp` 竞态(ENOENT,设计稿 §12 P2 结果第 1 条)。所以先在暂存根里种好,
 * 闸门再用 `moveSeededSessions` 按目录 / 按文件 rename 进去 —— rename 是原子的,app 那边的 list
 * 要么看不见,要么看见完整的文件。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type FauxResponseFactory,
  type Model,
} from "@earendil-works/pi-ai"
import type { KernelEvent, Session, SessionStatus } from "@yoma-desktop/kernel"
import { createKernelHost } from "@yoma-desktop/kernel/host"

export const SUBAGENT_PARENT_TITLE = "子 agent 闸门会话"
/** 前台那个(Explore):任务描述 = 子会话标题;侧栏里**不该**出现它。 */
export const SUBAGENT_DESCRIPTION = "查链接脚本"
export const SUBAGENT_ANSWER = "链接脚本在 STM32F405RGTX_FLASH.ld(工程根目录)"
/** 后台那个(general-purpose):完成后通知回到主会话,画成一行通知。 */
export const BACKGROUND_DESCRIPTION = "后台查手册"
export const BACKGROUND_ANSWER = "SPI1 时钟上限 42 MHz(RM0090 28.3 节)"
/**
 * 前台那个在回答之前先「找东西」:列一次目录、读一个在的文件、读一个不在的文件(工具报错)。三次连着的只读调用在
 * 子会话页上并成一行(session-ui 的 `groupParts`),那一行只有这里跑真窗口。只用 ls / read —— grep / find 要 rg,
 * 这条闸门不该依赖引擎二进制装没装。
 */
export const EXPLORE_FILE = "startup_stm32f405xx.s"
export const EXPLORE_MISSING_FILE = "不存在的链接脚本.ld"
const PARENT_PROMPT = "派两个子 agent:一个查链接脚本,一个在后台查手册"
const CHILD_PROMPT = "找出这个工程的链接脚本在哪"
const BACKGROUND_PROMPT = "在手册里查 SPI1 的时钟上限"

const text = (value: string) => fauxAssistantMessage([fauxText(value)])

function firstUserText(context: Context): string {
  const first = context.messages.find((message) => message.role === "user")
  const content = first?.content
  if (typeof content === "string") return content
  return (content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
}

/**
 * 按"这次请求里第一条 user 消息"分发:主会话是用户那句,子会话是任务书。用完了还被请求就回一句显眼的话,
 * 让闸门在那句话上失败,而不是等到超时。
 */
function script() {
  // 主会话:先派前台的(等它交回),再派后台的(立刻交回),这一轮收尾;后台的完成后通知进收件箱,主会话被叫醒
  // 再答一句。通知要是恰好在这一轮里就被取走了,第四步用不上 —— 无妨,等的是"通知进了 transcript 且主会话空闲"。
  const routes = new Map<string, AssistantMessage[]>([
    [
      PARENT_PROMPT,
      [
        fauxAssistantMessage([
          // 前台那个要显式写 false:缺省是后台(用户 2026-09-20 定)。
          fauxToolCall("agent", {
            description: SUBAGENT_DESCRIPTION,
            prompt: CHILD_PROMPT,
            subagent_type: "Explore",
            run_in_background: false,
          }),
        ]),
        fauxAssistantMessage([
          fauxToolCall("agent", { description: BACKGROUND_DESCRIPTION, prompt: BACKGROUND_PROMPT }),
        ]),
        text(`查到了:${SUBAGENT_ANSWER};手册在后台查`),
        text(`后台也查到了:${BACKGROUND_ANSWER}`),
      ],
    ],
    [
      CHILD_PROMPT,
      [
        fauxAssistantMessage([
          fauxToolCall("ls", {}),
          fauxToolCall("read", { path: EXPLORE_FILE }),
          fauxToolCall("read", { path: EXPLORE_MISSING_FILE }),
        ]),
        text(SUBAGENT_ANSWER),
      ],
    ],
    [BACKGROUND_PROMPT, [text(BACKGROUND_ANSWER)]],
  ])
  let served = 0
  const step: FauxResponseFactory = (context) => {
    served += 1
    return routes.get(firstUserText(context))?.shift() ?? text("(闸门种子的脚本已用完)")
  }
  return { step, served: () => served }
}

/** 在 `stagingRoot` 里种好一个主会话与它的两个子会话。`scratch` 放宿主的其余状态(配置、项目表、任务日志),用完即弃。 */
export async function seedSubagentSession(input: { stagingRoot: string; workspace: string; scratch: string }) {
  const faux = fauxProvider({ provider: "paint-gate", models: [{ id: "plain" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const plan = script()
  faux.setResponses(Array.from({ length: 16 }, () => plan.step))
  const model = faux.getModel() as Model<string>

  const events: KernelEvent[] = []
  mkdirSync(input.scratch, { recursive: true })
  writeFileSync(join(input.workspace, EXPLORE_FILE), "Reset_Handler:\n  ldr sp, =_estack\n")
  const host = createKernelHost({
    sessionsRoot: input.stagingRoot,
    stateDir: join(input.scratch, "state"),
    // 隔离开发机真实的 ~/.yoma(技能、上下文文件、项目 agent 定义)。
    configDir: join(input.scratch, "config"),
    version: "paint-gate",
    resolveModels: async () => ({ models, model }),
    inspectStm32Availability: async () => ({ available: false, reason: "paint-gate" }),
    subagents: { outputRoot: join(input.scratch, "tasks"), homeDir: input.scratch },
    onEvents: (batch) => events.push(...batch),
  })
  try {
    const parent = (await host.handle("session.create", {
      directory: input.workspace,
      title: SUBAGENT_PARENT_TITLE,
    })) as Session
    await host.handle("session.prompt", { sessionID: parent.id, input: { text: PARENT_PROMPT } })
    // 种完 = 后台那个的完成通知已经投进主会话的 transcript(task part)、两个任务都结束、主会话空闲,
    // 并且安静了一小会儿(叫醒起的那一轮要等它跑完,状态在它开头才翻 busy)。
    const deadline = Date.now() + 30_000
    let quiet = -1
    for (;;) {
      const status = (await host.handle("session.status", { sessionID: parent.id })) as SessionStatus
      const tasks = await host.handle("task.list", { sessionID: parent.id })
      const noted = events.some(
        (event) =>
          event.type === "message.part.updated" && event.part.type === "task" && event.part.sessionID === parent.id,
      )
      const settled =
        noted && status.type === "idle" && tasks.length === 2 && tasks.every((task) => task.status === "completed")
      if (settled && quiet === events.length) break
      quiet = settled ? events.length : -1
      if (Date.now() > deadline) throw new Error(`子 agent 种子 30 秒没跑完(模型被请求了 ${plan.served()} 次)`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const children = events.flatMap((event) =>
      event.type === "session.created" && event.session.parentID === parent.id ? [event.session] : [],
    )
    const child = children.find((session) => session.title === SUBAGENT_DESCRIPTION)
    const background = children.find((session) => session.title === BACKGROUND_DESCRIPTION)
    if (!child || !background || children.length !== 2) {
      throw new Error(`子 agent 种子建出了 ${children.length} 个子会话(要前台、后台各 1 个)`)
    }
    const errors = events.flatMap((event) => (event.type === "kernel.error" ? [event.message] : []))
    if (errors.length) throw new Error(`子 agent 种子报了内核错误:${errors.join(" | ")}`)
    return { parentID: parent.id, childID: child.id, backgroundID: background.id }
  } finally {
    await host.dispose()
  }
}

/**
 * 把暂存根里的会话挪进 app 的会话根。目标里还没有这个工程的目录就整个目录 rename;已经有了就逐个文件 rename。
 * 两个根都在同一个临时目录下,rename 不跨盘。
 */
export function moveSeededSessions(stagingRoot: string, sessionsRoot: string) {
  mkdirSync(sessionsRoot, { recursive: true })
  for (const dir of readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const from = join(stagingRoot, dir.name)
    const to = join(sessionsRoot, dir.name)
    if (!existsSync(to)) {
      renameSync(from, to)
      continue
    }
    for (const file of readdirSync(from)) renameSync(join(from, file), join(to, file))
  }
}
