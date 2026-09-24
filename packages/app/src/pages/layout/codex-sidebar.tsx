import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import type { Session } from "@yoma-desktop/kernel"
import { Icon as IconV2 } from "@yoma-desktop/ui/v2/icon"
import { IconButtonV2 } from "@yoma-desktop/ui/v2/icon-button-v2"
import { TooltipV2 } from "@yoma-desktop/ui/v2/tooltip-v2"
import { MenuV2 } from "@yoma-desktop/ui/v2/menu-v2"
import { ScrollView } from "@yoma-desktop/ui/scroll-view"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@yoma-desktop/ui/v2/dialog-v2"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { TextInputV2 } from "@yoma-desktop/ui/v2/text-input-v2"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { useServerSync } from "@/context/server-sync"
import { useDrafts } from "@/context/drafts"
import { useLanguage } from "@/context/language"
import { useLayout, type LocalProject } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useGlobal } from "@/context/global"
import { useDirectoryPicker } from "@/components/directory-picker"
import { showToast } from "@/utils/toast"
import { displayName, projectForSession, sortedRootSessions } from "./helpers"
import { sessionTitle } from "@/utils/session-title"
import { sessionHref } from "@/utils/session-href"
import { sessionTime, terseAgo } from "./codex-util"
import { registerSidebarInstrumentSlot } from "./sidebar-slot"
import { SIDEBAR_ROW, SIDEBAR_ROW_ACTIVE, SIDEBAR_ROW_IDLE } from "./sidebar-row"

const LOAD_LIMIT = 64

/**
 * 哪几个项目展开着。放在模块里而不是组件里:侧栏收起再打开(`layout-new.tsx` 的 `<Show>`)会重建组件,
 * 放组件里就是每次都全收回去。**不用**名单里存着的 `expanded` —— 那一位从来没人读过,`open()` 一律写成 true,
 * 拿它当缺省的话升级之后所有项目一起展开,每个都去拉 64 条会话。
 */
const [expanded, setExpanded] = createStore<Record<string, boolean>>({})

/** "项目"这一整段收没收起(标题旁那个 ˅)。每个人自己的习惯,落 localStorage;读写都可能抛(隐私窗口)。 */
const FOLD_KEY = "yoma.sidebar.projectsFolded"
const [section, setSection] = createStore({
  folded: (() => {
    try {
      return globalThis.localStorage?.getItem(FOLD_KEY) === "1"
    } catch {
      return false
    }
  })(),
})
function setFolded(folded: boolean) {
  setSection("folded", folded)
  try {
    globalThis.localStorage?.setItem(FOLD_KEY, folded ? "1" : "0")
  } catch {
    // 存不下就只在这一次打开里有效
  }
}

// 行的样子与画进侧栏的仪器入口共用(sidebar-row.ts),叠加层的理由写在那边。
const ROW = SIDEBAR_ROW
const ROW_IDLE = SIDEBAR_ROW_IDLE
const ROW_ACTIVE = SIDEBAR_ROW_ACTIVE

