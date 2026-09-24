import type { JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import "@/pages/session/console/workbench.css"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  const language = useLanguage()
  return (
    <div data-component="session-new-design">
      <div data-slot="content">
        <div data-slot="eyebrow">YOMA / AGENT</div>
        <h1>{language.t("session.workbench.agentTitle")}</h1>
        <p>{language.t("session.workbench.agentHint")}</p>
        {props.children}
      </div>
    </div>
  )
}
