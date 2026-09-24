/**
 * 会话自动起名:主会话收到第一句话、而它还没有名字时,另起一次模型调用给它起个短标题。
 *
 * 照主流 agent 的做法(2026-09-21 对着本机 opencode、Claude Code 源码核过;Codex / Cline / pi 不起名,只拿第一句话当名字):
 * - **只看第一条用户消息,一次**:与这一轮并行跑,不 await、不占 lane(opencode 的 ensureTitle、Claude Code 的 generateSessionTitle);
 * - **先占位再换**:收下这句话立刻拿它的第一句当临时名字,模型的标题到了再换上(Claude Code 桥接 claude.ai 那条路的 deriveTitle);
 *   模型没给出来就把占位定下来 —— 总比满屏都叫工程目录名强;
 * - **请求要小**:提示词照 opencode 的 title.txt(唯一明确要求"跟用户同一种语言"的一份,中文用户就靠这条),不带工具,
 *   思考开到模型允许的最低档;输出只认第一行有内容的、剥掉 `<think>` 与引号;
 * - **失败不出声**:不发 kernel.error —— 界面会把它当成"这个会话出错了"弹系统通知;
 * - **人说了算**:建会话时带了名字、或起名期间用户改了名,这次就作废(opencode 在这里有竞态,Claude Code 在 await 之后重查,
 *   我们照后者)。这一条由 session-manager 守。
 *
 * 用哪个模型:`YOMA_TITLE_MODEL=<provider>/<model>` 钉一个(比如便宜的 flash 档),`off` 整个关掉;不设就跟着这个会话当前的模型走。
 * 主流是挑同家的便宜小模型(Claude Code 固定 Haiku,opencode 按一张型号优先表挑),我们不抄那张表:目录四十家、型号按周变,
 * 手写的优先表会烂(模型目录那节的教训),而会话自己的模型一定配了 key、用户的账号一定用得了;一次起名几百个 token,钱不在这里。
 */

import {
  clampThinkingLevel,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type ThinkingLevel,
} from "@earendil-works/pi-ai"

/** 标题最长多少个字符(按码点,中文一个字算一个)。与 Claude Code 的 TITLE_MAX_LEN 同为 50;界面上还会按宽度再截。 */
export const TITLE_MAX_CHARS = 50

/** 喂给起名模型的第一句话最多这么长:起名只要大意,贴进来的一大段日志只会白花 token。目标多半写在开头,所以截头留下。 */
const SOURCE_MAX_CHARS = 2000

/** 起名这一次最多等这么久(Claude Code 是 15 秒;思考关不掉的大模型要慢些)。等不到就把占位定下来。 */
export const TITLE_TIMEOUT_MS = 30_000

/** opencode 的 title.txt,改了三处:中文的长度、嵌入式的专有名词、换了一半例子。 */
export const TITLE_SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters (≤20 characters when the title is in Chinese or Japanese)
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "flash tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, chip and board names, peripherals, registers, numbers, filenames, error codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey", "你好"):
  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, 打招呼, 闲聊, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"why is app.js failing" → app.js failure investigation
"@src/auth.ts can you add refresh token support" → Auth refresh token support
"look at @config.json" → Config review
"STM32F407 的 USART1 打印出来全是乱码,波特率 115200" → STM32F407 USART1 乱码排查
"烧录的时候 openocd 报 Error: init mode failed" → OpenOCD 烧录报 init mode failed
"@src/main.c 加一个 1ms 的定时器中断" → main.c 添加 1ms 定时器中断
"ESP32-S3 进了 deep sleep 就唤醒不了" → ESP32-S3 深度睡眠无法唤醒
"你好" → 打招呼
</examples>`

/**
 * 起名那一次请求:系统提示词 + 一条用户消息。第一句话原文包在标签里(Claude Code 的 `<description>` 同理),
 * 模型才不会把它当成冲着自己问的问题去回答。
 */
export function titleRequest(text: string): Context {
  const source = Array.from(text.trim())
  const body = source.length > SOURCE_MAX_CHARS ? `${source.slice(0, SOURCE_MAX_CHARS).join("")}…` : source.join("")
  return {
    systemPrompt: TITLE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Generate a title for this conversation:\n\n<user_message>\n${body}\n</user_message>` },
        ],
        timestamp: Date.now(),
      },
    ],
  }
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text
}

