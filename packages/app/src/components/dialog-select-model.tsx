/**
 * 模型选择器。
 *
 * 目录改成从 `kernel.model.list()` 读 —— 不再走 opencode 的 config/provider 下发,
 * 也没有 `release_date` / `family` 推导出来的 "latest" 标签、没有 opencode zen 的免费标记、
 * 没有模型可见性管理(那是为几百个模型的目录设计的,my-pi 的目录只有已配置凭据的 provider)。
 *
 * 新增的是 **thinking 档位**:`ModelInfo.thinkingLevels` 是内核真有而 opencode 没有的能力,
 * 选中的档位存在 local 的 variant 通道里(同一个概念,opencode 叫 variant,内核叫 thinking),
 * 由 composer 在发起一轮时随 `session.setModel` 一起下发。
 */

import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, For, JSX, Show, ValidComponent } from "solid-js"
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

/** 当前选中模型支持的 thinking 档位。没有档位的模型整块不渲染。 */
const ThinkingLevels: Component<{ levels: string[]; model: ModelState }> = (props) => {
  const language = useLanguage()
  const current = () => props.model.variant.current()

  return (
    <Show when={props.levels.length > 0}>
      <div
        class="flex items-center gap-1 flex-wrap px-4 pt-2"
        title={language.t("command.model.variant.cycle.description")}
      >
        <For each={props.levels}>
          {(level) => (
            <Button
              size="small"
              variant={current() === level ? "primary" : "ghost"}
              onClick={() => props.model.variant.set(level)}
            >
              {level}
            </Button>
          )}
        </For>
      </div>
    </Show>
  )
}

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
    flattenModels(providers()).filter((m) => (props.provider ? m.provider.id === props.provider : true)),
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
      <ThinkingLevels levels={selected()?.thinkingLevels ?? []} model={model} />
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
