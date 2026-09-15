import { Show } from "solid-js"
import { Card } from "@yoma-desktop/ui/card"
import type { TimelineRowMap } from "./rows"

export function ModelRequestStatus(props: { row: TimelineRowMap["ModelRequest"]; title: string }) {
  return (
    <Card
      variant={props.row.state === "failed" ? "error" : props.row.state === "recovered" ? "success" : "warning"}
      data-kind="model-request"
      data-state={props.row.state}
      role="status"
      aria-live="polite"
    >
      <div data-card="title">{props.title}</div>
      <Show when={props.row.state !== "recovered"}>
        <div data-card="description">{props.row.text}</div>
      </Show>
    </Card>
  )
}
