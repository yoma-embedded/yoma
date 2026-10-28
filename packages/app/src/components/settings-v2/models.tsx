import type { ModelInfo, ProviderInfo } from "@yoma-desktop/kernel"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { TextInputV2 } from "@yoma-desktop/ui/v2/text-input-v2"
import { Switch } from "@yoma-desktop/ui/v2/switch-v2"
import { For, Show, batch, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { kernel } from "@/utils/kernel"
import { invalidateProviders, refreshProviderCatalog } from "../kernel-providers"

function ContextWindow(props: { providerID: string; model: ModelInfo }) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    value: String(props.model.contextWindowOverride ?? ""),
    saving: false,
    error: "",
  })
  const save = async () => {
    if (store.saving || store.value === String(props.model.contextWindowOverride ?? "")) return
    setStore({ saving: true, error: "" })
    try {
      await kernel.model.setContext({
        providerID: props.providerID,
        modelID: props.model.id,
        contextWindow: store.value.trim() ? Number(store.value) : undefined,
      })
      invalidateProviders()
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : language.t("common.requestFailed"))
    } finally {
      setStore("saving", false)
    }
  }
  return (
    <div data-slot="context-window">
      <TextInputV2
        name="modelContextWindow"
        type="number"
        min="1024"
        max="10000000"
        value={store.value}
        placeholder={String(props.model.contextWindow ?? "")}
        aria-label={language.t("provider.custom.context")}
        disabled={store.saving}
        onInput={(event) => setStore("value", event.currentTarget.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur()
        }}
      />
      <Show when={store.error}>
        <span role="alert">{store.error}</span>
      </Show>
    </div>
  )
}

export function SettingsModelsV2(props: { provider: ProviderInfo }) {
  const language = useLanguage()
  const models = useModels()
  const [store, setStore] = createStore({ filter: "", refreshing: false, error: "" })
  const items = createMemo(() =>
    props.provider.models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(store.filter.toLowerCase())),
  )
  const key = (model: ModelInfo) => ({ providerID: props.provider.id, modelID: model.id })
  const enabled = () => props.provider.models.filter((m) => models.visible(key(m))).length
  const all = (value: boolean) =>
    batch(() => {
      for (const model of props.provider.models) models.setVisibility(key(model), value)
    })
  const refresh = async () => {
    setStore({ refreshing: true, error: "" })
    try {
      await refreshProviderCatalog()
    } catch {
      setStore("error", language.t("common.requestFailed"))
    } finally {
      setStore("refreshing", false)
    }
  }
  return (
    <section data-component="settings-models-provider">
      <div data-slot="model-actions">
        <strong>
          {language.t("settings.models.available", { count: enabled(), total: props.provider.models.length })}
        </strong>
        <ButtonV2 size="normal" variant="neutral" onClick={() => all(true)}>
          {language.t("settings.models.enableAll")}
        </ButtonV2>
        <ButtonV2 size="normal" variant="neutral" onClick={() => all(false)}>
          {language.t("settings.models.disableAll")}
        </ButtonV2>
        <ButtonV2 size="normal" variant="ghost-muted" disabled={store.refreshing} onClick={() => void refresh()}>
          {language.t(store.refreshing ? "settings.models.refreshing" : "settings.models.refresh")}
        </ButtonV2>
      </div>
      <TextInputV2
        type="search"
        value={store.filter}
        onInput={(event) => setStore("filter", event.currentTarget.value)}
        placeholder={language.t("dialog.model.search.placeholder")}
        aria-label={language.t("dialog.model.search.placeholder")}
      />
      <p data-slot="model-help">{language.t("settings.models.contextHelp")}</p>
      <Show when={store.error}>
        <p role="alert">{store.error}</p>
      </Show>
      <div data-slot="model-rows">
        <For each={items()}>
          {(item) => (
            <div data-slot="model-row" data-model-id={item.id}>
              <div data-slot="model-name">
                <strong>{item.name}</strong>
                <span>{item.id}</span>
              </div>
              <ContextWindow providerID={props.provider.id} model={item} />
              <Switch
                checked={models.visible(key(item))}
                onChange={(checked) => models.setVisibility(key(item), checked)}
                hideLabel
              >
                {item.name}
              </Switch>
            </div>
          )}
        </For>
        <Show when={!items().length}>
          <p>{language.t("dialog.model.empty")}</p>
        </Show>
      </div>
    </section>
  )
}