export function CodexSidebar() {
  const layout = useLayout()
  const drafts = useDrafts()
  const language = useLanguage()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const platform = usePlatform()
  const navigate = useNavigate()

  const projects = createMemo(() => layout.projects.list())

  const activeSessionId = createMemo(() => {
    const route = layout.route()
    return route.type === "session" ? route.sessionId : undefined
  })

  function openSession(session: Session) {
    const directory = projectForSession(session, projects())?.worktree ?? session.directory
    layout.projects.open(directory)
    navigate(sessionHref(session.id))
  }

  function newChat(directory?: string) {
    const target = directory ?? projects()[0]?.worktree
    if (target) {
      layout.projects.open(target)
      drafts.create({ directory: target }, "")
      return
    }
    pickDirectory({
      title: language.t("codex.search.openFolder"),
      onSelect: (result) => {
        const picked = Array.isArray(result) ? result[0] : result
        if (!picked) return
        layout.projects.open(picked)
        drafts.create({ directory: picked }, "")
      },
    })
  }

  function addProject(directory: string) {
    layout.projects.open(directory)
    drafts.create({ directory }, "")
  }

  function openExistingFolder() {
    pickDirectory({
      title: language.t("codex.projects.openExisting"),
      onSelect: (result) => {
        const picked = Array.isArray(result) ? result[0] : result
        if (picked) addProject(picked)
      },
    })
  }

  function openNewProject() {
    dialog.show(() => (
      <NewProjectChoiceDialog
        onOpenExisting={() => {
          dialog.close()
          openExistingFolder()
        }}
        onCreateNew={() => {
          dialog.show(() => <NewFolderDialog onCreated={addProject} />)
        }}
      />
    ))
  }

  return (
    <aside
      data-component="codex-sidebar"
      // 不画右边框:标题栏横跨整个窗口,这条线只能从标题栏下沿画起,看着像没画完(用户指出)。
      // 右边的会话区与右栏本来就是各自带边框的圆角卡片,分隔不靠这条线。
      class="flex h-full w-[264px] shrink-0 flex-col gap-1 bg-v2-background-bg-deep px-2 pb-2 pt-1"
      aria-label={language.t("home.projects")}
    >
      <div class="flex flex-col gap-0.5 pt-1">
        <ActionRow icon="edit" label={language.t("codex.newChat")} onClick={() => newChat()} />
        <Show when={platform.manuals}>
          <ActionRow icon="archive" label="手册库" onClick={() => navigate("/manuals")} />
        </Show>
        <Show when={platform.mailbox}>
          <ActionRow icon="status" label={language.t("bench.nav")} onClick={() => navigate("/bench")} />
        </Show>
      </div>
      {/* 会话页 / 草稿页把这一会话的仪器入口画进来(Portal);别的页面这里是空的。 */}
      <div data-slot="sidebar-instruments" ref={(element) => registerSidebarInstrumentSlot(element)} />

      <ScrollView class="-mr-1 min-h-0 flex-1 pr-1">
        <div class="flex flex-col gap-4 pt-3">
          <section class="flex flex-col gap-0.5">
            <ProjectsSectionHeader
              folded={section.folded}
              onToggleFolded={() => setFolded(!section.folded)}
              canToggleAll={projects().length > 0}
              anyExpanded={projects().some((project) => expanded[project.worktree])}
              onToggleAll={() => {
                const open = !projects().some((project) => expanded[project.worktree])
                setExpanded(Object.fromEntries(projects().map((project) => [project.worktree, open])))
              }}
              onNewProject={openNewProject}
            />
            <Show when={!section.folded}>
              <For each={projects()}>
                {(project) => (
                  <ProjectItem
                    project={project}
                    open={!!expanded[project.worktree]}
                    onOpenChange={(open) => setExpanded(project.worktree, open)}
                    activeSessionId={activeSessionId}
                    onOpenSession={openSession}
                    onNewChat={newChat}
                    onRemove={() => {
                      layout.projects.close(project.worktree)
                      setExpanded(project.worktree, false)
                      showToast({
                        title: language.t("codex.projects.removed", { name: displayName(project) }),
                        description: language.t("codex.projects.removedDesc"),
                      })
                    }}
                  />
                )}
              </For>
              <Show when={projects().length === 0}>
                <EmptyHint>{language.t("home.sessions.empty")}</EmptyHint>
              </Show>
            </Show>
          </section>
        </div>
      </ScrollView>
    </aside>
  )
}

function ActionRow(props: { icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" class={`${ROW} ${ROW_IDLE}`} onClick={props.onClick}>
      <IconV2
        name={props.icon}
        size="small"
        class="shrink-0 text-v2-icon-icon-muted group-hover:text-v2-icon-icon-base"
      />
      <span class="min-w-0 flex-1 truncate">{props.label}</span>
    </button>
  )
}

