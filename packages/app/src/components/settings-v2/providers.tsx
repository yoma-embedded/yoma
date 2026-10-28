import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { ProviderIcon } from "@yoma-desktop/ui/provider-icon"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { createMemo, createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { kernel } from "@/utils/kernel"
import { DialogConnectProvider } from "../dialog-connect-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { createProviderCatalog, invalidateProviders, providerCategory } from "../kernel-providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import "./provider-models.css"

export function SettingsProvidersV2() {
  const language = useLanguage()
  const dialog = useDialog()
  const platform = usePlatform()
  const models = useModels()
  const providers = createProviderCatalog()
  const [store, setStore] = createStore({ selected: "", error: "", disconnecting: false })
  const connected = createMemo(() => providers().filter((p) => p.authenticated))
  const selected = createMemo(() => connected().find((p) => p.id === store.selected) ?? connected()[0])
  const count = (provider: ReturnType<typeof connected>[number]) =>
    provider.models.filter((m) => models.visible({ providerID: provider.id, modelID: m.id })).length
  const [usage, { refetch: refreshUsage }] = createResource(
    () => (selected()?.id === "openai-codex" ? "openai-codex" : undefined),
    (id) => kernel.model.usage(id),
  )
  const disconnect = async () => {
    const provider = selected()
    if (!provider) return
    setStore({ error: "", disconnecting: true })
    try {
      if (provider.custom) await kernel.model.removeCustom(provider.id)
      else await kernel.model.removeAuth(provider.id)
      invalidateProviders()
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : language.t("common.requestFailed"))
    } finally {
      setStore("disconnecting", false)
    }
  }
  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
      </div>
      <div data-component="provider-models" data-testid="provider-models">
        <aside data-slot="provider-sidebar">
          <nav aria-label={language.t("settings.providers.title")}>
            <For each={connected()}>
              {(provider) => (
                <button
                  type="button"
                  data-slot="provider-select"
                  aria-pressed={selected()?.id === provider.id}
                  onClick={() => {
                    setStore({ selected: provider.id, error: "" })
                  }}
                >
                  <ProviderIcon id={provider.id} width={18} height={18} />
                  <span>{provider.name}</span>
                  <small>
                    {count(provider)}/{provider.models.length}
                  </small>
                </button>
              )}
            </For>
          </nav>
          <ButtonV2
            size="normal"
            variant="ghost-muted"
            icon="plus"
            onClick={() =>
              void import("../dialog-select-provider").then((module) =>
                dialog.push(() => <module.DialogSelectProvider />),
              )
            }
          >
            {language.t("provider.add")}
          </ButtonV2>
        </aside>
        <main data-slot="provider-details">
          <Show when={selected()} keyed fallback={<p>{language.t("settings.providers.connected.empty")}</p>}>
            {(provider) => (
              <>
                <div data-slot="provider-actions">
                  <div>
                    <strong>{provider.name}</strong>
                    <p>{language.t(`provider.category.${providerCategory(provider)}`)}</p>
                  </div>
                  <ButtonV2
                    size="normal"
                    variant="neutral"
                    onClick={() =>
                      provider.custom
                        ? dialog.push(() => <DialogCustomProvider provider={provider} />)
                        : dialog.push(() => <DialogConnectProvider provider={provider.id} />)
                    }
                  >
                    {language.t(provider.id === "openai-codex" ? "settings.models.relogin" : "common.edit")}
                  </ButtonV2>
                  <ButtonV2
                    size="normal"
                    variant="ghost-muted"
                    disabled={store.disconnecting}
                    onClick={() => void disconnect()}
                  >
                    {language.t(provider.custom ? "common.delete" : "common.disconnect")}
                  </ButtonV2>
                </div>
                <Show when={store.error}>
                  <p role="alert">{store.error}</p>
                </Show>
                <Show when={provider.id === "openai-codex"}>
                  <section data-component="subscription-usage">
                    <div data-slot="model-actions">
                      <strong>{language.t("settings.models.usage")}</strong>
                      <ButtonV2
                        size="normal"
                        variant="ghost-muted"
                        disabled={usage.loading}
                        onClick={() => void refreshUsage()}
                      >
                        {language.t("settings.models.usageRefresh")}
                      </ButtonV2>
                      <ButtonV2
                        size="normal"
                        variant="ghost-muted"
                        onClick={() => platform.openLink("https://chatgpt.com/codex/settings/usage")}
                      >
                        {language.t("settings.models.manageUsage")}
                      </ButtonV2>
                    </div>
                    <Show when={!usage.loading} fallback={<p>{language.t("common.loading")}</p>}>
                      <Show
                        when={usage()?.status === "ready"}
                        fallback={
                          <p role="status">
                            {language.t("settings.models.usageUnavailable")}
                            {usage()?.httpStatus ? ` (HTTP ${usage()!.httpStatus})` : ""}
                          </p>
                        }
                      >
                        <Show when={usage()?.plan}>
                          <p>{usage()!.plan}</p>
                        </Show>
                        <For each={usage()?.windows}>
                          {(window) => (
                            <div data-slot="usage-row">
                              <span>
                                {window.name}
                                {window.windowMinutes !== undefined ? ` · ${window.windowMinutes} min` : ""}
                              </span>
                              <strong>
                                {language.t("settings.models.usedPercent", { percent: window.usedPercent })}
                              </strong>
                              <span>
                                {window.resetsAt
                                  ? language.t("settings.models.resetsAt", {
                                      time: new Date(window.resetsAt * 1000).toLocaleString(),
                                    })
                                  : ""}
                              </span>
                            </div>
                          )}
                        </For>
                        <Show when={usage()?.credits}>
                          {(credits) => (
                            <p>
                              {language.t("settings.models.credits")}:{" "}
                              {credits().unlimited
                                ? language.t("settings.models.unlimited")
                                : (credits().balance ?? "—")}
                            </p>
                          )}
                        </Show>
                      </Show>
                      <Show when={usage()?.checkedAt}>
                        <small>
                          {language.t("settings.models.checkedAt", {
                            time: new Date(usage()!.checkedAt).toLocaleString(),
                          })}
                        </small>
                      </Show>
                    </Show>
                  </section>
                </Show>
                <SettingsModelsV2 provider={provider} />
              </>
            )}
          </Show>
        </main>
      </div>
    </>
  )
}
