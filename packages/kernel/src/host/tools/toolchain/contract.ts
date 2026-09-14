/**
 * toolchain 工具的契约:菜单那一半。
 *
 * 项目声明自己要哪些主机工具(`.yoma/toolchain.json`),这台机器上到底有什么,两者对不上时怎么办 ——
 * 四个动作就是这三句话:看现状(check)、不信旧记录重看一遍(resolve)、把用户报的路径记下来(set)、
 * 自己下载装上(install)。
 *
 * 【为什么是工具而不是只放进系统提示词】开会话时已经把核账结果拼进提示词了,所以模型**开局**知道缺什么;
 * 但缺的那件东西往往是它跑了一条命令之后才暴露的(command not found),而那时提示词里那份已经过期 ——
 * 刚装的、用户刚指的都不在里面。没有这个工具,模型的下一步是 `which` / `where` 满机器找,找到了就把绝对
 * 路径硬编进脚本 —— 那条路径没人记得住,换台机器就碎,而这套账本存在的意义正是不让它碎。
 *
 * 门规同 flash / log(boundary.test.ts 第 3、5 条):这个文件只许 import typebox 与工具目录内的相对路径。
 * 清单路径因此是字面量而不是 import 自 domain/toolchain/schema.ts 的 `MANIFEST_RELATIVE` —— 两处必须一致,
 * tools-toolchain.test.ts 拿常量比着钉住。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

/** 与 domain/toolchain/schema.ts 的 MANIFEST_RELATIVE 同值(见文件头:契约不许 import 那边)。 */
export const MANIFEST_PATH = ".yoma/toolchain.json"

export const TOOLCHAIN_ACTIONS = ["check", "resolve", "set", "install"] as const
export type ToolchainAction = (typeof TOOLCHAIN_ACTIONS)[number]

const toolchainParameters = Type.Object({
  // 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never。
  action: Type.Union([Type.Literal("check"), Type.Literal("resolve"), Type.Literal("set"), Type.Literal("install")], {
    description: "check | resolve | set | install",
  }),
  id: Type.Optional(
    Type.String({
      description: 'Tool id as it appears in the manifest, e.g. "arm-gcc". Required for set and install.',
    }),
  ),
  path: Type.Optional(
    Type.String({
      description:
        "set: the absolute path the user gave you — either the executable itself or the directory it lives in (the declared executable names are resolved inside that directory and its bin/ subdirectory).",
    }),
  ),
})

export type ToolchainInput = Static<typeof toolchainParameters>

/** 卡片 metadata 只收能 JSON 往返的字段,所以这里是 ResolvedTool 的三格摘要,不是它本身。 */
export interface ToolchainToolSummary {
  id: string
  status: "ok" | "version-mismatch" | "ambiguous" | "missing"
  optional: boolean
}

export interface ToolchainDetails {
  action: ToolchainAction
  /** check / resolve:所有非 optional 的工具都 ok。set / install:这一次动作成功。 */
  ok: boolean
  side?: "mother" | "runner"
  /** check / resolve:项目有没有清单。 */
  declared?: boolean
  tools?: ToolchainToolSummary[]
  /** set / install:被记录的工具 id。 */
  id?: string
  installed?: { packageId: string; version: string; dir: string; binDir: string; reused: boolean }
}

const TOOLCHAIN_DESCRIPTION = `Resolves the host tools this project declares it needs (compiler, cmake, ninja, debug-probe drivers, python, ...) against what is actually installed on this machine, using the project's ${MANIFEST_PATH} manifest.

Actions:
- check: report each declared tool — ok / missing / version mismatch / ambiguous — with its resolved path, version, and how it was found (remembered ledger, PATH, a known install location, ...). Missing or wrong-version tools come with an install hint when the manifest has one.
- resolve: like check, but ignores what this machine remembered and probes fresh, then remembers what it finds for every later session here. Use it after the user installs something by hand, or when check reports a path that no longer exists.
- set (id, path): after you asked the user where a tool lives and they answered, record it. Pass the tool's id and the path they gave — the executable or the directory holding it. Only a nonexistent or relative path is rejected. Every later session on this machine finds it automatically, so you never have to ask twice.
- install (id): when check marks a tool "installable", download the pinned official release (sha256-verified) into the Yoma toolchains directory, remember it, and put it on PATH for your later commands. Downloads take minutes (the Arm GNU Toolchain is ~300 MB) — wait for the result, do not retry, and do not start a second install of the same tool. One package can cover several tools (the Arm one provides both arm-gcc and arm-gdb); check's install line names the single id to use, so call install once, not once per tool.

When to reach for this: the moment a command fails with "command not found", "'cmake' is not recognized as an internal or external command" (or the Chinese-Windows wording, "不是内部或外部命令"), or the build reports it cannot find a compiler, run check FIRST. Do not go hunting with where/which, do not guess an install path, and never hard-code a path you found into a script or command — an ad-hoc path like that is remembered by nobody and silently breaks the moment this project is built on another machine, which is the exact failure this tool exists to prevent.

If check says the tool is installable, run install yourself rather than telling the user to go install it. If it is not installable, relay the install hint, and once the user says where the right one is, call set.

If the project has no ${MANIFEST_PATH}, check says so — offer to draft one from the build files (CMakeLists.txt, Makefile, ...) and write it only after the user says yes.`

export const TOOLCHAIN_CONTRACT = {
  name: "toolchain",
  label: "工具链",
  description: TOOLCHAIN_DESCRIPTION,
  parameters: toolchainParameters,
  guidelines: [
    'The moment a command fails with "command not found" / "not recognized as an internal or external command" / a missing-compiler error, run toolchain check before searching for the binary yourself — never where/which it, and never hard-code a path you found.',
    "When toolchain check marks a missing tool installable, run toolchain install with that id instead of asking the user to install it; only tools without an installable note need the user.",
    "If toolchain check reports no manifest, ask before drafting .yoma/toolchain.json — never generate it unprompted.",
  ],
  /**
   * install 要问,别的三个不问:它从网上拉几百 MB、解压进用户主目录、还改了后续命令的 PATH ——
   * 这是这套工具里唯一一个**动这台机器**的动作(check / resolve 只读,set 只往账本写一行用户自己刚说的话)。
   *
   * 但上面那段 description 里**一个字都不提这道门**(同 FLASH_CONTRACT):挂不挂确认钩子是宿主的事,
   * 只有桌面端传 confirmTools。无人值守的 bench 与信箱工位端照跑不误 —— 描述里写"会先问用户"的话,
   * 对那两个宿主就是假话,而模型据此以为有人把关。门真的挡下来时模型自然会知道(它收到一段拒绝文本)。
   */
  confirm: (input: ToolchainInput) => input.action === "install",
  summary: toolchainSummary,
} as const satisfies ToolContract<typeof toolchainParameters>

/** 卡片副标题 / 确认条那一行。参数可能还在流式拼,缺什么就少说什么。 */
export function toolchainSummary(input: Partial<ToolchainInput>): string {
  const id = input.id?.trim()
  switch (input.action) {
    case "install":
      return id ? `install ${id}` : "install"
    case "set": {
      const target = input.path?.trim()
      if (id && target) return `set ${id} → ${target}`
      return id ? `set ${id}` : "set"
    }
    case "check":
    case "resolve":
      return input.action
    default:
      return ""
  }
}
