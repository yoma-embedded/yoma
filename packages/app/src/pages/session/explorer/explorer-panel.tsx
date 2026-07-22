/**
 * 右栏 file 模式 —— Cursor 风格资源管理器。
 *
 * 布局：工具栏（树开关 / 搜索 / 前进后退 / 面包屑 / md 预览切换 / 更多菜单）
 *      + 左侧工作区文件树（宽度沿用 layout.fileTree.width 持久化）
 *      + 右侧编辑器（explorer-editor），空态给 打开文件 / 新建文件 两个入口。
 */
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Icon, type IconProps } from "@yoma-desktop/ui/icon"
import { FileIcon } from "@yoma-desktop/ui/file-icon"
import { Tooltip } from "@yoma-desktop/ui/tooltip"
import { ResizeHandle } from "@yoma-desktop/ui/resize-handle"
import { DropdownMenu } from "@yoma-desktop/ui/dropdown-menu"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@yoma-desktop/ui/v2/dialog-v2"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { TextInputV2 } from "@yoma-desktop/ui/v2/text-input-v2"
import { getFilename } from "@yoma-desktop/util/path"
import FileTree from "@/components/file-tree"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { createExplorerActions, type ExplorerActions } from "./explorer-actions"
import { explorerScope, isMarkdownPath, type ExplorerScope } from "./explorer-state"
import { ExplorerFileView } from "./explorer-editor"
import "./explorer.css"

function ToolButton(props: {
  icon: IconProps["name"]
  title: string
  on?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip placement="bottom" value={props.title}>
      <button
        type="button"
        class="h-6 min-w-7 px-1.5 rounded-md flex items-center justify-center shrink-0 disabled:opacity-40 disabled:pointer-events-none"
        classList={{
          "bg-background-stronger": !!props.on,
          "text-text-weak hover:bg-background-stronger": !props.on,
        }}
        disabled={props.disabled}
        onClick={() => props.onClick()}
        aria-label={props.title}
      >
        <Icon name={props.icon} size="small" />
      </button>
    </Tooltip>
  )
}

