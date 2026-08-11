/**
 * 编译期漂移闸门。
 *
 * `../types.ts` 里的工具 details 是从 my-pi 结构化 **复制** 出来的,不是 import 的 ——
 * 因为那份视图模型必须保持浏览器安全,而且 packages/app 不该为了拿几个字段类型就把
 * 整个内核依赖图拉进 typecheck。
 *
 * 复制的代价是会漂移。这个文件就是代价的对冲:它跑在 host 半边(有 my-pi 的 paths),
 * 用类型断言要求"my-pi 的真类型必须能赋给我们的副本"。my-pi 改名、删字段、改字段类型,
 * 这里立刻编译失败;my-pi 新增字段是兼容的,不会误报。
 *
 * 工具名 **集合** 的钉法在 2026-08 之后换到了运行时:my-pi 的装配面精简把 ToolName
 * 导出和 grep 工具一并删了,编译期无从比对名集合。现在由 `tool-names.test.ts` 真装配
 * 一遍工具再对 TOOL_NAMES − RETIRED_TOOL_NAMES 逐个核对 —— my-pi 增删改名照样会响,
 * 只是响在 `bun test` 而不是 typecheck。grep 的 details 副本仍留在 types.ts
 * (旧会话重放要认得),但不再钉 my-pi。
 *
 * 本文件只有类型,没有运行时产物。加进 src/host/index.ts 的 import 只为了让它进编译单元。
 */

import type {
  BashToolDetails as PiBash,
  DatasheetToolDetails as PiDatasheet,
  EditToolDetails as PiEdit,
  FlashToolDetails as PiFlash,
  GdbToolDetails as PiGdb,
  LogToolDetails as PiLog,
  NetlistToolDetails as PiNetlist,
  ReadToolDetails as PiRead,
  Stm32ConfigToolDetails as PiStm32Config,
  ToolchainToolDetails as PiToolchain,
  WriteToolDetails as PiWrite,
} from "@yoma/my-pi-coding-agent"

import type { ToolDetailsMap } from "../types.ts"

/**
 * 断言必须是 **约束式** 的。
 *
 * 别写成 `const _assert: SomeCheck = true as never` —— `never` 可赋给任何类型,
 * 那个写法在检查失败时照样编译通过,是一个不会响的闸门(已实测踩过)。
 * `Expect<T extends true>` 把失败变成类型参数约束违例,绕不过去。
 */
type Expect<_T extends true> = void

/** `Assignable<From, To>` 只在 From 能赋给 To 时为 true。 */
type Assignable<From, To> = [From] extends [To] ? true : false

// my-pi 改名、删字段、改字段类型 → 下面对应那一行立刻编译失败。新增字段是兼容的,不误报。
export type Check_read = Expect<Assignable<PiRead, ToolDetailsMap["read"]>>
export type Check_bash = Expect<Assignable<PiBash, ToolDetailsMap["bash"]>>
export type Check_edit = Expect<Assignable<PiEdit, ToolDetailsMap["edit"]>>
export type Check_write = Expect<Assignable<PiWrite, ToolDetailsMap["write"]>>
export type Check_toolchain = Expect<Assignable<PiToolchain, ToolDetailsMap["toolchain"]>>
export type Check_stm32config = Expect<Assignable<PiStm32Config, ToolDetailsMap["stm32config"]>>
export type Check_netlist = Expect<Assignable<PiNetlist, ToolDetailsMap["netlist"]>>
export type Check_flash = Expect<Assignable<PiFlash, ToolDetailsMap["flash"]>>
export type Check_datasheet = Expect<Assignable<PiDatasheet, ToolDetailsMap["datasheet"]>>
export type Check_log = Expect<Assignable<PiLog, ToolDetailsMap["log"]>>
export type Check_gdb = Expect<Assignable<PiGdb, ToolDetailsMap["gdb"]>>
