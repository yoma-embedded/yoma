/**
 * ELF 文件头的最小读法:只认魔数与 e_machine,用来按架构挑 gdb。
 * 只要头 0x14 字节 —— 整读会为一个带调试信息的 ELF 拉起几十 MB 的临时 buffer。
 */

export const ELF_HEADER_BYTES = 0x14

/** e_machine 的取值(ELF 规范):这三个是嵌入式里会碰到的。 */
export const ELF_MACHINE = {
  ARM: 0x28,
  AARCH64: 0xb7,
  RISCV: 0xf3,
} as const

/** 偏移 0x12 的 e_machine;不是 ELF 或头不够长就返回 undefined,不猜。 */
export function elfMachine(head: Uint8Array): number | undefined {
  if (head.length < ELF_HEADER_BYTES) return undefined
  if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) return undefined
  // e_ident[EI_DATA]:1 小端,2 大端。嵌入式基本都是小端,但别假设。
  const little = head[5] !== 2
  return little ? head[0x12]! | (head[0x13]! << 8) : (head[0x12]! << 8) | head[0x13]!
}

/**
 * 按 ELF 的架构排 gdb 候选名(PATH 上按序找第一个)。认不出架构就只剩通用的两个。
 * **绝不走 engineBin**:那会抛"跑 `npm run engines:build`",而 gdb 是工具链的一部分,不是引擎 ——
 * 模型会照做、成功、再撞同一个错。
 */
export function preferredGdbNames(machine: number | undefined): string[] {
  if (machine === ELF_MACHINE.ARM) return ["arm-none-eabi-gdb", "gdb-multiarch", "gdb"]
  if (machine === ELF_MACHINE.RISCV)
    return ["riscv64-unknown-elf-gdb", "riscv32-unknown-elf-gdb", "gdb-multiarch", "gdb"]
  if (machine === ELF_MACHINE.AARCH64) return ["aarch64-none-elf-gdb", "gdb-multiarch", "gdb"]
  return ["gdb-multiarch", "gdb"]
}
