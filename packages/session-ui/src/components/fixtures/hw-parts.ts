/**
 * 五个硬件工具卡片的夹具 —— **从演示会话的 JSONL 里原样拷出来的**
 * (`_ui-lab/demo/sessions/…jsonl` 的 20 条 toolResult;真内核 + 真工具跑出来的,
 * gdb 那一段是真 QEMU + 真 arm-none-eabi-gdb 跑到固件自己的 HardFault)。
 *
 * 只改了一样东西:把演示工程的绝对路径换成 `/work/f405-motor-ctrl`。
 *
 * **不要照着解析器编夹具** —— 那样的测试只能证明代码没变。形状变了要来这里换一份新的。
 */
import parts from "./hw-parts.json" with { type: "json" }

export interface HwFixture {
  tool: string
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output: string
}

export const HW_FIXTURES = parts as HwFixture[]

/** 按工具名 + details.action 取一条。取不到就抛 —— 夹具没了要红,不要静默跳过。 */
export function fixture(tool: string, action?: string): HwFixture {
  const hit = HW_FIXTURES.find(
    (item) => item.tool === tool && (action === undefined || item.metadata.action === action),
  )
  if (!hit) throw new Error(`夹具里没有 ${tool}${action ? ` ${action}` : ""}`)
  return hit
}
