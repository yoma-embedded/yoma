import "@pierre/trees/web-components"
import { FileTree } from "@pierre/trees"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@yoma-desktop/ui/v2/dialog-v2"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { TextInputV2 } from "@yoma-desktop/ui/v2/text-input-v2"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import {
  absoluteTreePath,
  activeTreeNavigation,
  advanceTreePreload,
  nextSuggestionIndex,
  nextTreeScrollTop,
  pickerFileSearchQuery,
  pickerAbsoluteInput,
  pickerMode,
  preloadTreeDirectories,
  cleanPickerInput,
  createPriorityTaskQueue,
  createDirectorySearch,
  currentPickerSuggestions,
  displayPickerPath,
  pickerParent,
  pickerRoot,
} from "./directory-picker-domain"
import "./dialog-select-file-tree.css"
import { DividerV2 } from "@yoma-desktop/ui/v2/divider-v2"

/**
 * 目录树里挑一个**文件**的对话框(mod+p 的"搜索文件",桌面端)。
 *
 * 它原来叫 DialogSelectDirectoryV2,一个组件两种模式:directory 模式是 opencode 的
 * 「浏览远端服务器的目录树」—— 那条路随多服务器一起删了(目录选择一律走系统原生框)。
 * 留下来的只有 file 模式,于是改名落实:`mode` / `multiple` / `server` 三个 prop 都没了。
 */
interface DialogSelectFileTreeProps {
  title?: string
  onSelect: (result: string | string[] | null) => void
  start?: string
}

