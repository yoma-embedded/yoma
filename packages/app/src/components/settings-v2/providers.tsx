/**
 * Provider 设置页。
 *
 * 目录来自 `kernel.model.list()`,连接状态就是 `ProviderInfo.authenticated` 一个布尔值。
 * opencode 那套 source 分类(env / api / config / custom)、`disabled_providers` 配置写回、
 * 自定义 provider 全部删掉 —— yoma 只有"有没有 API key"这一件事。
 */

import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { ProviderIcon } from "@yoma-desktop/ui/provider-icon"
import { showToast } from "@/utils/toast"
import { createMemo, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { kernel } from "@/utils/kernel"
import { DialogConnectProvider } from "../dialog-connect-provider"
import { createProviderCatalog, invalidateProviders } from "../kernel-providers"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

const PROVIDER_ICON_SIZE = 16

export const SettingsProvidersV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const providers = createProviderCatalog()

  const connected = createMemo(() => providers().filter((item) => item.authenticated))
  const available = createMemo(() => providers().filter((item) => !item.authenticated))

  const disconnect = async (providerID: string, name: string) => {
    try {
      await kernel.model.removeAuth(providerID)
      invalidateProviders()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
        description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
      })
    } catch (err) {
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.providers.title")}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-providers">
        <div class="settings-v2-section" data-component="connected-providers-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.connected")}</h3>
          <SettingsListV2>
            <Show
              when={connected().length > 0}
              fallback={
                <div class="settings-v2-provider-empty">{language.t("settings.providers.connected.empty")}</div>
              }
            >
              <For each={connected()}>
                {(item) => (
                  <div class="settings-v2-provider-row group">
                    <div class="settings-v2-provider-lead">
                      <ProviderIcon
                        id={item.id}
                        width={PROVIDER_ICON_SIZE}
                        height={PROVIDER_ICON_SIZE}
                        class="settings-v2-provider-icon shrink-0"
                      />
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name truncate">{item.name}</span>
                      </div>
                    </div>
                    <ButtonV2 size="normal" variant="ghost-muted" onClick={() => void disconnect(item.id, item.name)}>
                      {language.t("common.disconnect")}
                    </ButtonV2>
                  </div>
                )}
              </For>
            </Show>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.popular")}</h3>
          <SettingsListV2>
            <For each={available()}>
              {(item) => (
                <div class="settings-v2-provider-row">
                  <div class="settings-v2-provider-lead">
                    <ProviderIcon
                      id={item.id}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-provider-icon shrink-0"
                    />
                    <div class="settings-v2-provider-copy">
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name">{item.name}</span>
                      </div>
                    </div>
                  </div>
                  <ButtonV2
                    size="normal"
                    variant="neutral"
                    icon="plus"
                    onClick={() => {
                      dialog.show(() => <DialogConnectProvider provider={item.id} />)
                    }}
                  >
                    {language.t("common.connect")}
                  </ButtonV2>
                </div>
              )}
            </For>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
