import { createMediaQuery } from "@solid-primitives/media"
import { useLayout } from "@/context/layout"
import { BenchProvider } from "@/pages/session/bench/bench-context"
import { SessionConsole } from "@/pages/session/console/session-console"
import { SessionStatusBar } from "@/pages/session/console/session-status-bar"
import { WorkbenchToolbar } from "@/pages/session/console/workbench-toolbar"
import { consoleUI } from "@/pages/session/console/console-state"
import { useConsoleCommands } from "@/pages/session/console/use-console-commands"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { debug } from "@/pages/session/debug/debug-data"
import { createSizing } from "@/pages/session/helpers"
import { Show, createEffect, createResource, untrack } from "solid-js"
import { useSearchParams } from "@solidjs/router"
import { NewSessionDesignView } from "@/components/session"
import { PromptInput } from "@/components/prompt-input"
import { useSettingsCommand } from "@/components/settings-dialog"
import {
  PromptProjectAddButton,
  PromptProjectSelector,
  createPromptProjectController,
} from "@/components/prompt-project-selector"
import { useComments } from "@/context/comments"
import { usePrompt } from "@/context/prompt"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { createPromptInputController, createPromptProjectControls } from "@/pages/session/composer"
import { useSessionKey } from "@/pages/session/session-layout"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

/**
 * The `/new-session` draft page. Unlike `session.tsx`, this only renders the prompt
 * composer and the same instruments as an active workspace. Typing never changes
 * the panel layout. Submitting promotes the draft into a session (see prompt-input/submit).
 */
export default function NewSessionPage() {
  const prompt = usePrompt()
  const serverSync = useServerSync()
  const comments = useComments()
  const language = useLanguage()
  const route = useSessionKey()
  const [searchParams, setSearchParams] = useSearchParams<{ draftId?: string; prompt?: string }>()

  const layout = useLayout()
  const desktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  useConsoleCommands()
  useComposerCommands()
  useSettingsCommand()

  let inputRef: HTMLDivElement | undefined

  const inputController = createPromptInputController({
    sessionKey: route.sessionKey,
    sessionID: () => route.params.id,
    queryOptions: serverSync().queryOptions,
  })
  const projectControls = createPromptProjectControls()
  const projectController = createPromptProjectController({
    controls: projectControls,
    onDone: () => inputRef?.focus(),
  })

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  createEffect(() => {
    if (!prompt.ready()) return
    requestAnimationFrame(() => inputRef?.focus())
  })
  const ready = Promise.resolve()
  const [promptReady] = createResource(
    () => prompt.ready.promise ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <BenchProvider>
      <div data-component="workbench-draft">
        <WorkbenchToolbar />
        <div data-slot="main" style={{ display: desktop() && consoleUI.maximized() ? "none" : undefined }}>
          <div
            data-slot="composer"
            style={{
              display: desktop() && debug.fullscreen() ? "none" : undefined,
              width: desktop() ? `calc(100% - ${(debug.opened() ? layout.dock.width() : 36) + 8}px)` : undefined,
            }}
          >
            <div class="size-full overflow-hidden">
              <NewSessionDesignView>
                <div class={NEW_SESSION_CONTENT_WIDTH}>
                  <Show
                    when={prompt.ready() || promptReady()}
                    fallback={
                      <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak pointer-events-none">
                        {language.t("prompt.loading")}
                      </div>
                    }
                  >
                    <div class="flex flex-col gap-3">
                      <PromptInput
                        controls={inputController()}
                        variant="new-session"
                        ref={(el) => {
                          inputRef = el
                        }}
                        onSubmit={() => comments.clear()}
                        toolbar={
                          <Show when={!projectController.selected()}>
                            <PromptProjectAddButton controller={projectController} />
                          </Show>
                        }
                      />
                      <Show when={projectController.selected()}>
                        <div class="flex min-h-7 min-w-0 items-center justify-start gap-0 text-v2-text-text-faint">
                          <PromptProjectSelector controller={projectController} placement="bottom-start" />
                        </div>
                      </Show>
                    </div>
                  </Show>
                </div>
              </NewSessionDesignView>
            </div>
          </div>
          <SessionSidePanel diffs={() => []} snap={false} size={size} />
        </div>
        <Show when={desktop()}>
          <SessionConsole />
          <SessionStatusBar />
        </Show>
      </div>
    </BenchProvider>
  )
}
