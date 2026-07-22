import { For, Match, Show, Switch, createEffect, createMemo, on, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@yoma-desktop/ui/tabs"
import { Icon, type IconProps } from "@yoma-desktop/ui/icon"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@yoma-desktop/ui/tooltip"
import { ResizeHandle } from "@yoma-desktop/ui/resize-handle"
import { Mark } from "@yoma-desktop/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@yoma-desktop/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSettings } from "@/context/settings"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import {
  createOpenSessionFileTab,
  createSessionTabs,
  getTabReorderIndex,
  type Sizing,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { DebugContent, CmdMock } from "@/pages/session/debug/debug-content"
import { debug as dock, type DockMode } from "@/pages/session/debug/debug-data"

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff

function renderDiff(value: SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

/** 顶栏图标按钮：激活态为浅色圆角底（同参考稿），风格沿用现有 token */
function BarButton(props: {
  icon: IconProps["name"]
  title: string
  on?: boolean
  label?: string
  onClick: () => void
}) {
  return (
    <Tooltip placement="bottom" value={props.title}>
      <button
        type="button"
        class="h-6 min-w-7 px-1.5 rounded-md flex items-center justify-center gap-1 shrink-0"
        classList={{
          "bg-background-stronger": !!props.on,
          "text-text-weak hover:bg-background-stronger": !props.on,
        }}
        onClick={() => props.onClick()}
        aria-label={props.title}
        aria-pressed={props.on ? "true" : "false"}
      >
        <Icon name={props.icon} size="small" />
        <Show when={props.label}>
          <span class="text-12-regular">{props.label}</span>
        </Show>
      </button>
    </Tooltip>
  )
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const settings = useSettings()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { sessionKey, tabs, view, params } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  // ---- 模式与旧布局状态同步 ------------------------------------------------
  // 旧的 header 开关/快捷键仍写 view().reviewPanel / layout.fileTree；
  // 这里单向同步到 dock（打开→切模式），dock 侧切模式时回写 reviewPanel，
  // 保证 changes 模式下中间栏宽度联动（sessionPanelWidth）与原来一致。
  createEffect(
    on(
      () => view().reviewPanel.opened(),
      (opened) => {
        if (opened) {
          dock.open()
          dock.setMode("changes")
        }
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => layout.fileTree.opened(),
      (opened) => {
        if (opened) {
          dock.open()
          dock.setMode("file")
        }
      },
      { defer: true },
    ),
  )

  const switchMode = (m: DockMode) => {
    dock.open()
    dock.setMode(m)
    if (m === "changes") {
      if (!view().reviewPanel.opened()) view().reviewPanel.open()
    } else if (view().reviewPanel.opened()) {
      view().reviewPanel.close()
    }
  }

  const hidePanel = () => {
    dock.close()
    view().reviewPanel.close()
    layout.fileTree.close()
  }

  const open = createMemo(() => dock.opened())
  const wide = createMemo(() => dock.fullscreen() || dock.mode() === "changes")
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (wide()) return "auto"
    return `${dock.width()}px`
  })

  // ---- 原有数据管线（diff / 文件树 / 标签页）保持不变 ----------------------
  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    // 打开文件标签时切到 changes 模式（文件标签栏在那里）
    openReviewPanel: () => switchMode("changes"),
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: () => isDesktop(),
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const openFileDialog = () => {
    void import("@/components/dialog-select-file").then((x) => {
      dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
    })
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop() && !(settings.general.newLayoutDesigns() && !params.id)}>
      <Show
        when={open()}
        fallback={
          <div class="h-full w-9 shrink-0 flex flex-col items-center pt-1.5 bg-background-base"
            classList={{
              "border-l border-border-weaker-base": !settings.general.newLayoutDesigns(),
              "rounded-[10px] shadow-[var(--v2-elevation-raised)]": settings.general.newLayoutDesigns(),
            }}
          >
            <Tooltip placement="left" value="展开右侧栏">
              <IconButton
                icon="layout-right"
                variant="ghost"
                onClick={() => dock.open()}
                aria-label="展开右侧栏"
              />
            </Tooltip>
          </div>
        }
      >
        <aside
          id="review-panel"
          aria-label={language.t("session.panel.reviewAndFiles")}
          class="relative min-w-0 h-full flex flex-col shrink-0 overflow-hidden bg-background-base"
          classList={{
            "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
              !props.size.active() && !props.reviewSnap,
            "rounded-[10px] shadow-[var(--v2-elevation-raised)]": settings.general.newLayoutDesigns(),
            "border-l border-border-weaker-base": !settings.general.newLayoutDesigns(),
            "flex-1": wide(),
          }}
          style={{ width: panelWidth() }}
        >
          <Show when={!wide()}>
            <div onPointerDown={() => props.size.start()}>
              <ResizeHandle
                direction="horizontal"
                edge="start"
                size={dock.width()}
                min={300}
                max={typeof window === "undefined" ? 720 : Math.max(400, window.innerWidth - 450)}
                onResize={(width) => {
                  props.size.touch()
                  dock.setWidth(width)
                }}
              />
            </div>
          </Show>

          {/* 顶部图标栏：changes / 调试 / cmd / file ·· ＋ / 全屏 / 收起 */}
          <div class="h-9 shrink-0 flex items-center gap-0.5 px-1.5 border-b border-border-weaker-base">
            <BarButton
              icon="review"
              title={language.t("session.tab.review")}
              on={dock.mode() === "changes"}
              onClick={() => switchMode("changes")}
            />
            <BarButton icon="debug" title="调试" on={dock.mode() === "debug"} onClick={() => switchMode("debug")} />
            <BarButton
              icon="terminal"
              title="终端"
              label="cmd"
              on={dock.mode() === "cmd"}
              onClick={() => switchMode("cmd")}
            />
            <BarButton
              icon="file-tree"
              title={language.t("session.files.all")}
              on={dock.mode() === "file"}
              onClick={() => switchMode("file")}
            />
            <div class="flex-1" />
            <BarButton icon="plus-small" title={language.t("command.file.open")} onClick={openFileDialog} />
            <BarButton
              icon={dock.fullscreen() ? "collapse" : "expand"}
              title={dock.fullscreen() ? "退出全屏" : "全屏"}
              onClick={() => dock.toggleFullscreen()}
            />
            <BarButton icon="layout-right" title="收起右侧栏" onClick={hidePanel} />
          </div>

          <Switch>
            {/* -------- changes：原审查/文件标签页机制，原样保留 -------- */}
            <Match when={dock.mode() === "changes"}>
              <div class="relative min-w-0 flex-1 min-h-0 overflow-hidden bg-background-base">
                <div class="size-full min-w-0 h-full bg-background-base">
                  <DragDropProvider
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragOver={handleDragOver}
                    collisionDetector={closestCenter}
                  >
                    <DragDropSensors />
                    <ConstrainDragYAxis />
                    <Tabs value={activeTab()} onChange={openTab}>
                      <div class="sticky top-0 shrink-0 flex">
                        <Tabs.List
                          ref={(el: HTMLDivElement) => {
                            const stop = createFileTabListSync({ el, contextOpen })
                            onCleanup(stop)
                          }}
                        >
                          <Show when={props.canReview()}>
                            <Tabs.Trigger value="review">
                              <div class="flex items-center gap-1.5">
                                <div>{language.t("session.tab.review")}</div>
                                <Show when={props.hasReview()}>
                                  <div>{props.reviewCount()}</div>
                                </Show>
                              </div>
                            </Tabs.Trigger>
                          </Show>
                          <Show when={contextOpen()}>
                            <Tabs.Trigger
                              value="context"
                              closeButton={
                                <TooltipKeybind
                                  title={language.t("common.closeTab")}
                                  keybind={command.keybind("tab.close")}
                                  placement="bottom"
                                  gutter={10}
                                >
                                  <IconButton
                                    icon="close-small"
                                    variant="ghost"
                                    class="h-5 w-5"
                                    onClick={() => tabs().close("context")}
                                    aria-label={language.t("common.closeTab")}
                                  />
                                </TooltipKeybind>
                              }
                              hideCloseButton
                              onMiddleClick={() => tabs().close("context")}
                            >
                              <div class="flex items-center gap-2">
                                <SessionContextUsage variant="indicator" />
                                <div>{language.t("session.tab.context")}</div>
                              </div>
                            </Tabs.Trigger>
                          </Show>
                          <SortableProvider ids={openedTabs()}>
                            <For each={openedTabs()}>
                              {(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}
                            </For>
                          </SortableProvider>
                        </Tabs.List>
                      </div>

                      <Show when={props.canReview()}>
                        <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                        </Tabs.Content>
                      </Show>

                      <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "empty"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                              <Mark class="w-14 opacity-10" />
                              <div class="text-14-regular text-text-weak max-w-56">
                                {language.t("session.files.selectToOpen")}
                              </div>
                            </div>
                          </div>
                        </Show>
                      </Tabs.Content>

                      <Show when={contextOpen()}>
                        <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "context"}>
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <SessionContextTab />
                            </div>
                          </Show>
                        </Tabs.Content>
                      </Show>

                      <Show when={activeFileTab()} keyed>
                        {(tab) => <FileTabContent tab={tab} />}
                      </Show>
                    </Tabs>
                    <DragOverlay>
                      <Show when={store.activeDraggable} keyed>
                        {(tab) => {
                          const path = file.pathFromTab(tab)
                          return (
                            <div data-component="tabs-drag-preview">
                              <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                            </div>
                          )
                        }}
                      </Show>
                    </DragOverlay>
                  </DragDropProvider>
                </div>
              </div>
            </Match>

            {/* -------- file：原文件树（changes / all），占满面板宽 -------- */}
            <Match when={dock.mode() === "file"}>
              <div class="flex-1 min-h-0 flex flex-col overflow-hidden group/filetree">
                <Tabs variant="pill" value={fileTreeTab()} onChange={setFileTreeTabValue} class="h-full" data-scope="filetree">
                  <Tabs.List>
                    <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                      {props.reviewCount()}{" "}
                      {language.t(
                        props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                      )}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                      {language.t("session.files.all")}
                    </Tabs.Trigger>
                  </Tabs.List>
                  <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                    <Switch>
                      <Match when={props.hasReview() || !props.diffsReady()}>
                        <Show
                          when={props.diffsReady()}
                          fallback={
                            <div class="px-2 py-2 text-12-regular text-text-weak">
                              {language.t("common.loading")}
                              {language.t("common.loading.ellipsis")}
                            </div>
                          }
                        >
                          <FileTree
                            path=""
                            class="pt-3"
                            allowed={diffFiles()}
                            kinds={kinds()}
                            draggable={false}
                            active={props.activeDiff}
                            onFileClick={(node) => {
                              switchMode("changes")
                              props.focusReviewDiff(node.path)
                            }}
                          />
                        </Show>
                      </Match>
                      <Match when={true}>{empty(props.empty())}</Match>
                    </Switch>
                  </Tabs.Content>
                  <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                    <Switch>
                      <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                      <Match when={true}>
                        <FileTree
                          path=""
                          class="pt-3"
                          modified={diffFiles()}
                          kinds={kinds()}
                          onFileClick={(node) => openTab(file.tab(node.path))}
                        />
                      </Match>
                    </Switch>
                  </Tabs.Content>
                </Tabs>
              </div>
            </Match>

            {/* -------- 调试：仪器大窗口堆叠（模拟数据） -------- */}
            <Match when={dock.mode() === "debug"}>
              <div class="ydbg flex-1 min-h-0 overflow-y-auto px-3 py-3">
                <DebugContent />
              </div>
            </Match>

            {/* -------- cmd：模拟终端 -------- */}
            <Match when={dock.mode() === "cmd"}>
              <div class="ydbg flex-1 min-h-0 overflow-y-auto px-3 py-3">
                <CmdMock />
              </div>
            </Match>
          </Switch>
        </aside>
      </Show>
    </Show>
  )
}