/**
 * 「项目」标题行。从前这里的 ˅、「展开」「更多」都只是样子(源码注释写着 "functionality wired later"),
 * 点了没反应。现在:标题连同 ˅ 收起 / 展开整段;「全部展开 / 全部收起」一次开合所有项目;
 * 「更多」删了 —— 对单个项目能做的事(移除、在访达中打开、复制路径)在每一行自己的菜单里。
 */
function ProjectsSectionHeader(props: {
  folded: boolean
  onToggleFolded: () => void
  canToggleAll: boolean
  anyExpanded: boolean
  onToggleAll: () => void
  onNewProject: () => void
}) {
  const language = useLanguage()
  return (
    <div class="group flex h-7 items-center gap-1 px-2 pb-0.5 pt-1">
      <button
        type="button"
        class="-ml-1 flex min-w-0 items-center gap-1 rounded-[5px] px-1 text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-focus"
        aria-expanded={!props.folded}
        title={language.t(props.folded ? "codex.projects.showList" : "codex.projects.hideList")}
        onClick={props.onToggleFolded}
      >
        <span class="truncate text-[12px] [font-weight:500]">{language.t("home.projects")}</span>
        <IconV2
          name="chevron-down"
          size="small"
          class="shrink-0 text-v2-icon-icon-muted transition-transform"
          classList={{ "-rotate-90": props.folded }}
        />
      </button>
      <div class="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Show when={!props.folded && props.canToggleAll}>
          <HeaderIconButton
            icon={props.anyExpanded ? "collapse-corners" : "expand-corners"}
            label={language.t(props.anyExpanded ? "codex.projects.collapseAll" : "codex.projects.expandAll")}
            onClick={props.onToggleAll}
          />
        </Show>
        <HeaderIconButton icon="square-plus" label={language.t("codex.projects.new")} onClick={props.onNewProject} />
      </div>
    </div>
  )
}

function HeaderIconButton(props: { icon: string; label: string; onClick?: () => void }) {
  return (
    <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={props.label}>
      <IconButtonV2
        variant="ghost-muted"
        size="small"
        icon={<IconV2 name={props.icon} />}
        aria-label={props.label}
        onClick={props.onClick}
      />
    </TooltipV2>
  )
}

function EmptyHint(props: { children: JSX.Element }) {
  return <div class="px-2 py-1 text-[12px] text-v2-text-text-faint [font-weight:440]">{props.children}</div>
}

