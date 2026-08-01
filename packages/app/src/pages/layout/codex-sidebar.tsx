import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useNavigate } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Icon as IconV2 } from "@yoma-desktop/ui/v2/icon"
import { IconButtonV2 } from "@yoma-desktop/ui/v2/icon-button-v2"
import { TooltipV2 } from "@yoma-desktop/ui/v2/tooltip-v2"
import { ScrollView } from "@yoma-desktop/ui/scroll-view"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@yoma-desktop/ui/v2/dialog-v2"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { TextInputV2 } from "@yoma-desktop/ui/v2/text-input-v2"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { useLayout, type LocalProject } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useGlobal } from "@/context/global"
import { useDirectoryPicker } from "@/components/directory-picker"
import { displayName, projectForSession, sortedRootSessions } from "./helpers"
import { sessionTitle } from "@/utils/session-title"
import { sessionTime, terseAgo } from "./codex-util"

const LOAD_LIMIT = 64

const ROW =
  "group flex h-8 w-full min-w-0 items-center gap-2 rounded-[7px] px-2 text-left text-[13px] transition-colors [font-weight:500]"
const ROW_IDLE = "text-v2-text-text-muted hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base"
const ROW_ACTIVE = "bg-v2-background-bg-layer-03 text-v2-text-text-base"

export function CodexSidebar(props: { onOpenSearch: () => void }) {
  const server = useServer()
  const layout = useLayout()
  const tabs = useTabs()
  const language = useLanguage()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const platform = usePlatform()
  const navigate = useNavigate()

  const projects = createMemo(() => layout.projects.list())
  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )

  const activeSessionId = createMemo(() => {
    const route = layout.route()
    return route.type === "session" ? route.sessionId : undefined
  })

  function openSession(session: Session) {
    const directory = projectForSession(session, projects(), projectByID())?.worktree ?? session.directory
    layout.projects.open(directory)
    const tab = tabs.addSessionTab({ server: server.key, sessionId: session.id })
    tabs.select(tab)
  }

  function newChat(directory?: string) {
    const conn = server.current
    if (!conn) return
    const target = directory ?? projects()[0]?.worktree
    if (target) {
      layout.projects.open(target)
      tabs.newDraft({ server: server.key, directory: target }, "")
      return
    }
    pickDirectory({
      server: conn,
      title: language.t("codex.search.openFolder"),
      multiple: false,
      onSelect: (result) => {
        const picked = Array.isArray(result) ? result[0] : result
        if (!picked) return
        layout.projects.open(picked)
        tabs.newDraft({ server: server.key, directory: picked }, "")
      },
    })
  }

  function addProject(directory: string) {
    layout.projects.open(directory)
    tabs.newDraft({ server: server.key, directory }, "")
  }

  function openExistingFolder() {
    const conn = server.current
    if (!conn) return
    pickDirectory({
      server: conn,
      title: language.t("codex.projects.openExisting"),
      multiple: false,
      onSelect: (result) => {
        const picked = Array.isArray(result) ? result[0] : result
        if (picked) addProject(picked)
      },
    })
  }

  function openNewProject() {
    const conn = server.current
    if (!conn) return
    dialog.show(() => (
      <NewProjectChoiceDialog
        onOpenExisting={() => {
          dialog.close()
          openExistingFolder()
        }}
        onCreateNew={() => {
          dialog.show(() => <NewFolderDialog server={conn} onCreated={addProject} />)
        }}
      />
    ))
  }

  return (
    <aside
      data-component="codex-sidebar"
      class="flex h-full w-[264px] shrink-0 flex-col gap-1 border-r border-v2-border-border-base bg-v2-background-bg-deep px-2 pb-2 pt-1"
      aria-label={language.t("home.projects")}
    >
      <div class="flex flex-col gap-0.5 pt-1">
        <ActionRow icon="edit" label={language.t("codex.newChat")} onClick={() => newChat()} />
        <ActionRow icon="magnifying-glass" label={language.t("codex.search")} onClick={props.onOpenSearch} />
        <Show when={platform.manuals}>
          <ActionRow icon="archive" label="手册库" onClick={() => navigate("/manuals")} />
        </Show>
      </div>

      <ScrollView class="-mr-1 min-h-0 flex-1 pr-1">
        <div class="flex flex-col gap-4 pt-3">
          <section class="flex flex-col gap-0.5">
            <ProjectsSectionHeader onNewProject={openNewProject} />
            <For each={projects()}>
              {(project) => (
                <ProjectItem
                  project={project}
                  activeSessionId={activeSessionId}
                  onOpenSession={openSession}
                  onNewChat={newChat}
                />
              )}
            </For>
            <Show when={projects().length === 0}>
              <EmptyHint>{language.t("home.sessions.empty")}</EmptyHint>
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

function ProjectsSectionHeader(props: { onNewProject: () => void }) {
  const language = useLanguage()
  return (
    <div class="group flex h-7 items-center gap-1 px-2 pb-0.5 pt-1">
      <span class="truncate text-[12px] text-v2-text-text-faint [font-weight:500]">
        {language.t("home.projects")}
      </span>
      <IconV2 name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      <div class="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {/* expand / more: styling only — functionality wired later */}
        <HeaderIconButton icon="expand-corners" label={language.t("codex.projects.expand")} />
        <HeaderIconButton icon="dots-horizontal" label={language.t("codex.projects.more")} />
        <HeaderIconButton
          icon="square-plus"
          label={language.t("codex.projects.new")}
          onClick={props.onNewProject}
        />
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
  activeSessionId: () => string | undefined
  onOpenSession: (session: Session) => void
  onNewChat: (directory: string) => void
}) {
  const serverSync = useServerSync()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)

  createEffect(() => {
    if (open()) void serverSync().project.loadSessions(props.project.worktree, { limit: LOAD_LIMIT })
  })

  const sessions = createMemo(() => {
    if (!open()) return [] as Session[]
    const now = Date.now()
    return [props.project.worktree, ...(props.project.sandboxes ?? [])]
      .flatMap((dir) => sortedRootSessions(serverSync().child(dir, { bootstrap: true })[0], now))
      .sort((a, b) => sessionTime(b) - sessionTime(a))
  })

  return (
    <div class="flex flex-col">
      <div class="group relative flex h-8 min-w-0 items-center rounded-[7px] hover:bg-v2-background-bg-layer-01">
        <button
          type="button"
          class="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[7px] px-2 text-left"
          aria-expanded={open()}
          onClick={() => setOpen((value) => !value)}
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
        <TooltipV2 class="mr-1 flex shrink-0 items-center" placement="bottom" value={language.t("codex.newChat")}>
          <IconButtonV2
            variant="ghost-muted"
            size="small"
            class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            icon={<IconV2 name="edit" />}
            aria-label={language.t("codex.newChat")}
            onClick={() => props.onNewChat(props.project.worktree)}
          />
        </TooltipV2>
      </div>
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

function NewFolderDialog(props: { server: ServerConnection.Any; onCreated: (path: string) => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const { sync } = global.ensureServerCtx(props.server)
  const [parent, setParent] = createSignal(sync.data.path.home || sync.data.path.directory || "")
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
      server: props.server,
      title: language.t("codex.projects.chooseLocation"),
      multiple: false,
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
