/**
 * 挑一个 provider 去连接。
 *
 * 目录来自 `kernel.model.list()`。自定义 provider(npm 包 + baseURL + 手写模型表)整条
 * 删掉了 —— 那是 opencode config 的能力,my-pi 没有配置服务。
 */

import { Component, Show } from "solid-js"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { Dialog } from "@yoma-desktop/ui/dialog"
import { List } from "@yoma-desktop/ui/list"
import { Tag } from "@yoma-desktop/ui/tag"
import { ProviderIcon } from "@yoma-desktop/ui/provider-icon"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { useLanguage } from "@/context/language"
import { createProviderCatalog } from "./kernel-providers"

export const DialogSelectProvider: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const providers = createProviderCatalog()

  return (
    <Dialog title={language.t("command.provider.connect")} transition>
      <List
        class="px-3"
        search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.provider.empty")}
        activeIcon="plus-small"
        key={(x) => x?.id}
        items={() => {
          language.locale()
          return providers()
        }}
        filterKeys={["id", "name"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onSelect={(x) => {
          if (!x) return
          dialog.show(() => <DialogConnectProvider provider={x.id} />)
        }}
      >
        {(i) => (
          <div class="px-1.25 w-full flex items-center gap-x-3">
            <ProviderIcon data-slot="list-item-extra-icon" id={i.id} />
            <span>{i.name}</span>
            <Show when={i.authenticated}>
              <Tag>{language.t("provider.connect.method.apiKey")}</Tag>
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
