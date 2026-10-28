import type { ProviderInfo } from "@yoma-desktop/kernel"
import { Button } from "@yoma-desktop/ui/button"
import { Dialog } from "@yoma-desktop/ui/dialog"
import { TextField } from "@yoma-desktop/ui/text-field"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { createStore } from "solid-js/store"
import { Show } from "solid-js"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { useLanguage } from "@/context/language"
import { kernel } from "@/utils/kernel"
import { invalidateProviders } from "./kernel-providers"
import "./provider-selection.css"

export function DialogCustomProvider(props: { provider?: ProviderInfo; onBack?: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const config = props.provider?.custom
  const [store, setStore] = createStore({
    name: config?.name ?? "",
    baseUrl: config?.baseUrl ?? "",
    apiKey: "",
    modelIds: config?.modelIds.join("\n") ?? "",
    contextWindow: String(config?.contextWindow ?? 32768),
    maxOutput: String(config?.maxOutput ?? 4096),
    saving: false,
    error: "",
    importing: false,
    imported: undefined as number | undefined,
  })
  const importModels = async () => {
    setStore({ importing: true, error: "", imported: undefined })
    try {
      const ids = await kernel.model.discoverCustom({
        providerID: props.provider?.id,
        baseUrl: store.baseUrl,
        apiKey: store.apiKey,
      })
      setStore({ modelIds: ids.join("\n"), imported: ids.length })
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : language.t("common.requestFailed"))
    } finally {
      setStore("importing", false)
    }
  }
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setStore({ saving: true, error: "" })
    try {
      await kernel.model.saveCustom({
        providerID: props.provider?.id,
        name: store.name,
        baseUrl: store.baseUrl,
        apiKey: store.apiKey,
        modelIds: store.modelIds
          .split(/\r?\n/)
          .map((id) => id.trim())
          .filter(Boolean),
        contextWindow: Number(store.contextWindow),
        maxOutput: Number(store.maxOutput),
      })
      invalidateProviders()
      dialog.close()
    } catch (error) {
      setStore({ saving: false, error: error instanceof Error ? error.message : language.t("common.requestFailed") })
    }
  }
  return (
    <Dialog
      title={language.t("provider.custom.title")}
      size="large"
      action={
        props.onBack ? (
          <IconButton
            icon="arrow-left"
            variant="ghost"
            aria-label={language.t("common.goBack")}
            onClick={props.onBack}
          />
        ) : undefined
      }
    >
      <form data-component="custom-provider-form" onSubmit={(event) => void submit(event)}>
        <p>{language.t("provider.custom.description")}</p>
        <TextField
          name="name"
          label={language.t("provider.custom.name")}
          value={store.name}
          onChange={(value) => setStore("name", value)}
          required
          autofocus
        />
        <TextField
          name="baseUrl"
          label="Base URL"
          placeholder="https://example.com/v1"
          value={store.baseUrl}
          onChange={(value) => setStore("baseUrl", value)}
          required
        />
        <TextField
          name="apiKey"
          type="password"
          label="API Key"
          placeholder={config ? language.t("provider.custom.keepKey") : "sk-…"}
          value={store.apiKey}
          onChange={(value) => setStore("apiKey", value)}
          autocomplete="off"
        />
        <Button
          type="button"
          variant="secondary"
          disabled={store.importing || !store.baseUrl}
          onClick={() => void importModels()}
        >
          {language.t(store.importing ? "provider.custom.importing" : "provider.custom.import")}
        </Button>
        <Show when={store.imported !== undefined}>
          <p role="status">{language.t("provider.custom.imported", { count: store.imported! })}</p>
        </Show>
        <TextField
          name="modelIds"
          multiline
          label={language.t("provider.custom.models")}
          value={store.modelIds}
          onChange={(value) => setStore("modelIds", value)}
          required
        />
        <div data-slot="model-limits">
          <TextField
            name="contextWindow"
            type="number"
            min="1"
            max="10000000"
            label={language.t("provider.custom.context")}
            value={store.contextWindow}
            onChange={(value) => setStore("contextWindow", value)}
            required
          />
          <TextField
            name="maxOutput"
            type="number"
            min="1"
            max={store.contextWindow}
            label={language.t("provider.custom.output")}
            value={store.maxOutput}
            onChange={(value) => setStore("maxOutput", value)}
            required
          />
        </div>
        <Show when={store.error}>
          <p role="alert">{store.error}</p>
        </Show>
        <Button type="submit" variant="primary" disabled={store.saving}>
          {language.t("common.save")}
        </Button>
      </form>
    </Dialog>
  )
}
