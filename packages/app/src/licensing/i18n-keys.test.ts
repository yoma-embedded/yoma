/**
 * 授权界面的 i18n 闸门。
 *
 * solid 的 translator **对缺键返回 `undefined`**(不回落到英文),所以漏一条的表现不是
 * 报错,是界面上一块 `undefined`。而授权这一族的键大半是**拼出来的**(每个
 * `LicenseErrorCode`、每个 `LicenseState`、每个被拦下的状态各一条),眼睛看不出来漏了哪个。
 *
 * 这里把每一个会被拼出来的键逐个在两份字典里查一遍。列表本身的穷尽性由 `format.ts` 的
 * `AssertNever<…>` 在**编译期**钉住(内核往联合里加一个新值,那里就编译不过)。
 */

import { describe, expect, test } from "vitest"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import {
  LICENSE_ERROR_CODES,
  LICENSE_REQUIRED_STATES,
  LICENSE_STATES,
  licenseCountdownKey,
  licenseErrorKey,
  licenseRequiredDescriptionKey,
  licenseRequiredTitleKey,
  licenseStateDetailKey,
  licenseStateKey,
  type LicenseCountdown,
} from "./format"
import { PURCHASE, purchasePricingKey } from "./purchase"

const enDict: Record<string, unknown> = en
const zhDict: Record<string, unknown> = zh

const missing = (dict: Record<string, unknown>, keys: readonly string[]) =>
  keys.filter((key) => typeof dict[key] !== "string" || (dict[key] as string).length === 0)

const both = (keys: readonly string[]) => ({ en: missing(enDict, keys), zh: missing(zhDict, keys) })
const none = { en: [], zh: [] }

const COUNTDOWNS: LicenseCountdown[] = [
  { kind: "remaining-days", days: 3 },
  { kind: "remaining-hours", hours: 3 },
  { kind: "expired-days", days: 3 },
  { kind: "expired-today" },
]

describe("授权 i18n 键在两份字典里都真实存在", () => {
  test("每个 LicenseErrorCode 一条文案", () => {
    const keys = LICENSE_ERROR_CODES.map((code) => licenseErrorKey(code)!)
    expect(keys).toHaveLength(LICENSE_ERROR_CODES.length)
    expect(both(keys)).toEqual(none)
  })

  test("每个 LicenseState 都有徽标短名与一句话解释", () => {
    expect(both(LICENSE_STATES.map(licenseStateKey))).toEqual(none)
    expect(both(LICENSE_STATES.map(licenseStateDetailKey))).toEqual(none)
  })

  test("每个被拦下的状态都有标题与说明", () => {
    expect(both(LICENSE_REQUIRED_STATES.map(licenseRequiredTitleKey))).toEqual(none)
    expect(both(LICENSE_REQUIRED_STATES.map(licenseRequiredDescriptionKey))).toEqual(none)
  })

  test("每一种倒计时都有文案", () => {
    expect(both(COUNTDOWNS.map(licenseCountdownKey))).toEqual(none)
  })

  test("购买渠道的每一种类型都有名字", () => {
    const kinds = ["wechat", "email", "url", "phone", "other"] as const
    expect(both(kinds.map((kind) => `settings.license.purchase.channel.${kind}`))).toEqual(none)
  })

  test("purchase.ts 指的那几条说明文案都存在", () => {
    expect(both(Object.values(PURCHASE.copy))).toEqual(none)
  })

  /** 静态键也过一遍:这一页除了状态块之外全是它们。 */
  test("授权页与调试台横幅的静态键", () => {
    expect(
      both([
        "settings.tab.license",
        "settings.license.title",
        "settings.license.section.status",
        "settings.license.section.import",
        "settings.license.section.purchase",
        "settings.license.section.support",
        "settings.license.field.customer",
        "settings.license.field.licenseId",
        "settings.license.field.validity",
        "settings.license.field.issuedAt",
        "settings.license.field.keyId",
        "settings.license.field.file",
        "settings.license.validity",
        "settings.license.validity.lastDay",
        "settings.license.checkedAt",
        "settings.license.trustedKeys",
        "settings.license.error.detail",
        "settings.license.error.unknown",
        "settings.license.import.title",
        "settings.license.import.description",
        "settings.license.import.action",
        "settings.license.import.importing",
        "settings.license.import.tooLarge",
        "settings.license.import.readFailed",
        "settings.license.import.unchanged",
        "settings.license.toast.imported.title",
        "settings.license.toast.imported.description",
        "settings.license.toast.failed.title",
        "settings.license.purchase.terms",
        "settings.license.purchase.contact",
        "settings.license.purchase.open",
        "settings.license.diagnostics.title",
        "settings.license.diagnostics.description",
        "settings.license.diagnostics.action",
        "settings.license.diagnostics.copied",
        "settings.license.diagnostics.failed",
        "settings.license.statusFailed",
        "license.action.open",
        "license.action.dismiss",
        "bench.phase.paused",
        "bench.license.title",
        "bench.license.note.autoResume",
        "bench.license.note.restart",
        "bench.license.resolved",
        "bench.license.instant",
        "bench.license.open",
      ]),
    ).toEqual(none)
  })

  /**
   * 商业口径的两条硬要求:
   *  - "软件授权费不包含模型费用"必须真的出现在授权页上;
   *  - 价格只能来自 `purchase.ts`,字典里不许出现数字(否则改价要改三处、还会漂移)。
   */
  test("模型费用另计这句话在两种语言里都在", () => {
    expect(String(zhDict[PURCHASE.copy.modelsExcluded])).toContain("不包含模型费用")
    expect(String(enDict[PURCHASE.copy.modelsExcluded]).toLowerCase()).toContain("does not include model")
  })

  test("价格文案里没有写死的数字,只有变量", () => {
    for (const dict of [zhDict, enDict]) {
      for (const key of [PURCHASE.copy.pricing, PURCHASE.copy.pricingTrial]) {
        const text = String(dict[key])
        expect(text).toContain("{{monthly}}")
        expect(text).toContain("{{yearly}}")
        expect(text).not.toMatch(/\d/)
      }
    }
  })

  test("试售价标签由 purchase.ts 的 pricing.trial 决定,不写死在通用价格文案里", () => {
    expect(String(zhDict[PURCHASE.copy.pricingTrial])).toContain("试售价")
    expect(String(zhDict[PURCHASE.copy.pricing])).not.toContain("试售价")
    expect(String(enDict[PURCHASE.copy.pricing]).toLowerCase()).not.toContain("introductory")
    const standard = { ...PURCHASE, pricing: { ...PURCHASE.pricing, trial: false } }
    expect(purchasePricingKey(standard)).toBe(PURCHASE.copy.pricing)
    expect(purchasePricingKey({ ...standard, pricing: { ...standard.pricing, trial: true } })).toBe(PURCHASE.copy.pricingTrial)
  })

  /** 不许承诺未经验证的效果("效率提高 50–100 倍"那一类)。 */
  test("授权族的文案里没有倍数承诺", () => {
    for (const dict of [zhDict, enDict]) {
      for (const [key, value] of Object.entries(dict)) {
        if (!key.startsWith("settings.license.") && !key.startsWith("license.") && !key.startsWith("bench.license."))
          continue
        expect(String(value)).not.toMatch(/\d+\s*(倍|x\b|×)/i)
      }
    }
  })
})
