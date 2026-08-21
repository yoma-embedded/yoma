/**
 * selftest 的两份剧本:参考解与已知坏解。
 *
 * 假模型只换掉"模型"这一个零件 —— 真 harness、真工具(netlist 会真去解析那份夹具)、
 * 真会话落盘。所以 selftest 验的是**一整条**:夹具在不在、工具跑不跑得通、答案格式
 * 抽不抽得出来、grader 配没配对。
 *
 * ## 为什么反向那一刀不能省
 *
 * 一个永远亮绿的 grader 在 `details-check.ts` 上踩过一次(`const _: Check = true as never`
 * —— `never` 可赋给任何类型,那道闸门从来没响过)。只跑 good 的 selftest 是同一个形状的
 * 错误:它证明不了 grader 会红。所以 bad 是必须的,而且要**从两个方向**同时错:
 * 不调工具(打 grounded / tool-called)+ 错答案(打 answer)。
 *
 * ## 默认剧本为什么钉死 netlist
 *
 * 合成 good 需要知道"该调哪个工具、参数叫什么" —— 这是猜不出来的。v1 的题面是网表族,
 * 于是默认就是 `netlist { netlistPath: setup.files[0].to }`。别的族(以及答案只在
 * `part` 模式输出里才看得见的题)在 task.json 的 `faux` 字段自带剧本,那条路优先。
 */

import type { FauxScript } from "@yoma-desktop/bench"

import { DEFAULT_ANSWER_FIELD } from "./graders/index.ts"
import type { Task } from "./task.ts"

/** 合成 good 时默认调的工具与参数名。 */
const DEFAULT_TOOL = "netlist"
const DEFAULT_TOOL_PATH_ARG = "netlistPath"

export function answerFence(value: unknown, field = DEFAULT_ANSWER_FIELD): string {
  return `\`\`\`json\n${JSON.stringify({ [field]: value }, null, 2)}\n\`\`\``
}

/** 题里第一个 answer grader 用的字段名(它决定围栏里该写哪个 key)。 */
function answerFieldOf(task: Task): string {
  for (const spec of task.graders) {
    if (spec.type === "answer") return spec.field ?? DEFAULT_ANSWER_FIELD
  }
  return DEFAULT_ANSWER_FIELD
}

/**
 * 一个保证 ≠ 参考答案的错答案。
 *
 * 字符串加后缀、数组清空、数值 +1 —— 都要"看起来像个答案"但一定判错,
 * 否则坏解会因为格式问题而不是内容问题被判错,反向那一刀就打偏了。
 */
export function wrongAnswer(reference: unknown): unknown {
  if (Array.isArray(reference)) return reference.length ? [] : ["__wrong__"]
  if (typeof reference === "number") return reference + 1
  if (typeof reference === "boolean") return !reference
  if (typeof reference === "string") return `${reference}-wrong`
  if (reference && typeof reference === "object") return {}
  return "__wrong__"
}

export interface SynthesizedFaux {
  good: FauxScript
  bad: FauxScript
}

export function synthesizeFaux(task: Task): SynthesizedFaux {
  const field = answerFieldOf(task)
  const fixture = task.setup.files[0]

  const good: FauxScript = task.faux?.good ?? [
    // 没有夹具就没有可调的工具:硬塞一次 netlist 只会拿到一条工具报错,
    // 而 grounded 恰恰只认 completed —— 那样合成出来的"参考解"注定不过,
    // selftest 会报一道其实没问题的题。
    ...(fixture ? [[{ tool: DEFAULT_TOOL, input: { [DEFAULT_TOOL_PATH_ARG]: fixture.to } }]] : []),
    [{ text: answerFence(task.reference.answer, field) }],
  ]

  const bad: FauxScript = task.faux?.bad ?? [[{ text: answerFence(wrongAnswer(task.reference.answer), field) }]]

  return { good, bad }
}