function NewFileDialog(props: { onCreate: (path: string) => Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const canCreate = createMemo(() => Boolean(name().trim()) && !busy())

  async function create() {
    if (!canCreate()) return
    setBusy(true)
    setError("")
    try {
      await props.onCreate(name())
      dialog.close()
    } catch (err) {
      const message = err instanceof Error ? err.message : ""
      setError(message.includes("EEXIST") ? language.t("explorer.newFile.exists") : message || language.t("explorer.newFile.createError"))
      setBusy(false)
    }
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("explorer.newFile")}
          description={language.t("explorer.newFile.desc")}
        />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-3 px-4 pb-4">
        <TextInputV2
          value={name()}
          appearance="large"
          class="!w-full"
          placeholder={language.t("explorer.newFile.placeholder")}
          autofocus
          spellcheck={false}
          autocomplete="off"
          invalid={Boolean(error())}
          onInput={(event) => {
            setName(event.currentTarget.value)
            setError("")
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            void create()
          }}
        />
        <Show when={error()}>
          <span class="text-[12px] text-v2-state-fg-danger">{error()}</span>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!canCreate()} onClick={() => void create()}>
          {language.t("explorer.newFile.create")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

function Breadcrumbs(props: { path: string; dirty: boolean; actions: ExplorerActions }) {
  const segments = createMemo(() => props.path.split(/[\\/]/).filter(Boolean))
  const dirs = createMemo(() =>
    segments()
      .slice(0, -1)
      .map((name, index) => ({
        name,
        path: segments()
          .slice(0, index + 1)
          .join("/"),
      })),
  )
  const filename = createMemo(() => segments()[segments().length - 1] ?? props.path)

  return (
    <div class="min-w-0 flex items-center gap-0.5 text-12-regular text-text-weak">
      <For each={dirs()}>
        {(dir) => (
          <>
            <button
              type="button"
              class="shrink min-w-0 truncate hover:text-text-strong"
              onClick={() => props.actions.revealInTree(dir.path)}
              title={dir.path}
            >
              {dir.name}
            </button>
            <Icon name="chevron-right" size="small" class="shrink-0 text-icon-weak" />
          </>
        )}
      </For>
      <FileIcon node={{ path: props.path, type: "file" }} class="shrink-0 size-3.5" />
      <span class="text-12-medium text-text-strong truncate" title={props.path}>
        {filename()}
      </span>
      <Show when={props.dirty}>
        <span class="exp-dirty-dot" title="●" aria-label="unsaved" />
      </Show>
    </div>
  )
}

export function ExplorerPanel(props: {
  modified?: readonly string[]
  kinds?: ReadonlyMap<string, "add" | "del" | "mix">
}) {
  const sdk = useSDK()
  const file = useFile()
  const language = useLanguage()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()

  const directory = createMemo(() => sdk().directory)
  const scope = createMemo<ExplorerScope>(() => explorerScope(directory()))
  const actions = createExplorerActions({
    scope: () => scope(),
    directory,
    file,
    platform,
    language,
  })

  const openPath = () => scope().openPath()
  const buffer = () => {
    const path = openPath()
    return path ? scope().buffer(path) : undefined
  }

  const openFile = (path: string, options?: { history?: boolean }) => {
    const normalized = file.normalize(path)
    if (!normalized) return
    const current = scope()
    if (options?.history !== false) current.push(normalized)
    current.setOpenPath(normalized)
    void file.load(normalized)
  }

  const goBack = () => {
    const path = scope().step(-1)
    if (path === undefined) return
    scope().setOpenPath(path)
    void file.load(path)
  }

  const goForward = () => {
    const path = scope().step(1)
    if (path === undefined) return
    scope().setOpenPath(path)
    void file.load(path)
  }

  const openSearch = () => {
    void import("@/components/dialog-select-file").then((x) => {
      dialog.show(() => <x.DialogSelectFile mode="files" openFile={(path) => openFile(path)} />)
    })
  }

  const openNewFile = () => {
    dialog.show(() => (
      <NewFileDialog
        onCreate={async (raw) => {
          const rel = await actions.createFile(raw)
          openFile(rel)
        }}
      />
    ))
  }

  const rootName = createMemo(() => getFilename(directory()) || directory())
  const markdown = createMemo(() => {
    const path = openPath()
    return path ? isMarkdownPath(path) : false
  })
  const markdownView = () => {
    const path = openPath()
    return path ? scope().markdownView(path) : "markdown"
  }
  const setMarkdownView = (view: "preview" | "markdown") => {
    const path = openPath()
    if (path) scope().setMarkdownViewFor(path, view)
  }

  // 有未保存修改时拦一次关闭（缓冲只在内存里）
  if (typeof window !== "undefined") {
    makeEventListener(window, "beforeunload", (event) => {
      if (scope().dirtyPaths().length === 0) return
      event.preventDefault()
      event.returnValue = ""
    })
  }

  const withOpenPath = (action: (path: string) => void) => () => {
    const path = openPath()
    if (path) action(path)
  }

  const menu = (): JSX.Element => (
    <DropdownMenu gutter={4} placement="bottom-end">
      <DropdownMenu.Trigger
        as={IconButton}
        icon="dot-grid"
        variant="ghost"
        size="small"
        class="size-6 rounded-md shrink-0"
        aria-label={language.t("common.moreOptions")}
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <DropdownMenu.Item disabled={!buffer()?.dirty} onSelect={withOpenPath((path) => void actions.save(path))}>
            <DropdownMenu.ItemLabel>{language.t("explorer.save")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={!openPath()} onSelect={withOpenPath((path) => actions.revealInTree(path))}>
            <DropdownMenu.ItemLabel>{language.t("explorer.revealInTree")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={!openPath()} onSelect={withOpenPath((path) => actions.copyPath(path))}>
            <DropdownMenu.ItemLabel>{language.t("explorer.copyPath")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={!openPath()}
            onSelect={withOpenPath((path) => actions.copyPath(path, { relative: true }))}
          >
            <DropdownMenu.ItemLabel>{language.t("explorer.copyRelativePath")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={!openPath()} onSelect={withOpenPath((path) => actions.reload(path))}>
            <DropdownMenu.ItemLabel>{language.t("explorer.reload")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={openNewFile}>
            <DropdownMenu.ItemLabel>{language.t("explorer.newFile")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )

  return (
    <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* 工具栏 */}
      <div class="h-9 shrink-0 flex items-center gap-0.5 px-1.5 border-b border-border-weaker-base">
        <ToolButton
          icon="bullet-list"
          title={language.t("explorer.toggleTree")}
          on={scope().treeVisible()}
          onClick={() => scope().setTreeVisible(!scope().treeVisible())}
        />
        <ToolButton icon="magnifying-glass" title={language.t("explorer.search")} onClick={openSearch} />
        <ToolButton
          icon="arrow-left"
          title={language.t("explorer.back")}
          disabled={!scope().canBack()}
          onClick={goBack}
        />
        <ToolButton
          icon="arrow-right"
          title={language.t("explorer.forward")}
          disabled={!scope().canForward()}
          onClick={goForward}
        />

        <div class="flex-1 min-w-0 h-full px-2 flex items-center justify-center">
          <Show when={openPath()} keyed>
            {(path) => <Breadcrumbs path={path} dirty={!!buffer()?.dirty} actions={actions} />}
          </Show>
        </div>

        <Show when={markdown()}>
          <div class="h-6 shrink-0 flex items-center gap-0.5 rounded-md bg-background-stronger p-0.5">
            <button
              type="button"
              class="h-5 px-2 rounded text-12-regular"
              classList={{
                "bg-background-base text-text-strong": markdownView() === "preview",
                "text-text-weak hover:text-text-strong": markdownView() !== "preview",
              }}
              onClick={() => setMarkdownView("preview")}
            >
              {language.t("explorer.preview")}
            </button>
            <button
              type="button"
              class="h-5 px-2 rounded text-12-regular"
              classList={{
                "bg-background-base text-text-strong": markdownView() === "markdown",
                "text-text-weak hover:text-text-strong": markdownView() !== "markdown",
              }}
              onClick={() => setMarkdownView("markdown")}
            >
              {language.t("explorer.markdown")}
            </button>
          </div>
        </Show>

        {menu()}
      </div>

      {/* 主体：树 + 编辑器 */}
      <div class="flex-1 min-h-0 flex overflow-hidden">
        <Show when={scope().treeVisible()}>
          <div
            class="relative shrink-0 h-full flex flex-col border-r border-border-weaker-base group/filetree"
            style={{ width: `${layout.fileTree.width()}px` }}
          >
            <div class="h-7 shrink-0 px-3 flex items-center text-12-medium text-text-weak">
              <span class="truncate" title={directory()}>
                {rootName()}
              </span>
            </div>
            <div class="exp-tree flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
              <FileTree
                path=""
                class="px-2 pb-8"
                modified={props.modified}
                kinds={props.kinds}
                active={openPath()}
                onFileClick={(node) => openFile(node.path)}
              />
            </div>
            <ResizeHandle
              direction="horizontal"
              edge="end"
              size={layout.fileTree.width()}
              min={170}
              max={480}
              onResize={(width) => layout.fileTree.resize(width)}
            />
          </div>
        </Show>

        <div class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          <Show
            when={openPath()}
            keyed
            fallback={
              <div class="flex-1 min-h-0 flex items-center justify-center">
                <div class="flex items-center gap-3">
                  <button type="button" class="exp-cta" onClick={openSearch}>
                    {language.t("explorer.openFile")}
                  </button>
                  <button type="button" class="exp-cta" onClick={openNewFile}>
                    {language.t("explorer.newFile")}
                  </button>
                </div>
              </div>
            }
          >
            {(path) => (
              <ExplorerFileView path={path} scope={scope()} actions={actions} directory={directory()} />
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
