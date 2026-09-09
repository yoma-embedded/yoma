import { describe, expect, test } from "vitest"
import { dict as en } from "./en"
import { dict as zh } from "./zh"

const keys = ["command.session.previous.unseen", "command.session.next.unseen"] as const

/**
 * 设置页的"更新"与"工具链"两块是**双语同权**的:一边加了键另一边没加,中文用户看到的
 * 就是一个原样的 key(i18n 没有回落到英文,漏了就是漏了)。所以这两个前缀下的键
 * 必须双向齐平 —— 不是"zh 覆盖 en",两个方向都查。
 */
const PARITY_PREFIXES = ["settings.updates.", "settings.toolchain."] as const

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