export function DialogSelectFileTree(props: DialogSelectFileTreeProps) {
  const global = useGlobal()
  const { sync, sdk } = global.ctx
  const dialog = useDialog()
  const language = useLanguage()
  const policy = pickerMode("file", props.start)
  const [root, setRoot] = createSignal("")
  const [input, setInput] = createSignal("")
  const [selected, setSelected] = createSignal("")
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false)
  const [activeSuggestion, setActiveSuggestion] = createSignal(-1)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [rootValid, setRootValid] = createSignal(false)
  const listings = new Map<string, Promise<Array<{ name: string; type: "file" | "directory" }> | undefined>>()
  const loads = createPriorityTaskQueue<Array<{ name: string; type: "file" | "directory" }> | undefined>(3)
  const advanced = new Set<string>()
  let tree: FileTree | undefined
  let container: HTMLDivElement | undefined
  let pathArea: HTMLDivElement | undefined
  let navigation = 0

  // 内核不暴露用户家目录(app.info 里只有 version/enginesDir/sessionsRoot/node),
  // 所以 `~` 展开和 `~` 缩写显示一律走空串 —— domain 层对空 home 已经是 no-op。
  const home = () => ""
  const start = createMemo(() => props.start || sync.data.path.directory)
  const search = createDirectorySearch({ sdk, home, base: () => root() || start() })
  const [suggestions] = createResource(input, async (value) => {
    const typed = cleanPickerInput(value).replace(/\/+$/, "")
    const current = displayPickerPath(root(), value, home()).replace(/\/+$/, "")
    if (!typed || typed === current) return { query: value, items: [] }
    const directories = (await search(value)).map((absolute) => ({ absolute, type: "directory" as const }))
    if (!policy.includeFiles) return { query: value, items: directories.slice(0, 5) }
    const files = await sdk.client.file
      .search(root(), pickerFileSearchQuery(root(), value, home()), 20)
      .catch(() => [] as string[])
    const results = [
      ...directories,
      ...files.map((path) => ({ absolute: absoluteTreePath(root(), path), type: "file" as const })),
    ]
    return {
      query: value,
      items: Array.from(new Map(results.map((result) => [result.absolute, result])).values()).slice(0, 8),
    }
  })
  const currentSuggestions = createMemo(() => currentPickerSuggestions(suggestions(), input()))

  async function load(path: string, generation: number, eager = false) {
    const key = path.replace(/\/+$/, "")
    setError(false)
    const absolute = absoluteTreePath(root(), key)
    const existing = listings.get(key)
    if (existing && !eager) loads.promote(`${generation}:${key}`)
    const request =
      existing ??
      loads.schedule(`${generation}:${key}`, eager ? "background" : "user", () => {
        if (!activeTreeNavigation(generation, navigation)) return Promise.resolve(undefined)
        return sdk.client.file.list(absolute).catch(() => undefined)
      })
    listings.set(key, request)
    const nodes = await request
    if (!activeTreeNavigation(generation, navigation)) return false
    if (!nodes) {
      listings.delete(key)
      if (!key) setError(true)
      return false
    }
    tree?.batch(policy.entries(key, nodes).map((item) => ({ type: "add", path: item })))
    if (!eager && advanceTreePreload(advanced, key)) {
      for (const directory of preloadTreeDirectories(key, nodes)) void load(directory, generation, true)
    }
    return true
  }

  async function navigate(path: string) {
    const value = policy.navigation(pickerAbsoluteInput(cleanPickerInput(path), home(), root() || start() || home()))
    if (!value) return
    const token = ++navigation
    setLoading(true)
    setRootValid(false)
    setSelected("")
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
    setRoot(value)
    setInput(displayPickerPath(value, value, home()))
    listings.clear()
    advanced.clear()
    tree?.resetPaths([])
    const valid = await load("", token)
    if (!activeTreeNavigation(token, navigation)) return
    setRootValid(valid)
    setLoading(false)
  }

  function complete() {
    const items = currentSuggestions()
    const match = items[activeSuggestion()] ?? items[0]
    if (!match) return
    const value = displayPickerPath(match.absolute, input(), home())
    setInput(match.type === "directory" && !value.endsWith("/") ? value + "/" : value)
    if (match.type === "file") {
      setSelected(policy.selection(root(), pickerFileSearchQuery(root(), match.absolute, home())) ?? "")
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
    }
  }

  function chooseSuggestion(suggestion: { absolute: string; type: "file" | "directory" }) {
    if (suggestion.type === "directory") {
      void navigate(suggestion.absolute)
      return
    }
    setInput(displayPickerPath(suggestion.absolute, input(), home()))
    setSelected(policy.selection(root(), pickerFileSearchQuery(root(), suggestion.absolute, home())) ?? "")
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
  }

  function moveSuggestion(delta: -1 | 1) {
    setSuggestionsOpen(true)
    setActiveSuggestion((current) => nextSuggestionIndex(current, delta, currentSuggestions().length))
  }

  function activeSuggestionValue() {
    const items = currentSuggestions()
    return items[activeSuggestion()] ?? items[0]
  }

  const keyActions: Partial<Record<string, () => void>> = {
    ArrowDown: () => moveSuggestion(1),
    ArrowUp: () => moveSuggestion(-1),
    Enter: () => {
      const suggestion = activeSuggestionValue()
      if (suggestion) chooseSuggestion(suggestion)
      if (!suggestion) void navigate(input())
    },
    Tab: complete,
  }

  function handleInputKey(event: KeyboardEvent) {
    const action = keyActions[event.key]
    if (!action) return
    if (event.key === "Tab" && event.shiftKey) return
    event.preventDefault()
    action()
  }

  function resolve() {
    const path = policy.result(root(), selected(), rootValid())
    if (!path) return
    props.onSelect(path)
    dialog.close()
  }

  onMount(() => {
    const closeSuggestions = (event: PointerEvent) => {
      if (pathArea?.contains(event.target as Node)) return
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
    }
    document.addEventListener("pointerdown", closeSuggestions)
    onCleanup(() => document.removeEventListener("pointerdown", closeSuggestions))
    tree = new FileTree({
      paths: [],
      flattenEmptyDirectories: false,
      initialExpansion: "closed",
      stickyFolders: true,
      unsafeCSS: `
        button[data-type="item"] {
          background: transparent !important;
          box-shadow: none !important;
        }
        button[data-type="item"]:hover {
          background: var(--v2-overlay-simple-overlay-hover) !important;
        }
        button[data-type="item"]:focus-visible {
          outline: none !important;
          box-shadow: none !important;
        }
        [data-file-tree-virtualized-scroll] {
          overscroll-behavior: contain;
          scrollbar-width: thin;
        }
      `,
      onExpansionChange(change) {
        if (change.expanded) void load(change.path, navigation)
      },
      onSelectionChange(paths) {
        const path = paths.at(-1)
        setSelected(path ? (policy.selection(root(), path) ?? "") : "")
      },
    })
    if (!container) return
    tree.render({ containerWrapper: container })
    tree.getFileTreeContainer()?.classList.add("file-tree-picker-tree")
  })

  createEffect(() => {
    const path = start()
    if (!path || root()) return
    void navigate(path)
  })

  onCleanup(() => tree?.cleanUp())

  return (
    <Dialog size="large" class="file-tree-picker">
      <DialogHeader>
        <DialogTitle>{props.title ?? language.t("command.project.open")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="file-tree-picker-body pt-4!">
        <div class="file-tree-picker-path" ref={pathArea}>
          <TextInputV2
            value={input()}
            autofocus
            autocomplete="off"
            spellcheck={false}
            class="!w-full"
            onInput={(event) => {
              setInput(cleanPickerInput(event.currentTarget.value))
              setSelected("")
              setSuggestionsOpen(true)
              setActiveSuggestion(-1)
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen()}
            aria-controls="file-tree-picker-suggestions"
            aria-activedescendant={
              activeSuggestion() >= 0 ? `file-tree-picker-suggestion-${activeSuggestion()}` : undefined
            }
            onKeyDown={handleInputKey}
          />
          <div class="file-tree-picker-actions">
            <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(home())}>
              ~
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(pickerRoot(root()) || root())}>
              {language.t("dialog.directory.root")}
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(pickerParent(root()))}>
              {language.t("dialog.directory.parent")}
            </ButtonV2>
          </div>
          <Show when={suggestionsOpen() && currentSuggestions().length > 0}>
            <div id="file-tree-picker-suggestions" role="listbox" class="file-tree-picker-suggestions">
              <For each={currentSuggestions()}>
                {(suggestion, index) => (
                  <button
                    id={`file-tree-picker-suggestion-${index()}`}
                    role="option"
                    aria-selected={index() === activeSuggestion()}
                    data-active={index() === activeSuggestion() ? "" : undefined}
                    onPointerMove={() => setActiveSuggestion(index())}
                    onClick={() => chooseSuggestion(suggestion)}
                  >
                    {displayPickerPath(suggestion.absolute, input(), home())}
                    {suggestion.type === "directory" ? "/" : ""}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <div
          class="file-tree-picker-browser"
          ref={container}
          onWheel={(event) => {
            const scroller = tree
              ?.getFileTreeContainer()
              ?.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")
            if (!scroller) return
            const next = nextTreeScrollTop(
              scroller.scrollTop,
              event.deltaY,
              scroller.scrollHeight,
              scroller.clientHeight,
            )
            if (next === scroller.scrollTop) return
            event.preventDefault()
            scroller.scrollTop = next
            scroller.dispatchEvent(new Event("scroll"))
          }}
        >
          <Show when={loading()}>
            <div class="file-tree-picker-state">{language.t("common.loading")}</div>
          </Show>
          <Show when={!loading() && error()}>
            <div class="file-tree-picker-state">{language.t("dialog.directory.readError")}</div>
          </Show>
        </div>
        <div class="file-tree-picker-selection">{policy.result(root(), selected(), rootValid())}</div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!policy.result(root(), selected(), rootValid())} onClick={resolve}>
          {language.t("dialog.directory.action.selectFile")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
