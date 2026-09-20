/**
 * agent 工具给模型看的完整描述(docs/子agent-设计方案-v0.4-20260918.md §5.1)。
 *
 * 结构逐段照 CC 2.1.88 `tools/AgentTool/prompt.ts` 的非 fork 版:开头 → agent 列表 → subagent_type 缺省 →
 * 何时不用 → Usage notes → Writing the prompt → 例子。改动只有三类:工具名(Read / Glob / Grep → read / find / grep,
 * SendMessage → send_message)、例子换成嵌入式场景、以及 yoma 自己的两条(硬件工具不给子 agent、后台子 agent 问不了人)。
 * "Don't peek / Don't race" 在 CC 里写在 fork 段,道理对后台 agent 一样成立,这里挪给后台用。
 * 宿主不能后台时(bench / 信箱),后台相关的段落与例子整段不出(CC 在 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS 下同样摘掉)。
 *
 * **与 CC 的一处刻意不同**(用户 2026-09-20 定):CC 缺省前台、后台要显式要;这里缺省后台,只有"拿不到结果就一步都
 * 走不下去"才显式 `run_in_background: false`。所以这几段话的方向是反的 —— 桌面端有人看着屏幕,主 agent 卡在一次
 * 子 agent 调用里的那几分钟,用户只能看着一个转圈的"思考中"。
 */

import type { AgentProfile } from "../../domain/agents/profile.ts"
import { describeAgentTools, HARDWARE_TOOL_NAMES } from "../../domain/agents/select.ts"

export type AgentListing = Pick<AgentProfile, "name" | "description" | "tools" | "disallowedTools">

/** agent 列表的一行,照 CC 的 formatAgentLine:`- type: whenToUse (Tools: ...)`。 */
export function formatAgentLine(profile: AgentListing): string {
  return `- ${profile.name}: ${profile.description} (Tools: ${describeAgentTools(profile)})`
}

export function agentToolDescription(profiles: readonly AgentListing[], options: { background: boolean }): string {
  const background = options.background
  const hardware = HARDWARE_TOOL_NAMES.join(", ")

  const usageNotes = [
    "- Always include a short description (3-5 words) summarizing what the agent will do",
    "- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses",
    "- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.",
    ...(background
      ? [
          "- **Agents run in the background by default.** The call returns immediately with an agentId; you are automatically notified when the agent completes — do NOT sleep, poll, or proactively check on its progress. Keep working or answer the user instead.",
          "- Right after launching one, tell the user in one short line what you delegated and that you will report back when it lands. They see a live list of running agents, but not why you launched them.",
          "- Set `run_in_background: false` only when you cannot take a single further step without the result — that blocks your turn until the agent finishes, and the user sees nothing but a spinner meanwhile. Prefer launching it in the background and doing the parts you can do now.",
        ]
      : []),
    "- To continue a previously spawned agent, use send_message with the agent's ID as the `to` field. The agent resumes with its full context preserved. Each agent invocation starts fresh — provide a complete task description.",
    "- The agent's outputs should generally be trusted",
    "- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, datasheet lookups, etc.), since it is not aware of the user's intent",
    "- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.",
    '- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple agent tool use content blocks. For example, if you need to launch an Explore agent for the clock tree and another for the UART setup in parallel, send a single message with both tool calls.',
    `- Sub-agents cannot use hardware tools (${hardware}); keep board operations in your own turns.`,
    ...(background
      ? [
          "- A background agent cannot ask the user to confirm a probe command or an install; it reports back instead, and you ask.",
        ]
      : []),
  ]

  const backgroundSection = background
    ? `

**Don't peek.** A background agent's result includes an \`output_file\` path — do not read or tail it unless the user explicitly asks for a progress check. You get a completion notification; trust it. Reading the log mid-flight pulls the agent's tool noise into your context, which defeats the point of delegating.

**Don't race.** After launching a background agent, you know nothing about what it found. Never fabricate or predict its results in any format — not as prose, summary, or structured output. The notification arrives as a user-role <task-notification> message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, tell them the agent is still running — give status, not a guess.`
    : ""

  const backgroundExample = background
    ? `

<example>
user: "Wire up the ADC DMA, and tell me whether the STM32G071 ADC can sample at 2.5 MSPS."
assistant: I'll ask the datasheet agent about the ADC limit while I start on the DMA wiring — I'll tell you what it says when it comes back.
agent({ description: "ADC max sample rate", subagent_type: "datasheet", prompt: "For the STM32G071 (reference manual RM0444, datasheet DS12232): what is the maximum ADC conversion rate at 12-bit resolution, and under which ADC clock and sampling-time conditions? Cite the page or section and quote the table row." })
<commentary>
No run_in_background needed — it is the default. The DMA work does not depend on the answer, so the assistant keeps going and the result arrives later as a notification, in a separate turn.
</commentary>
</example>

<example>
user: "Which linker script is this build using? Don't change anything yet."
assistant: agent({ description: "Find linker script", subagent_type: "Explore", run_in_background: false, prompt: "Find which linker script this CMake/Makefile build passes to the linker (-T flag), report its path and the FLASH/RAM region sizes it declares, with file paths and line numbers." })
<commentary>
The user asked one question and nothing else can proceed without the answer, so this one blocks: run_in_background: false.
</commentary>
</example>`
    : ""

  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${profiles.map(formatAgentLine).join("\n")}

When using the agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.

When NOT to use the agent tool:
- If you want to read a specific file path, use the read tool or the find tool instead of the agent tool, to find the match more quickly
- If you are searching for a specific symbol definition like "void SystemClock_Config", use the grep tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the read tool instead of the agent tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

Usage notes:
${usageNotes.join("\n")}${backgroundSection}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

Example usage:

<example>
user: "The UART prints garbage since we moved to the 168 MHz clock. Find out why."
assistant: I'll look at the clock tree and the UART setup in parallel.
agent({ description: "Trace clock tree", subagent_type: "Explore", prompt: "In this STM32F4 project, find where the system clock is configured (SystemClock_Config and any PLL setup). Report the clock source, the PLL M/N/P/Q values and the resulting SYSCLK, HCLK, PCLK1 and PCLK2, with file paths and line numbers. Medium thoroughness; report in under 200 words." })
agent({ description: "Find UART baud setup", subagent_type: "Explore", prompt: "Find how USART2 is initialized: the configured baud rate, which peripheral clock it assumes, and any hard-coded clock constants (for example a fixed 16 MHz or an overridden HAL_RCC_GetPCLK1Freq). File paths and line numbers; under 200 words." })
<commentary>
The two lookups are independent, so both calls go out in one message and run in parallel.
</commentary>
</example>${backgroundExample}`
}
