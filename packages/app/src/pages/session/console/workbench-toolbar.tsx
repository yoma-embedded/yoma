import { For } from "solid-js"
import { Icon } from "@yoma-desktop/ui/icon"
import { useLanguage } from "@/context/language"
import { useBench } from "../bench/bench-context"
import { INSTRUMENTS } from "../bench/instruments"
import { instrumentShown, toggleInstrument } from "./reveal-instrument"
import "./workbench.css"

/** Stable workspace navigation: device activity changes the indicator, never the available tools. */
export function WorkbenchToolbar() {
  const language = useLanguage()
  const bench = useBench()
  return (
    <nav class="ybench" data-component="workbench-toolbar" aria-label={language.t("session.workbench.title")}>
      <div data-slot="identity">
        <Icon name="debug" size="small" />
        <span>{language.t("session.workbench.title")}</span>
      </div>
      <div data-slot="instruments">
        <For each={INSTRUMENTS}>
          {(instrument) => {
            const selected = () => instrumentShown(instrument.id, bench.ctx())
            return (
              <button
                type="button"
                data-instrument={instrument.id}
                aria-pressed={selected()}
                onClick={() => toggleInstrument(instrument.id, bench.ctx())}
              >
                <Icon name={instrument.icon} size="small" />
                <span>{language.t(instrument.labelKey as Parameters<typeof language.t>[0])}</span>
                <span data-component="bench-led" data-state={instrument.status(bench.ctx())} />
              </button>
            )
          }}
        </For>
      </div>
      <span data-slot="hint">{language.t("session.workbench.direct")}</span>
    </nav>
  )
}
