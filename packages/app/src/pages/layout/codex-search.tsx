import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { Session } from "@yoma-desktop/kernel"
import { Icon as IconV2 } from "@yoma-desktop/ui/v2/icon"
import { ScrollView } from "@yoma-desktop/ui/scroll-view"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useSettingsCommand } from "@/components/settings-dialog"
import { displayName, projectForSession, sortedRootSessions } from "./helpers"
import { sessionTitle } from "@/utils/session-title"
import { showToast } from "@/utils/toast"
import { sessionTime } from "./codex-util"

const CHAT_RESULT_LIMIT = 6

type Command = { icon: string; title: string; hint?: string; run: () => void }

export function CodexSearch(props: { onClose: () => void }) {
  const server = useServer()
  const serverSync = useServerSync()
  const layout = useLayout()
  const tabs = useTabs()
  const language = useLanguage()
  const pickDirectory = useDirectoryPicker()
  const openSettings = useSettingsCommand()

  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  let input: HTMLInputElement | undefined

  onMount(() => input?.focus())

  const projects = createMemo(() => layout.projects.list())

  const chats = createMemo(() => {
    const now = Date.now()
    const q = query().trim().toLowerCase()
    const all = projects().flatMap((project) =>
      sortedRootSessions(serverSync().child(project.worktree, { bootstrap: false })[0], now),
    )
    const deduped = [...new Map(all.map((session) => [session.id, session])).values()].sort(
      (a, b) => sessionTime(b) - sessionTime(a),
    )
    const matched = q
      ? deduped.filter((session) => (sessionTitle(session.title) || "").toLowerCase().includes(q))
      : deduped
    return matched.slice(0, CHAT_RESULT_LIMIT)
  })

  function close() {
    props.onClose()
  }

  function openSession(session: Session) {
    const directory = projectForSession(session, projects())?.worktree ?? session.directory
    layout.projects.open(directory)
    const tab = tabs.addSessionTab({ server: server.key, sessionId: session.id })
    tabs.select(tab)
    close()
  }

  function newChat() {
    const conn = server.current
    if (!conn) return
    const target = projects()[0]?.worktree
    if (target) {
      layout.projects.open(target)
      tabs.newDraft({ server: server.key, directory: target }, "")
      close()
      return
    }
    openFolder()
  }

  function openFolder() {
    const conn = server.current
    if (!conn) return
    close()
    pickDirectory({
      server: conn,
      title: language.t("codex.search.openFolder"),
      multiple: true,
      onSelect: (result) => {
        const dirs = Array.isArray(result) ? result : result ? [result] : []
        dirs.forEach((dir) => layout.projects.open(dir))
      },
    })
  }

  const comingSoon = (label: string) => {
    close()
    showToast({ title: label, description: language.t("codex.comingSoon") })
  }

  const suggested = createMemo<Command[]>(() => [
    { icon: "edit", title: language.t("codex.newChat"), hint: "Ctrl N", run: newChat },
    { icon: "folder-add-left", title: language.t("codex.search.openFolder"), hint: "Ctrl O", run: openFolder },
    {
      icon: "settings-gear",
      title: language.t("sidebar.settings"),
      hint: "Ctrl ,",
      run: () => {
        close()
        openSettings()
      },
    },
    {
      icon: "magnifying-glass",
      title: language.t("codex.search.searchFiles"),
      hint: "Ctrl P",
      run: () => comingSoon(language.t("codex.search.searchFiles")),
    },
  ])

  const actions = createMemo<Command[]>(() => [
    { icon: "edit", title: language.t("codex.search.newQuickChat"), run: () => comingSoon(language.t("codex.search.newQuickChat")) },
    { icon: "outline-square-arrow", title: language.t("codex.search.openNewWindow"), run: () => comingSoon(language.t("codex.search.openNewWindow")) },
    { icon: "archive", title: language.t("codex.search.archiveChat"), run: () => comingSoon(language.t("codex.search.archiveChat")) },
    { icon: "grid-plus", title: language.t("codex.search.togglePin"), run: () => comingSoon(language.t("codex.search.togglePin")) },
  ])

  const onKeyDown = (event: KeyboardEvent) => {
    const list = chats()
    if (event.key === "ArrowDown") {
      event.preventDefault()
      if (list.length) setActive((index) => (index + 1) % list.length)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      if (list.length) setActive((index) => (index - 1 + list.length) % list.length)
      return
    }
    if (event.key === "Enter" && !event.isComposing) {
      const session = list[active()] ?? list[0]
      if (session) {
        event.preventDefault()
        openSession(session)
      }
    }
  }

  makeEventListener(document, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    }
  })

  const chatMeta = (session: Session) => {
    const project = projectForSession(session, projects())
    return project ? displayName(project) : undefined
  }

  return (
    <Portal>
      <div class="fixed inset-0 z-[100] flex items-start justify-center" role="dialog" aria-modal="true">
        <div class="absolute inset-0 bg-black/40" onClick={close} />
        <div
          class="relative z-10 mt-[12vh] flex max-h-[70vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-[14px] bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
        >
          <label class="flex h-12 shrink-0 items-center gap-2.5 border-b border-v2-border-border-base px-4">
            <IconV2 name="magnifying-glass" class="shrink-0 text-v2-icon-icon-muted" />
            <input
              ref={(el) => (input = el)}
              value={query()}
              placeholder={language.t("codex.search.placeholder")}
              aria-label={language.t("codex.search.placeholder")}
              class="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
              onInput={(event) => {
                setQuery(event.currentTarget.value)
                setActive(0)
              }}
              onKeyDown={onKeyDown}
            />
          </label>

          <ScrollView class="min-h-0 flex-1">
            <div class="flex flex-col gap-3 p-2">
              <Section label={language.t("codex.search.chats")}>
                <For each={chats()}>
                  {(session, index) => (
                    <Row
                      title={sessionTitle(session.title) || session.id}
                      meta={chatMeta(session)}
                      hint={index() < 3 ? `Ctrl ${index() + 1}` : undefined}
                      active={index() === active()}
                      onMouseEnter={() => setActive(index())}
                      onClick={() => openSession(session)}
                    />
                  )}
                </For>
                <Show when={chats().length === 0}>
                  <div class="px-2.5 py-2 text-[13px] text-v2-text-text-muted [font-weight:440]">
                    {language.t("codex.search.noResults")}
                  </div>
                </Show>
              </Section>

              <Section label={language.t("codex.search.suggested")}>
                <For each={suggested()}>{(command) => <CommandRow command={command} />}</For>
              </Section>

              <Section label={language.t("codex.conversations")}>
                <For each={actions()}>{(command) => <CommandRow command={command} />}</For>
              </Section>
            </div>
          </ScrollView>
        </div>
      </div>
    </Portal>
  )
}

