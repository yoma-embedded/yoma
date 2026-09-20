/**
 * "这一轮没跑起来,因为授权" 的统一提示。
 *
 * 三个调用点共用(发送 / 队列里的改后重发 / 手动压缩):它们的通用失败话术是
 * "请求失败 + 内核报错原文",而授权这一类要说清楚是哪种状态、哪一天,并给一个
 * 直达「设置 → 授权」的按钮。**不做全屏登录墙** —— 历史会话、设置、文件、波形面板
 * 在没有授权时照常能看,被拦的只有"开始跑"这一个动作。
 */

import type { ToastAction } from "@yoma-desktop/ui/toast"
import { useLanguage } from "@/context/language"
import { useSettingsDialog } from "@/components/settings-dialog"
import { showToast } from "@/utils/toast"
import { formatInstant, licenseRequiredDescriptionKey, licenseRequiredInstant, licenseRequiredTitleKey } from "./format"
import { licenseRequiredFrom } from "./license-error"

/** 设置对话框里授权那一页的 tab 值(`dialog-settings-v2.tsx` 的 TabsV2 键)。 */
export const LICENSE_SETTINGS_TAB = "license"

export function createLicenseNotice() {
  const language = useLanguage()
  // 设置对话框要 DialogProvider。生产里它永远在(AppBaseProviders),但单测会直接调
  // `createPromptSubmit()` 这类工厂,那里没有对话框上下文 —— 拿不到就**不渲染那个按钮**
  // 而不是渲染一个点了没反应的按钮,提示本身照出。
  const openSettings = (() => {
    try {
      return useSettingsDialog()
    } catch {
      return undefined
    }
  })()

  const open = openSettings ? () => openSettings(LICENSE_SETTINGS_TAB) : undefined

  /**
   * 是授权问题就出提示并返回 true,调用点据此跳过自己那条通用失败话术;
   * 不是的话什么都不做、返回 false。
   */
  const notifyIfLicense = (error: unknown) => {
    const data = licenseRequiredFrom(error)
    if (!data) return false
    const instant = licenseRequiredInstant(data)
    const actions: ToastAction[] = []
    if (open) actions.push({ label: language.t("license.action.open"), onClick: open })
    actions.push({ label: language.t("license.action.dismiss"), onClick: "dismiss" })
    showToast({
      variant: "error",
      icon: "shield",
      // 不自动消失:这条要说明"这一轮没跑"并给出下一步,一闪而过等于没说。
      persistent: true,
      title: language.t(licenseRequiredTitleKey(data.state) as never),
      description: language.t(licenseRequiredDescriptionKey(data.state) as never, {
        date: instant ? formatInstant(instant) : "",
      }),
      actions,
    })
    return true
  }

  /** 亮出授权页。拿不到对话框上下文时是 no-op(调用点据此决定要不要渲染按钮)。 */
  const openLicenseSettings = () => open?.()

  return { notifyIfLicense, openLicenseSettings, canOpenSettings: () => !!open }
}
