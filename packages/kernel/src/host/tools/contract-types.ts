/**
 * 工具契约的形状:每个 `host/tools/<名字>/contract.ts` 都要 `satisfies` 它。
 *
 * 这份类型自己也得是浏览器可读的(只 import typebox 的类型),因为契约门 `@yoma-desktop/kernel/tools/<名字>/contract`
 * 与总表 `@yoma-desktop/kernel/tools/contracts` 是餐厅能走的门 —— 门后面不能有 Node。
 *
 * 两条给照抄者的规矩:
 * - details 只放能 JSON 往返的字段(string / number / boolean / null / 数组 / 普通对象):它跨进程后原样成为
 *   卡片的 metadata,Date / Buffer / Map 会静默变形。图片和二进制走工具结果的 content(image)与 attachments,
 *   不塞 details。
 * - confirm 与 summary 是纯函数:前者拿校验后的参数决定"跑之前要不要问用户"(toolchain 只在 install 时问、
 *   gdb 只在写内存时问,所以不是布尔);后者把参数拼成一行人能读的话,给卡片副标题和确认条用。
 */

import type { Static, TSchema } from "typebox"

export interface ToolContract<P extends TSchema = TSchema> {
  /** 模型看到的工具名,也是 TOOL_NAMES 里的那个字面量。 */
  name: string
  /** 界面上的短名(中文),确认条、卡片标题用它;模型看不到。 */
  label: string
  /** 模型看的说明(英文)。 */
  description: string
  parameters: P
  /**
   * 这一次调用跑之前要不要先问用户;没有这个字段的工具从不问。
   * 写成方法签名而不是箭头属性:方法参数是双变的,contracts.ts 的异构总表(每个契约的 Static<P>
   * 都不同)才能赋给 readonly ToolContract[];改成属性写法,总表那行立刻 TS2322,而报错指向的是
   * 某个具体契约,看不出根因。summary 同理。
   */
  confirm?(input: Static<P>): boolean
  /** 进系统提示词 "Tool-specific rules" 的守则;这一轮没装配这个工具时一句都不出。 */
  guidelines: readonly string[]
  /** 卡片副标题 / 确认条那一行。参数可能还没拼完整(流式),所以收 Partial。 */
  summary(input: Partial<Static<P>>): string
}
