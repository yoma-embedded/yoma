import { describe, expect, test } from "vitest"
import { dict as en } from "./en"
import { dict as zh } from "./zh"

const keys = ["command.session.previous.unseen", "command.session.next.unseen"] as const

/**
 * 设置页的"更新"与"工具链"两块是**双语同权**的:一边加了键另一边没加,中文用户看到的
 * 就是一个原样的 key(i18n 没有回落到英文,漏了就是漏了)。所以这两个前缀下的键
 * 必须双向齐平 —— 不是"zh 覆盖 en",两个方向都查。
 */
const PARITY_PREFIXES = [
  "settings.updates.",
  "settings.toolchain.",
  "session.confirmDock.",
  // 调试工作台:仪器名、状态词、空状态提示全在这一族下。漏一条的表现是面板上出现 `undefined`。
  "session.bench.",
  // 授权:状态徽标、17 个错误码、购买说明。每个键都会被拼出来,漏一条就是界面上一块
  // `undefined`。逐个状态 / 错误码的穷尽检查在 `licensing/i18n-keys.test.ts`。
  "settings.license.",
  "license.",
  "bench.license.",
  // 子 agent:任务面板、子会话页的顶部条、输入框上方的"排队中"。
  "session.subagent.",
  "session.subagentDock.",
  "session.queueDock.",
  // 时间线的「本轮改动」那一行。
  "session.turnChanges.",
  // 会话内查找(cmd+F)。
  "session.search.",
  // 左侧栏的项目列表(标题行、每个项目的菜单、移除后的提示)。
  "codex.projects.",
  // /btw 顺便问一句:输入框上方那个坞的状态、按钮与说明,以及发不出去时的提示。
  "session.btwDock.",
  "prompt.toast.btw.",
] as const

/**
 * 工具链自动安装 + 更新状态展示这两块 UI 的**契约键**。UI 落地之前它们都不存在,
 * 这个测试因此是红的 —— 这正是它的用途:实现方按这张表补 en 与 zh。
 */
const CONTRACT_KEYS = [
  "settings.toolchain.install",
  "settings.toolchain.installAll",
  "settings.toolchain.installing.resolve",
  "settings.toolchain.installing.download",
  "settings.toolchain.installing.verify",
  "settings.toolchain.installing.extract",
  "settings.toolchain.installing.record",
  "settings.toolchain.cancel",
  "settings.toolchain.browse",
  "settings.toolchain.installable",
  "settings.toolchain.toast.installed",
  "settings.toolchain.toast.installFailed",
  "settings.updates.action.downloading",
  "settings.updates.action.installing",
  "settings.updates.state.ready",
  "settings.updates.state.error",
  "settings.updates.state.downloading",
  "settings.updates.state.upToDate",
  "settings.updates.version",
  "settings.updates.notes",
  "settings.updates.toast.ready.title",
  "settings.updates.toast.ready.description",
  // 只通知模式(这份安装不能自己升级:没有 Developer ID 的 mac 包)
  "settings.updates.action.openDownload",
  "settings.updates.state.available",
  "settings.updates.toast.available.title",
  "settings.updates.toast.available.description",
] as const

const enDict: Record<string, unknown> = en
const zhDict: Record<string, unknown> = zh

const prefixed = (dict: Record<string, unknown>) =>
  Object.keys(dict).filter((key) => PARITY_PREFIXES.some((prefix) => key.startsWith(prefix)))

const missingFrom = (dict: Record<string, unknown>, candidates: readonly string[]) =>
  candidates.filter((key) => typeof dict[key] !== "string" || (dict[key] as string).length === 0)

describe("i18n parity", () => {
  test("zh translates targeted unseen session keys", () => {
    for (const key of keys) {
      expect(zh[key]).toBeDefined()
      expect(zh[key]).not.toBe(en[key])
    }
  })

  test("zh has every settings.updates.* / settings.toolchain.* key that en has", () => {
    expect(missingFrom(zhDict, prefixed(enDict))).toEqual([])
  })

  test("en has every settings.updates.* / settings.toolchain.* key that zh has", () => {
    expect(missingFrom(enDict, prefixed(zhDict))).toEqual([])
  })

  test("both dictionaries carry the toolchain-install / updates UI contract keys", () => {
    expect({ en: missingFrom(enDict, CONTRACT_KEYS), zh: missingFrom(zhDict, CONTRACT_KEYS) }).toEqual({
      en: [],
      zh: [],
    })
  })
})
