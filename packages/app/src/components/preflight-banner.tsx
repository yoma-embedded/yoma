/** 首跑预检条:key / 引擎。(探针预检随 probe-rs 一起移除,2026-08。) */

import { For, Show, createResource } from "solid-js"
import type { PreflightReport } from "@yoma-desktop/kernel"
import { Button } from "@yoma-desktop/ui/button"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { kernel, kernelAvailable } from "@/utils/kernel"
import { createProviderCatalog } from "./kernel-providers"

type IssueKey =
  | "preflight.auth.missing"
  | "preflight.auth.error"
  | "preflight.engines.missingDir"
  | "preflight.engines.emptyShell"
  | "preflight.engines.missingBin"

type Issue = { id: "auth" | "engines"; key: IssueKey; connect?: boolean }

function loadPreflight(): Promise<PreflightReport | undefined> {
  if (!kernelAvailable()) return Promise.resolve(undefined)
  return kernel.app.preflight()
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
  const providers = createProviderCatalog()
  const [report] = createResource(
    () => providers().map((item) => `${item.id}:${item.authenticated}`).join("|"),
    loadPreflight,
  )

  const items = () => {
    const value = report()
    return value ? issues(value) : []
  }

  const params = (id: Issue["id"]): Record<string, string> => {
    const value = report()
    if (!value) return {}
    if (id === "auth") return { detail: value.auth.detail ?? "", file: value.auth.file }
    return { missing: value.engines.missing.join(", "), dir: value.engines.dir ?? "" }
  }

  const connect = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  return (
    <Show when={items().length > 0}>
      <div
        data-component="preflight-banner"
        class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-weak-base px-4 py-1.5 text-12-regular text-text-base"
      >
        <span class="text-12-medium text-text-strong">{language.t("preflight.title")}</span>
        <For each={items()}>
          {(item) => (
            <span class="flex items-center gap-2">
              <span>{language.t(item.key, params(item.id))}</span>
              <Show when={item.connect}>
                <Button size="small" variant="primary" onClick={connect}>
                  {language.t("preflight.auth.connect")}
                </Button>
              </Show>
            </span>
          )}
        </For>
      </div>
    </Show>
  )
}
