import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@yoma-desktop/ui/icon"
import { useLanguage } from "@/context/language"
import { kernel } from "@/utils/kernel"
import { sessionHref } from "@/utils/session-href"
import { INSTRUMENTS } from "@/pages/session/bench/instruments"
import { openWorkbenchInstrument } from "@/pages/session/console/reveal-instrument"
import type { InstrumentId } from "@/pages/session/bench/bench-status"
import "@/pages/session/console/workbench.css"

export function WorkbenchLauncher(props: { directory?: string; onChooseProject: () => Promise<string | undefined> }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const [state, setState] = createStore({ pending: "", error: "" })
  const open = async (id: InstrumentId) => {
    if (state.pending) return
    setState({ pending: id, error: "" })
    try {
      const directory = props.directory || (await props.onChooseProject())
      if (!directory) return
      // An empty workspace session gives instruments a lifecycle without making a model request.
      const session = await kernel.session.create({
        directory,
        title: language.t("session.workbench.title"),
      })
      openWorkbenchInstrument(id)
      navigate(sessionHref(session.id))
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("pending", "")
    }
  }
  return (
    <section class="ybench" data-component="workbench-launcher" aria-label={language.t("session.workbench.title")}>
      <div data-slot="eyebrow">YOMA / EMBEDDED</div>
      <h1>{language.t("session.workbench.title")}</h1>
      <p>{language.t("session.workbench.welcome")}</p>
      <div data-slot="tools">
        <For each={INSTRUMENTS}>
          {(instrument) => (
            <button
              type="button"
              data-instrument={instrument.id}
              disabled={!!state.pending}
              onClick={() => void open(instrument.id)}
            >
              <Icon name={instrument.icon} size="normal" />
              <strong>{language.t(instrument.labelKey as Parameters<typeof language.t>[0])}</strong>
              <span>{language.t(`session.workbench.${instrument.id}` as Parameters<typeof language.t>[0])}</span>
              <span data-slot="open">{state.pending === instrument.id ? language.t("common.loading") : "↗"}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={state.error}>
        <p role="alert" data-slot="error">
          {state.error}
        </p>
      </Show>
      <Show when={!props.directory}>
        <p data-slot="project-hint">{language.t("session.workbench.chooseProject")}</p>
      </Show>
    </section>
  )
}
