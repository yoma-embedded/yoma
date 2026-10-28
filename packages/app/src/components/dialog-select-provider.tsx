import { Component, Show } from "solid-js"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { Dialog } from "@yoma-desktop/ui/dialog"
import { List } from "@yoma-desktop/ui/list"
import { Tag } from "@yoma-desktop/ui/tag"
import { ProviderIcon } from "@yoma-desktop/ui/provider-icon"
import { Icon } from "@yoma-desktop/ui/icon"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { DialogCustomProvider } from "./dialog-custom-provider"
import { useLanguage } from "@/context/language"
import { createProviderCatalog, providerCategory, PROVIDER_CATEGORIES } from "./kernel-providers"
import "./provider-selection.css"

export const DialogSelectProvider: Component = () => {
  const language = useLanguage()
  const providers = createProviderCatalog()
  const dialog = useDialog()
  const back = () => dialog.replace(() => <DialogSelectProvider />)

  return (
    <Dialog title={language.t("command.provider.connect")} size="large" transition>
      <List
        class="provider-selection"
        search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.provider.empty")}
        key={(x) => x?.id}
        items={() => {
          language.locale()
          return [
            { id: "__custom__", name: language.t("provider.custom.title"), authenticated: false, models: [] },
            ...providers(),
          ]
        }}
        filterKeys={["id", "name"]}
        groupBy={providerCategory}
        sortGroupsBy={(a, b) =>
          PROVIDER_CATEGORIES.indexOf(a.category as (typeof PROVIDER_CATEGORIES)[number]) -
          PROVIDER_CATEGORIES.indexOf(b.category as (typeof PROVIDER_CATEGORIES)[number])
        }
        groupHeader={(group) =>
          language.t(`provider.category.${group.category as (typeof PROVIDER_CATEGORIES)[number]}`)
        }
        sortBy={(a, b) => (a.id === "__custom__" ? -1 : b.id === "__custom__" ? 1 : a.name.localeCompare(b.name))}
        onSelect={(x) => {
          if (!x) return
          if (providerCategory(x) === "custom")
            dialog.replace(() => <DialogCustomProvider provider={x.custom ? x : undefined} onBack={back} />)
          else dialog.replace(() => <DialogConnectProvider provider={x.id} onBack={back} />)
        }}
      >
        {(i) => (
          <>
            <span data-slot="provider-copy">
              <span>{i.name}</span>
              <span data-slot="provider-method">
                {providerCategory(i) === "custom"
                  ? "OpenAI Chat Completions"
                  : i.id === "openai-codex"
                    ? "ChatGPT · OAuth"
                    : "API Key"}
              </span>
              <Show when={i.authenticated}>
                <Tag>{language.t("provider.connected")}</Tag>
              </Show>
            </span>
            <Show when={providerCategory(i) !== "custom"} fallback={<Icon name="plus-small" />}>
              <ProviderIcon id={i.id} />
            </Show>
          </>
        )}
      </List>
    </Dialog>
  )
}
