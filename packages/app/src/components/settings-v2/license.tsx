/**
 * 设置 → 授权。四块:当前状态 / 导入授权文件 / 购买或续费 / 排查。
 *
 * 这一页**只显示与导入**。能不能开始一轮由内核在执行入口自己判(`session.prompt` /
 * `session.compact` / bench / 信箱各自的入口),界面不做任何"是否付费"的放行判断,
 * 也不往内核传"已付费"之类的东西 —— 协议里没有这样的参数。
 *
 * 状态来自模块级的共享 store(`@/licensing/license-store`),授权页、提交失败提示、
 * 调试台横幅读的是同一份:导入成功之后三处一起变。
 *
 * 价格与联系方式在 `@/licensing/purchase`,这一页一个数字都不写死;联系方式没配置时
 * 如实说"待配置",不渲染任何链接。
 */

import { createMemo, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { Icon } from "@yoma-desktop/ui/icon"
import { LICENSE_FILE_EXTENSION, LICENSE_MAX_BYTES, type LicenseState } from "@yoma-desktop/kernel"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { kernel } from "@/utils/kernel"
import {
  formatByteLimit,
  formatInstant,
  formatValidityRange,
  licenseCountdown,
  licenseCountdownKey,
  licenseCountdownVars,
  licenseErrorKey,
  licenseStateDetailKey,
  licenseStateKey,
} from "@/licensing/format"
import { licenseImportErrorFrom } from "@/licensing/license-error"
import { applyLicenseStatus, useLicenseStatus } from "@/licensing/license-store"
import {
  formatPurchaseAmount,
  hasPurchaseContact,
  isOpenableChannel,
  PURCHASE,
  purchasePricingKey,
} from "@/licensing/purchase"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

/** 徽标的色档。`not-required` 刻意是中性的 —— 不许装成"已激活"。 */
const TONE: Record<LicenseState, "neutral" | "ok" | "warn" | "bad"> = {
  "not-required": "neutral",
  missing: "warn",
  active: "ok",
  "not-yet-valid": "warn",
  expired: "bad",
  invalid: "bad",
}

const ICON: Record<LicenseState, "shield" | "circle-check" | "warning"> = {
  "not-required": "shield",
  missing: "warning",
  active: "circle-check",
  "not-yet-valid": "warning",
  expired: "warning",
  invalid: "warning",
}

const Field: Component<{ label: string; value: string }> = (props) => (
  <div data-component="settings-v2-license-field">
    <span data-slot="settings-v2-license-field-label">{props.label}</span>
    <span data-slot="settings-v2-license-field-value">{props.value}</span>
  </div>
)

export const SettingsLicenseV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const license = useLicenseStatus()

  /** 导入这一动作的本地状态。一个 store 而不是两个 signal(见 packages/app/AGENTS.md)。 */
  const [local, setLocal] = createStore({ importing: false, error: undefined as string | undefined })
  let picker: HTMLInputElement | undefined

  const status = license.status
  const state = () => status()?.state
  const info = () => status()?.license

  const validity = createMemo(() => {
    const current = info()
    if (!current) return undefined
    return formatValidityRange({ notBefore: current.notBefore, expiresAt: current.expiresAt })
  })

  const countdown = createMemo(() => {
    const current = info()
    if (!current) return undefined
    // 到期 / 生效那一刻由 store 的定时器把状态重查回来,这里只是把它说成人话。
    return licenseCountdown(current.expiresAt, Date.now())
  })

  const errorText = () => {
    const error = status()?.error
    if (!error) return undefined
    const key = licenseErrorKey(error.code)
    return key ? language.t(key as never) : language.t("settings.license.error.unknown")
  }

  /** 导入被拒时那一句人话(未知 code 回落到内核给的中文兜底 message)。 */
  const rejectionText = (error: unknown) => {
    const data = licenseImportErrorFrom(error)
    // 开发态(源码直跑、没注入公钥的本机构建)没有可信公钥,内核用同一个 code(no-trusted-keys)拒收。
    // 那条 code 的通用话术是"构建配置有问题,请联系开发者" —— 对安装包成立,对开发态是句假话:这里什么都
    // 没坏,只是这次运行本来就不检查授权。客户手里的安装包到不了这个分支,这句话是说给开发者自己看的。
    if (data?.code === "no-trusted-keys" && state() === "not-required") {
      return language.t("settings.license.stateDetail.not-required")
    }
    const key = data ? licenseErrorKey(data.code) : undefined
    if (key) return language.t(key as never)
    if (error instanceof Error && error.message) return error.message
    return language.t("settings.license.error.unknown")
  }

  const runImport = async (file: File) => {
    setLocal("error", undefined)
    // 先按上限挡大小:读一个几百 MB 的误选文件进内存没有任何意义。
    if (file.size > LICENSE_MAX_BYTES) {
      setLocal(
        "error",
        `${language.t("settings.license.import.tooLarge", {
          size: formatByteLimit(file.size),
          limit: formatByteLimit(LICENSE_MAX_BYTES),
        })} ${language.t("settings.license.import.unchanged")}`,
      )
      return
    }
    setLocal("importing", true)
    try {
      const text = await file.text().catch((error: unknown) => {
        throw new Error(
          language.t("settings.license.import.readFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      })
      const next = await kernel.license.import(text)
      applyLicenseStatus(next)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.license.toast.imported.title"),
        description: next.license
          ? language.t("settings.license.toast.imported.description", {
              customer: next.license.customerLabel,
              end: formatValidityRange({ notBefore: next.license.notBefore, expiresAt: next.license.expiresAt }).end,
            })
          : undefined,
      })
    } catch (error) {
      // 导入失败**绝不能**往上抛:抛出去就是整个应用崩到错误页,而用户只是选错了一个文件。
      const text = rejectionText(error)
      setLocal("error", `${text} ${language.t("settings.license.import.unchanged")}`)
      showToast({
        variant: "error",
        icon: "warning",
        title: language.t("settings.license.toast.failed.title"),
        description: text,
      })
    } finally {
      setLocal("importing", false)
    }
  }

  const onPicked = (event: Event & { currentTarget: HTMLInputElement }) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    // 同一个文件连选两次也要触发 change —— 不清 value 的话第二次静默什么都不发生。
    input.value = ""
    if (file) void runImport(file)
  }

  const copyDiagnostics = async () => {
    try {
      const result = await kernel.license.diagnostics()
      // 剪贴板不可用(非安全上下文、权限被拒)时 `navigator.clipboard` 是 undefined:可选链会静默跳过,
      // 然后照样弹"已复制" —— 用户拿着空剪贴板去找开发者。拿不到就走失败分支。
      const clipboard = navigator.clipboard
      if (!clipboard?.writeText) throw new Error(language.t("settings.license.diagnostics.unavailable"))
      await clipboard.writeText(result.text)
      showToast({
        variant: "success",
        icon: "copy",
        title: language.t("settings.license.diagnostics.copied"),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.license.diagnostics.failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    }
  }

  const priceVars = () => ({
    monthly: formatPurchaseAmount(PURCHASE.pricing.monthly, PURCHASE.pricing.currency, language.intl()),
    yearly: formatPurchaseAmount(PURCHASE.pricing.yearly, PURCHASE.pricing.currency, language.intl()),
  })

  const StatusSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.license.section.status")}</h3>

      <Show when={license.error()}>
        {(message) => (
          <p data-component="settings-v2-license-error">
            {language.t("settings.license.statusFailed", { message: message() })}
          </p>
        )}
      </Show>

      <Show when={state()} fallback={<p class="settings-v2-toolchain-note">…</p>}>
        {(current) => (
          <div data-component="settings-v2-license-status" data-state={current()}>
            <div data-slot="settings-v2-license-headline">
              <span data-component="settings-v2-license-badge" data-tone={TONE[current()]}>
                <Icon name={ICON[current()]} size="small" />
                {language.t(licenseStateKey(current()) as never)}
              </span>
              <Show when={countdown()}>
                {(value) => (
                  <span data-slot="settings-v2-license-countdown">
                    {language.t(licenseCountdownKey(value()) as never, licenseCountdownVars(value()))}
                  </span>
                )}
              </Show>
            </div>

            <p data-slot="settings-v2-license-detail">{language.t(licenseStateDetailKey(current()) as never)}</p>

            <Show when={errorText()}>
              {(text) => (
                <div data-component="settings-v2-license-error">
                  <p>{text()}</p>
                  <Show when={status()?.error?.message}>
                    {(message) => (
                      <p data-slot="settings-v2-license-error-raw">
                        {language.t("settings.license.error.detail", { message: message() })}
                      </p>
                    )}
                  </Show>
                </div>
              )}
            </Show>

            <Show when={info()}>
              {(current) => (
                <div data-component="settings-v2-license-fields">
                  <Field label={language.t("settings.license.field.customer")} value={current().customerLabel} />
                  <Field label={language.t("settings.license.field.licenseId")} value={current().licenseId} />
                  <Field
                    label={language.t("settings.license.field.validity")}
                    value={language.t("settings.license.validity", {
                      start: validity()?.start ?? "",
                      end: validity()?.end ?? "",
                      zone: validity()?.zone ?? "",
                    })}
                  />
                  <Show when={validity()?.lastDay}>
                    {(day) => (
                      <p data-slot="settings-v2-license-lastday">
                        {language.t("settings.license.validity.lastDay", { date: day() })}
                      </p>
                    )}
                  </Show>
                  <Field
                    label={language.t("settings.license.field.issuedAt")}
                    value={formatInstant(current().issuedAt)}
                  />
                  <Field label={language.t("settings.license.field.keyId")} value={current().signingKeyId} />
                </div>
              )}
            </Show>

            <div data-slot="settings-v2-license-meta">
              <Show when={status()?.file}>
                {(file) => <span>{`${language.t("settings.license.field.file")}: ${file()}`}</span>}
              </Show>
              <Show when={status()?.trustedKeyIds.length}>
                <span>
                  {language.t("settings.license.trustedKeys", { ids: status()!.trustedKeyIds.join(", ") })}
                </span>
              </Show>
              <Show when={status()?.checkedAt}>
                {(at) => <span>{language.t("settings.license.checkedAt", { time: formatInstant(at()) })}</span>}
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  )

  const ImportSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.license.section.import")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.license.import.title")}
          description={language.t("settings.license.import.description", {
            extension: LICENSE_FILE_EXTENSION,
            limit: formatByteLimit(LICENSE_MAX_BYTES),
          })}
        >
          <ButtonV2
            size="normal"
            variant="contrast"
            icon="download"
            data-action="license-import"
            disabled={local.importing}
            onClick={() => picker?.click()}
          >
            {language.t(local.importing ? "settings.license.import.importing" : "settings.license.import.action")}
          </ButtonV2>
        </SettingsRowV2>
      </SettingsListV2>
      <input
        ref={(element) => (picker = element)}
        type="file"
        accept=".yoma-license,.json,application/json"
        data-component="settings-v2-license-picker"
        onChange={onPicked}
      />
      <Show when={local.error}>
        {(text) => <p data-component="settings-v2-license-error">{text()}</p>}
      </Show>
    </div>
  )

  const PurchaseSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.license.section.purchase")}</h3>
      <div data-component="settings-v2-license-purchase">
        <p data-slot="settings-v2-license-price">{language.t(purchasePricingKey() as never, priceVars())}</p>
        <p class="settings-v2-toolchain-note">{language.t("settings.license.purchase.terms")}</p>
        <p class="settings-v2-toolchain-note">{language.t(PURCHASE.copy.modelsExcluded as never)}</p>
        <p class="settings-v2-toolchain-note">{language.t(PURCHASE.copy.renewal as never)}</p>

        <div data-slot="settings-v2-license-contact">
          <span data-slot="settings-v2-license-contact-title">{language.t("settings.license.purchase.contact")}</span>
          <Show
            when={hasPurchaseContact()}
            fallback={<p class="settings-v2-toolchain-note">{language.t(PURCHASE.copy.contactPending as never)}</p>}
          >
            <For each={PURCHASE.contact.channels}>
              {(channel) => (
                <div data-slot="settings-v2-license-channel">
                  <span data-slot="settings-v2-license-channel-kind">
                    {language.t(`settings.license.purchase.channel.${channel.kind}` as never)}
                  </span>
                  <span data-slot="settings-v2-license-channel-label">{channel.label}</span>
                  <span data-slot="settings-v2-license-channel-value">{channel.value}</span>
                  <Show when={isOpenableChannel(channel)}>
                    <ButtonV2 size="normal" variant="neutral" onClick={() => platform.openLink(channel.value)}>
                      {language.t("settings.license.purchase.open")}
                    </ButtonV2>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )

  const SupportSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.license.section.support")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.license.diagnostics.title")}
          description={language.t("settings.license.diagnostics.description")}
        >
          <ButtonV2
            size="normal"
            variant="neutral"
            icon="copy"
            data-action="license-diagnostics"
            onClick={() => void copyDiagnostics()}
          >
            {language.t("settings.license.diagnostics.action")}
          </ButtonV2>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.license.title")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <StatusSection />
        <ImportSection />
        <PurchaseSection />
        <SupportSection />
      </div>
    </>
  )
}
