/** API key setup and Pi-native ChatGPT subscription login. */

import { Button } from "@yoma-desktop/ui/button"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { Dialog } from "@yoma-desktop/ui/dialog"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { ProviderIcon } from "@yoma-desktop/ui/provider-icon"
import { TextField } from "@yoma-desktop/ui/text-field"
import { createMemo, Show } from "solid-js"
import { ProviderSubscriptionLogin } from "./provider-subscription-login"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { kernel } from "@/utils/kernel"
import { createProviderCatalog, invalidateProviders } from "./kernel-providers"

export function DialogConnectProvider(props: { provider: string; onBack?: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const providers = createProviderCatalog()

  const name = createMemo(() => providers().find((item) => item.id === props.provider)?.name ?? props.provider)

  const [store, setStore] = createStore({
    value: "",
    error: undefined as string | undefined,
    saving: false,
  })

  const back = () => {
    if (props.onBack) return props.onBack()
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const apiKey = store.value.trim()
    if (!apiKey) {
      setStore("error", language.t("provider.connect.apiKey.required"))
      return
    }

    setStore({ error: undefined, saving: true })
    try {
      await kernel.model.setAuth(props.provider, apiKey)
      invalidateProviders()
      dialog.close()
    } catch (err) {
      setStore({
        saving: false,
        error: err instanceof Error ? err.message : language.t("common.requestFailed"),
      })
    }
  }

  return (
    <Dialog
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={back}
          aria-label={language.t("common.goBack")}
        />
      }
    >
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id={props.provider} class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">
            {language.t("provider.connect.title", { provider: name() })}
          </div>
        </div>
        <div class="px-2.5 pb-10 flex flex-col gap-6">
          <Show
            when={props.provider === "openai-codex"}
            fallback={
              <>
                <div class="text-14-regular text-text-base">
                  {language.t("provider.connect.apiKey.description", { provider: name() })}
                </div>
                <form onSubmit={(event) => void submit(event)} class="flex flex-col items-start gap-4">
                  <TextField
                    autofocus
                    type="text"
                    label={language.t("provider.connect.apiKey.label", { provider: name() })}
                    placeholder={language.t("provider.connect.apiKey.placeholder")}
                    name="apiKey"
                    value={store.value}
                    onChange={(value) => setStore("value", value)}
                    validationState={store.error ? "invalid" : undefined}
                    error={store.error}
                  />
                  <Button class="w-auto" type="submit" size="large" variant="primary" disabled={store.saving}>
                    {language.t("common.continue")}
                  </Button>
                </form>
              </>
            }
          >
            <ProviderSubscriptionLogin connected={() => dialog.close()} />
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
