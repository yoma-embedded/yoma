/**
 * 首跑预检条:key / 引擎 / 本机工具链。(探针预检随 probe-rs 一起移除,2026-08。)
 *
 * 前两项是"缺了就不能上板"的硬缺口,状态好转自动消失。工具链项软一档:机器账本
 * (~/.yoma/toolchains.json)一条记录都没有 = 从没配置过 —— 提醒去设置页按芯片平台
 * 一次配好,但它可忽略(localStorage 记住),毕竟工具全在 PATH 上的机器不配也能跑;
 * 配过一次(手填或"重新探测"入账)之后条件自然不成立。判断走 toolchain.families
 * 轻调用,不探测,启动路径上没有新增的子进程开销。
 */

import { For, Show, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import type { PreflightReport } from "@yoma-desktop/kernel"
import { Button } from "@yoma-desktop/ui/button"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { kernel, kernelAvailable } from "@/utils/kernel"
import { useSettingsDialog } from "@/components/settings-dialog"
import { createProviderCatalog } from "./kernel-providers"

const TOOLCHAIN_DISMISS_KEY = "yoma.toolchain.nudge-dismissed"

type IssueKey =
  | "preflight.auth.missing"
  | "preflight.auth.error"
  | "preflight.engines.missingDir"
  | "preflight.engines.emptyShell"
  | "preflight.engines.missingBin"
  | "preflight.toolchain.unconfigured"

type Issue = { id: "auth" | "engines" | "toolchain"; key: IssueKey; connect?: boolean; toolchain?: boolean }

function loadPreflight(): Promise<PreflightReport | undefined> {
  if (!kernelAvailable()) return Promise.resolve(undefined)
  return kernel.app.preflight()
}

function loadToolchainRecorded(): Promise<number | undefined> {
  if (!kernelAvailable()) return Promise.resolve(undefined)
  return kernel.toolchain.families().then((view) => view.recordedIds.length)
}

function issues(report: PreflightReport): Issue[] {
  const items: Issue[] = []
  if (!report.auth.ok) {
    items.push({
      id: "auth",
      key: report.auth.code === "error" ? "preflight.auth.error" : "preflight.auth.missing",
      connect: true,
    })
  }
  if (!report.engines.ok) {
    items.push({
      id: "engines",
      key:
        report.engines.code === "emptyShell"
          ? "preflight.engines.emptyShell"
          : report.engines.code === "missingBin"
            ? "preflight.engines.missingBin"
            : "preflight.engines.missingDir",
    })
  }
  return items
}

export function PreflightBanner() {
  const language = useLanguage()
  const dialog = useDialog()
  const openSettings = useSettingsDialog()
  const providers = createProviderCatalog()
  const [report] = createResource(
    () => providers().map((item) => `${item.id}:${item.authenticated}`).join("|"),
    loadPreflight,
  )
  const [recorded] = createResource(loadToolchainRecorded)
  const [nudge, setNudge] = createStore({
    dismissed: localStorage.getItem(TOOLCHAIN_DISMISS_KEY) === "1",
  })

  const items = () => {
    const value = report()
    const list = value ? issues(value) : []
    if (recorded() === 0 && !nudge.dismissed) {
      list.push({ id: "toolchain", key: "preflight.toolchain.unconfigured", toolchain: true })
    }
    return list
  }

  // 「还不能上板」只在硬缺口(key / 引擎)成立;只剩工具链软提醒时换软标题 ——
  // 工具全在 PATH 上的机器不配也能跑,不该被横幅宣判成不能干活。
  const title = () =>
    language.t(items().some((item) => item.id !== "toolchain") ? "preflight.title" : "preflight.toolchain.title")

  const params = (id: Issue["id"]): Record<string, string> => {
    const value = report()
    if (!value || id === "toolchain") return {}
    if (id === "auth") return { detail: value.auth.detail ?? "", file: value.auth.file }
    return { missing: value.engines.missing.join(", "), dir: value.engines.dir ?? "" }
  }

  const connect = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const dismissToolchain = () => {
    localStorage.setItem(TOOLCHAIN_DISMISS_KEY, "1")
    setNudge("dismissed", true)
  }

  return (
    <Show when={items().length > 0}>
      <div
        data-component="preflight-banner"
        class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-weak-base px-4 py-1.5 text-12-regular text-text-base"
      >
        <span class="text-12-medium text-text-strong">{title()}</span>
        <For each={items()}>
          {(item) => (
            <span class="flex items-center gap-2">
              <span>{language.t(item.key, params(item.id))}</span>
              <Show when={item.connect}>
                <Button size="small" variant="primary" onClick={connect}>
                  {language.t("preflight.auth.connect")}
                </Button>
              </Show>
              <Show when={item.toolchain}>
                <Button size="small" variant="primary" onClick={() => openSettings("toolchain")}>
                  {language.t("preflight.toolchain.configure")}
                </Button>
                <Button size="small" variant="ghost" onClick={dismissToolchain}>
                  {language.t("preflight.toolchain.dismiss")}
                </Button>
              </Show>
            </span>
          )}
        </For>
      </div>
    </Show>
  )
}
