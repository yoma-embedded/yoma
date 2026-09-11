import { For, Match, Show, Switch, createEffect, createMemo, on, onCleanup } from "solid-js"
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
import type { FileDiff } from "@yoma-desktop/kernel"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@yoma-desktop/ui/context/dialog"

import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
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
import { DebugContent } from "@/pages/session/debug/debug-content"
import { debug as dock, type DockMode } from "@/pages/session/debug/debug-data"
import { ExplorerPanel } from "@/pages/session/explorer/explorer-panel"
import { explorerScope } from "@/pages/session/explorer/explorer-state"
import { getFilenameTruncated } from "@yoma-desktop/util/path"

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
  /** 工作区未提交改动 —— 只用来给资源管理器的文件挂"改过"角标 */
  diffs: () => FileDiff[]
  /** 右栏刚开/刚关的那一帧:别让宽度动画追着跑 */
  snap: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const sdk = useSDK()
  const { sessionKey, tabs, view, params } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  // ---- 模式与旧布局状态同步 ------------------------------------------------
  // 「打开某个文件」的入口(mod+k 文件搜索、输入框里的文件/评论条目)写的是
  // view().reviewPanel —— 审查页拆掉之后那一位就是"右栏开着没开",打开即切到文件标签页。
  // dock 侧切模式时回写它,保证中间栏宽度联动(sessionPanelWidth)与原来一致。
  createEffect(
    on(
      () => view().reviewPanel.opened(),
      (opened) => {
        if (opened) {
          dock.open()
          dock.setMode("tabs")
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
    if (m === "tabs") {
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
  // 三个子页共用同一个宽度（layout.dock.width）：切页只换内容，不换宽度。
  // 只有全屏才让面板吃掉整行（此时中间会话栏被 session.tsx 隐藏）。
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (dock.fullscreen()) return "auto"
    return `${layout.dock.width()}px`
  })

  let panelEl: HTMLElement | undefined
  /** 拖宽上限：按面板所在这一行的实际宽度算，给中间会话栏至少留 450px */
  const maxWidth = () => {
    const row = panelEl?.parentElement?.clientWidth ?? (typeof window === "undefined" ? 1200 : window.innerWidth)
    return Math.max(400, row - 450)
  }

  // ---- 原有数据管线（diff / 文件树 / 标签页）保持不变 ----------------------
  const diffs = createMemo(() => props.diffs())
  const diffFiles = createMemo(() => diffs().map((d) => d.path))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.path)
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

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    // 打开文件标签时切到文件标签页（标签栏在那里）
    openReviewPanel: () => switchMode("tabs"),
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const fileTreeTab = () => layout.fileTree.tab()

  /** file 模式按钮上显示当前打开的文件名（参考稿：第四个 tab 即文件页签） */
  const explorerFile = createMemo(() => {
    const path = explorerScope(sdk().directory).openPath()
    if (!path) return undefined
    return getFilenameTruncated(path, 18)
  })

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
    <Show when={isDesktop() && !!params.id}>
      <Show
        when={open()}
        fallback={
          <div class="h-full w-9 shrink-0 flex flex-col items-center pt-1.5 bg-background-base"
            classList={{
              "rounded-[10px] shadow-[var(--v2-elevation-raised)]": true,
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
          // id 是样式挂钩:ui/components/tabs.css 用 #review-panel 认这条标签栏,别改名。
          id="review-panel"
          ref={(el: HTMLElement) => (panelEl = el)}
          aria-label={language.t("session.panel.title")}
          class="relative min-w-0 h-full flex flex-col shrink-0 overflow-hidden bg-background-base"
          classList={{
            "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
              !props.size.active() && !props.snap,
            "rounded-[10px] shadow-[var(--v2-elevation-raised)]": true,
            "flex-1": dock.fullscreen(),
          }}
          style={{ width: panelWidth() }}
        >
          <Show when={!dock.fullscreen()}>
            <div onPointerDown={() => props.size.start()}>
              <ResizeHandle
                direction="horizontal"
                edge="start"
                size={layout.dock.width()}
                min={300}
                max={maxWidth()}
                onResize={(width) => {
                  props.size.touch()
                  layout.dock.resize(width)
                }}
              />
            </div>
          </Show>

          {/* 顶部图标栏：文件标签 / 调试 / 文件树 ·· ＋ / 全屏 / 收起 */}
          <div class="h-9 shrink-0 flex items-center gap-0.5 px-1.5 border-b border-border-weaker-base">
            <BarButton
              icon="open-file"
              title={language.t("session.tab.openedFiles")}
              on={dock.mode() === "tabs"}
              onClick={() => switchMode("tabs")}
            />
            <BarButton icon="debug" title="调试" on={dock.mode() === "debug"} onClick={() => switchMode("debug")} />
            <BarButton
              icon="file-tree"
              title={language.t("session.files.all")}
              label={explorerFile()}
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
            {/* -------- 文件标签：从时间线/文件搜索打开的文件都落在这里 -------- */}
            <Match when={dock.mode() === "tabs"}>
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

            {/* -------- file：Cursor 风格资源管理器（文件树 + 可编辑文件视图） -------- */}
            <Match when={dock.mode() === "file"}>
              <ExplorerPanel modified={diffFiles()} kinds={kinds()} />
            </Match>

            {/* -------- 调试：仪器大窗口堆叠（模拟数据） -------- */}
            <Match when={dock.mode() === "debug"}>
              <div class="ydbg flex-1 min-h-0 overflow-y-auto px-3 py-3">
                <DebugContent />
              </div>
            </Match>
          </Switch>
        </aside>
      </Show>
    </Show>
  )
}