function ProjectItem(props: {
  project: LocalProject
  open: boolean
  onOpenChange: (open: boolean) => void
  activeSessionId: () => string | undefined
  onOpenSession: (session: Session) => void
  onNewChat: (directory: string) => void
  onRemove: () => void
}) {
  const serverSync = useServerSync()
  const language = useLanguage()
  const platform = usePlatform()
  const open = () => props.open
  const [menuOpen, setMenuOpen] = createSignal(false)

  /** 在访达 / 资源管理器里打开:shell.openPath 对目录就是打开这个文件夹。 */
  const revealLabel = () =>
    language.t(
      platform.os === "macos"
        ? "codex.projects.revealMac"
        : platform.os === "windows"
          ? "codex.projects.revealWindows"
          : "codex.projects.reveal",
    )

  /**
   * 右键菜单与「…」菜单是同一份条目(各调一次,各得一份元素)。
   * 「从列表中移除」只动侧栏的名单:文件夹、会话记录都不碰,重新打开这个文件夹就回来 —— 所以不弹确认框,
   * 移除后的提示里把这句话说清楚。
   */
  const menuItems = () => (
    <>
      <MenuV2.Item onSelect={() => props.onNewChat(props.project.worktree)}>{language.t("codex.newChat")}</MenuV2.Item>
      <Show when={platform.openPath}>
        {(_) => (
          <MenuV2.Item
            onSelect={() =>
              void platform.openPath?.(props.project.worktree).catch((error: unknown) =>
                showToast({
                  title: language.t("codex.projects.revealFailed"),
                  description: error instanceof Error ? error.message : String(error),
                }),
              )
            }
          >
            {revealLabel()}
          </MenuV2.Item>
        )}
      </Show>
      <MenuV2.Item
        onSelect={() =>
          void navigator.clipboard
            ?.writeText(props.project.worktree)
            .then(() =>
              showToast({ title: language.t("codex.projects.pathCopied"), description: props.project.worktree }),
            )
        }
      >
        {language.t("codex.projects.copyPath")}
      </MenuV2.Item>
      <MenuV2.Separator />
      <MenuV2.Item onSelect={props.onRemove}>{language.t("codex.projects.remove")}</MenuV2.Item>
    </>
  )

  createEffect(() => {
    if (open()) void serverSync().project.loadSessions(props.project.worktree, { limit: LOAD_LIMIT })
  })

  const sessions = createMemo(() => {
    if (!open()) return [] as Session[]
    const now = Date.now()
    return sortedRootSessions(serverSync().child(props.project.worktree, { bootstrap: true })[0], now).sort(
      (a, b) => sessionTime(b) - sessionTime(a),
    )
  })

  return (
    <div class="flex flex-col">
      <MenuV2.Context>
        <MenuV2.Context.Trigger
          as="div"
          data-component="sidebar-project"
          data-worktree={props.project.worktree}
          class="group relative flex h-8 min-w-0 items-center rounded-[7px] transition-colors hover:bg-v2-overlay-simple-overlay-hover data-[expanded]:bg-v2-overlay-simple-overlay-hover"
          classList={{ "bg-v2-overlay-simple-overlay-hover": menuOpen() }}
        >
          <button
            type="button"
            class="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[7px] px-2 text-left"
            aria-expanded={open()}
            title={props.project.worktree}
            onClick={() => props.onOpenChange(!open())}
          >
            <IconV2
              name={open() ? "chevron-down" : "chevron-right"}
              size="small"
              class="-ml-0.5 shrink-0 text-v2-icon-icon-muted"
            />
            <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-base [font-weight:500]">
              {displayName(props.project)}
            </span>
          </button>
          <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language.t("codex.newChat")}>
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              icon={<IconV2 name="edit" />}
              aria-label={language.t("codex.newChat")}
              onClick={() => props.onNewChat(props.project.worktree)}
            />
          </TooltipV2>
          <MenuV2 gutter={4} placement="bottom-end" open={menuOpen()} onOpenChange={setMenuOpen}>
            <MenuV2.Trigger
              as={IconButtonV2}
              variant="ghost-muted"
              size="small"
              class="mr-1 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              classList={{ "opacity-100!": menuOpen() }}
              icon={<IconV2 name="dots-horizontal" />}
              aria-label={language.t("codex.projects.actions")}
              title={language.t("codex.projects.actions")}
            />
            <MenuV2.Portal>
              <MenuV2.Content data-menu="sidebar-project" style={{ "min-width": "168px" }}>
                {menuItems()}
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        </MenuV2.Context.Trigger>
        <MenuV2.Context.Portal>
          <MenuV2.Context.Content data-menu="sidebar-project" style={{ "min-width": "168px" }}>
            {menuItems()}
          </MenuV2.Context.Content>
        </MenuV2.Context.Portal>
      </MenuV2.Context>
      <Show when={open()}>
        <div class="flex flex-col gap-0.5 pb-1 pl-[26px]">
          <For each={sessions()}>
            {(session) => (
              <ConversationRow
                session={session}
                active={session.id === props.activeSessionId()}
                onOpen={props.onOpenSession}
              />
            )}
          </For>
          <Show when={sessions().length === 0}>
            <EmptyHint>{language.t("codex.noConversations")}</EmptyHint>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function ConversationRow(props: { session: Session; active: boolean; onOpen: (session: Session) => void }) {
  const language = useLanguage()
  const title = createMemo(() => sessionTitle(props.session.title) || props.session.id)
  return (
    <button
      type="button"
      data-session-id={props.session.id}
      class={`${ROW} ${props.active ? ROW_ACTIVE : ROW_IDLE}`}
      onClick={() => props.onOpen(props.session)}
    >
      <span class="min-w-0 flex-1 truncate">{title()}</span>
      <span class="shrink-0 text-[11px] text-v2-text-text-faint [font-weight:440]">
        {terseAgo(sessionTime(props.session), language.locale())}
      </span>
    </button>
  )
}

function NewProjectChoiceDialog(props: { onOpenExisting: () => void; onCreateNew: () => void }) {
  const language = useLanguage()
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("codex.projects.new")}
          description={language.t("codex.projects.newDesc")}
        />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-1 px-3 pb-3">
        <ProjectChoiceRow
          icon="folder"
          title={language.t("codex.projects.openExisting")}
          description={language.t("codex.projects.openExistingDesc")}
          onClick={props.onOpenExisting}
        />
        <ProjectChoiceRow
          icon="folder-add-left"
          title={language.t("codex.projects.newFolder")}
          description={language.t("codex.projects.newFolderDesc")}
          onClick={props.onCreateNew}
        />
      </DialogBody>
    </Dialog>
  )
}