/** 标题收尾不要的标点(中英文句末与分隔符)。 */
const TRAILING_PUNCTUATION = /[\s。．.!！?？,，;；:：、]+$/u

/**
 * 模型原话 → 标题。会漏思考过程的模型把 `<think>…</think>` 写进正文(opencode 同样剥);有的先写一行 "Title:",
 * 或者给标题套引号、加粗、带句号 —— 都剥掉,取第一行剥完还有字的。一个字都不剩就是没起成。
 */
export function cleanTitle(raw: string): string | undefined {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "")
  for (const line of text.split(/\r?\n/)) {
    const title = line
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/^(?:title|标题|会话标题|对话标题)\s*[:：]\s*/i, "")
      .replace(/^[\s"'`*_“”‘’「」『』《》【】]+|[\s"'`*_“”‘’「」『』《》【】]+$/g, "")
      .replace(TRAILING_PUNCTUATION, "")
      .replace(/\s+/g, " ")
      .trim()
    if (title) return truncate(title, TITLE_MAX_CHARS)
  }
  return undefined
}

/**
 * 占位与退路:第一行有字的那一行里的第一句,压成一行、截短(Claude Code 的 deriveTitle)。英文的 `.!?` 后面要跟空白
 * 才算断句,免得把 `v1.2`、`0x68.` 这种劈开;中文句末标点直接断。只有图片没有字的消息给不出。
 */
export function fallbackTitle(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .find(Boolean)
  if (!line) return undefined
  const sentence = /^(.*?(?:[。！？]|[.!?](?=\s)))/u.exec(line)?.[1] ?? line
  return truncate(sentence.replace(TRAILING_PUNCTUATION, "") || line, TITLE_MAX_CHARS)
}

/** `YOMA_TITLE_MODEL=off`:整个不起名,连占位也不给。 */
export function autoTitleDisabled(setting = process.env.YOMA_TITLE_MODEL): boolean {
  return setting?.trim() === "off"
}

/**
 * 起名用哪个模型。`YOMA_TITLE_MODEL=<provider>/<model>` 且注册表里有(配了 key)就用它;写错了、没配 key 就不理它,
 * 照常跟着会话的模型 —— 起名是锦上添花,不值得为一个环境变量报错。
 */
export function pickTitleModel(
  models: Models,
  sessionModel: Model<string>,
  setting = process.env.YOMA_TITLE_MODEL,
): Model<string> {
  const spec = setting?.trim() ?? ""
  const slash = spec.indexOf("/")
  if (slash > 0) {
    const pinned = models.getModel(spec.slice(0, slash), spec.slice(slash + 1)) as Model<string> | undefined
    if (pinned) return pinned
  }
  return sessionModel
}

/** 模型允许的最低思考档:能关就关(不传),关不掉的(思考是强制的)给最低一档 —— 同 opencode 的 smallOptions。 */
function lowestReasoning(model: Model<string>): ThinkingLevel | undefined {
  const level = clampThinkingLevel(model, "off")
  return level === "off" ? undefined : level
}

/** 发一次起名请求。失败(报错、被中止、没给出能用的字)一律抛出,由调用方退回占位。 */
export async function generateTitle(options: {
  models: Models
  model: Model<string>
  text: string
  signal?: AbortSignal
}): Promise<string> {
  const reasoning = lowestReasoning(options.model)
  const reply: AssistantMessage = await options.models.completeSimple(options.model, titleRequest(options.text), {
    // 思考关得掉时顺手封个输出上限;关不掉的不封 —— 思考也记在输出里,封小了可能一个字的正文都到不了。
    ...(reasoning ? { reasoning } : { maxTokens: 256 }),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(reply.errorMessage ?? `title request ${reply.stopReason}`)
  }
  const title = cleanTitle(reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"))
  if (!title) throw new Error("title request returned no usable text")
  return title
}
