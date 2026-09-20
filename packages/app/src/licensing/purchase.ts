/**
 * 购买信息的**唯一**真源:价格、计价单位、联系方式,以及说明文案用哪几条 i18n 键。
 *
 * 改价 / 填真实联系方式**只动这一个文件**。界面里一个数字都不写死,i18n 字典里也没有价格
 * —— 价格是 `{{monthly}}` / `{{yearly}}` 两个变量填进去的,所以翻译漂移不会让两种语言
 * 报出不同的价钱。
 *
 * `contact.configured: false` 是**今天的事实**:还没有对外的收款渠道。界面这时如实说
 * "购买联系方式待配置",绝不渲染占位链接 —— 编一个网址 / 微信号出来,用户会真的照着去找。
 * 有了渠道就把 `configured` 翻成 true 并往 `channels` 里加条目,界面自己会显示;
 * 只有 `kind: "url"` 的渠道才会走平台的打开外链能力。
 */

/** 渠道类型。`url` 是唯一可点开的一类。 */
export type PurchaseChannelKind = "wechat" | "email" | "url" | "phone" | "other"

export interface PurchaseChannel {
  kind: PurchaseChannelKind
  /** 给人看的名字("微信"、"销售邮箱")。 */
  label: string
  /** 真实值。`url` 类必须是完整地址(带 scheme)。 */
  value: string
}

export interface PurchaseContact {
  /** 有没有可以对外说的购买渠道。false 时界面显示"待配置",不渲染任何链接。 */
  configured: boolean
  channels: PurchaseChannel[]
}

export interface PurchasePricing {
  currency: "CNY"
  /** 每人每月。 */
  monthly: number
  /** 每人每年。 */
  yearly: number
  /** 计价单位:按人。 */
  unit: "per-seat"
  /** 试售价(还不是长期定价)—— 界面据此加一句"试售价"。 */
  trial: boolean
}

export interface PurchaseInfo {
  pricing: PurchasePricing
  contact: PurchaseContact
  /** 说明文案的 i18n 键。文案本体在 `i18n/{zh,en}.ts`。 */
  copy: {
    /** 价格行,变量 `{{monthly}}` / `{{yearly}}`。 */
    pricing: string
    /** 软件授权费不包含模型费用。 */
    modelsExcluded: string
    /** 续费怎么做。 */
    renewal: string
    /** 联系方式还没配置时说什么。 */
    contactPending: string
  }
}

export const PURCHASE: PurchaseInfo = {
  pricing: { currency: "CNY", monthly: 999, yearly: 9990, unit: "per-seat", trial: true },
  contact: { configured: false, channels: [] },
  copy: {
    pricing: "settings.license.purchase.pricing",
    modelsExcluded: "settings.license.purchase.modelsExcluded",
    renewal: "settings.license.purchase.renewal",
    contactPending: "settings.license.purchase.contactPending",
  },
}

/**
 * 金额 → 给人看的字符串。Intl 不认这个币种(或者环境裁过 ICU)时退回 `CNY 999`,
 * 不抛 —— 一个格式化失败不该让整张授权页白掉。
 */
export function formatPurchaseAmount(amount: number, currency: string = PURCHASE.pricing.currency, locale?: string) {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount)
  } catch {
    return `${currency} ${amount}`
  }
}

/** 可以点开的渠道(只有 `url` 类)。其余渠道只显示文本,让用户自己抄。 */
export function isOpenableChannel(channel: PurchaseChannel) {
  return channel.kind === "url" && /^https?:\/\//i.test(channel.value)
}

/** 有没有东西可显示:未配置或者一条渠道都没有时,界面走"待配置"那一支。 */
export function hasPurchaseContact(contact: PurchaseContact = PURCHASE.contact) {
  return contact.configured && contact.channels.length > 0
}