function ProjectChoiceRow(props: { icon: string; title: string; description: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="group flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none active:bg-v2-overlay-simple-overlay-pressed"
      onClick={props.onClick}
    >
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-v2-background-bg-layer-03 text-v2-icon-icon-base transition-colors group-hover:text-v2-icon-icon-accent">
        <IconV2 name={props.icon} />
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-[13px] text-v2-text-text-base [font-weight:530]">{props.title}</span>
        <span class="truncate text-[12px] leading-[16px] text-v2-text-text-muted [font-weight:440]">
          {props.description}
        </span>
      </span>
      <IconV2
        name="chevron-right"
        size="small"
        class="shrink-0 text-v2-icon-icon-muted transition-transform group-hover:translate-x-0.5"
      />
    </button>
  )
}

function NewFolderDialog(props: { onCreated: (path: string) => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [parent, setParent] = createSignal(global.ctx.sync.data.path.directory || "")
  const [name, setName] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const canCreate = createMemo(() => Boolean(parent()) && Boolean(name().trim()) && !busy())

  async function create() {
    if (!canCreate()) return
    setBusy(true)
    setError("")
    try {
      const path = await platform.createDirectory?.(parent(), name().trim())
      if (!path) throw new Error("unsupported")
      dialog.close()
      props.onCreated(path)
    } catch {
      setError(language.t("codex.projects.createFolderError"))
      setBusy(false)
    }
  }

  function chooseParent() {
    pickDirectory({
      title: language.t("codex.projects.chooseLocation"),
      onSelect: (result) => {
        const picked = Array.isArray(result) ? result[0] : result
        if (picked) setParent(picked)
      },
    })
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("codex.projects.newFolder")}
          description={language.t("codex.projects.newFolderDesc")}
        />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-4 px-4 pb-4">
        <label class="flex flex-col gap-1.5">
          <span class="text-[12px] text-v2-text-text-muted [font-weight:500]">
            {language.t("codex.projects.folderName")}
          </span>
          <TextInputV2
            value={name()}
            appearance="large"
            class="!w-full"
            placeholder="my-project"
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
        </label>
        <div class="flex flex-col gap-1.5">
          <span class="text-[12px] text-v2-text-text-muted [font-weight:500]">
            {language.t("codex.projects.location")}
          </span>
          <div class="flex h-8 items-center gap-2 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-base pl-2.5 pr-1">
            <IconV2 name="folder" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            <span
              class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-base"
              classList={{ "text-v2-text-text-faint!": !parent() }}
              title={parent()}
            >
              {parent() || language.t("codex.projects.chooseLocation")}
            </span>
            <ButtonV2 size="small" variant="ghost" onClick={chooseParent}>
              {language.t("codex.projects.browse")}
            </ButtonV2>
          </div>
        </div>
        <Show when={error()}>
          <span class="text-[12px] text-v2-state-fg-danger">{error()}</span>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!canCreate()} onClick={() => void create()}>
          {language.t("codex.projects.create")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
