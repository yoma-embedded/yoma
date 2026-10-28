/**
 * 模型选择器。
 *
 * 目录改成从 `kernel.model.list()` 读 —— 不再走 opencode 的 config/provider 下发,
 * 也没有 `release_date` / `family` 推导出来的 "latest" 标签、没有 opencode zen 的免费标记、
 * 设置页的模型开关决定哪些模型出现在选择器中。
 *
 * 思考强度由 composer 的专用下拉管理,此处只选模型。
 */

import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, JSX, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { Button } from "@yoma-desktop/ui/button"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { Dialog } from "@yoma-desktop/ui/dialog"
import { List } from "@yoma-desktop/ui/list"
import { Tooltip } from "@yoma-desktop/ui/tooltip"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { createProviderCatalog, flattenModels, type CatalogModel } from "./kernel-providers"

type ModelState = ReturnType<typeof useLocal>["model"]

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()
  const providers = createProviderCatalog()

  const models = createMemo(() =>
    flattenModels(providers()).filter(
      (m) =>
        (!props.provider || m.provider.id === props.provider) &&
        model.visible({ providerID: m.provider.id, modelID: m.id }),
    ),
  )

  const selected = createMemo(() => {
    const current = model.current()
    if (!current) return
    return models().find((m) => m.id === current.id && m.provider.id === current.provider.id)
  })

  return (
    <>
      <List
        class={`flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
        search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
        emptyMessage={language.t("dialog.model.empty")}
        key={(x) => `${x.provider.id}:${x.id}`}
        items={models}
        current={selected()}
        filterKeys={["provider.name", "name", "id"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        groupBy={(x) => x.provider.name}
        itemWrapper={(item, node) => (
          <Tooltip
            class="w-full"
            placement="right-start"
            gutter={12}
            openDelay={0}
            value={<ModelTooltip model={item} />}
          >
            {node}
          </Tooltip>
        )}
        onSelect={(x: CatalogModel | undefined) => {
          model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
            recent: true,
          })
          props.onSelect()
        }}
      >
        {(i) => (
          <div class="w-full flex items-center gap-x-2 text-13-regular">
            <span class="truncate">{i.name}</span>
          </div>
        )}
      </List>
    </>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "provider"

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleConnectProvider = () => {
    close("provider")
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-80 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            onSelect={() => close("select")}
            class="p-1"
            action={
              <Tooltip placement="top" value={language.t("command.provider.connect")}>
                <IconButton
                  icon="plus-small"
                  variant="ghost"
                  iconSize="normal"
                  class="size-6"
                  aria-label={language.t("command.provider.connect")}
                  onClick={handleConnectProvider}
                />
              </Tooltip>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const provider = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
    </Dialog>
  )
}