function Section(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col">
      <div class="px-2.5 py-1 text-[12px] text-v2-text-text-faint [font-weight:500]">{props.label}</div>
      <div class="flex flex-col">{props.children}</div>
    </div>
  )
}

function CommandRow(props: { command: Command }) {
  return (
    <Row icon={props.command.icon} title={props.command.title} hint={props.command.hint} onClick={props.command.run} />
  )
}

function Row(props: {
  icon?: string
  title: string
  meta?: string
  hint?: string
  active?: boolean
  onMouseEnter?: () => void
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class="group flex h-9 w-full min-w-0 items-center gap-2.5 rounded-[8px] px-2.5 text-left transition-colors hover:bg-v2-background-bg-layer-01"
      classList={{ "bg-v2-background-bg-layer-01": props.active }}
      onMouseEnter={props.onMouseEnter}
      onClick={props.onClick}
    >
      <Show when={props.icon}>
        {(icon) => <IconV2 name={icon()} size="small" class="shrink-0 text-v2-icon-icon-muted" />}
      </Show>
      <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-base [font-weight:500]">{props.title}</span>
      <Show when={props.meta}>
        {(meta) => <span class="shrink-0 truncate text-[12px] text-v2-text-text-muted [font-weight:440]">{meta()}</span>}
      </Show>
      <Show when={props.hint}>
        {(hint) => (
          <span class="shrink-0 rounded-[4px] bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[11px] text-v2-text-text-faint [font-weight:500]">
            {hint()}
          </span>
        )}
      </Show>
    </button>
  )
}
