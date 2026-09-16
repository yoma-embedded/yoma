import { createMemo, For, Show } from "solid-js"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { ImagePreview } from "@yoma-desktop/ui/image-preview"
import { SCOPE_CONTRACT } from "@yoma-desktop/kernel/tools/scope/contract"
import { BasicTool } from "./basic-tool"
import type { ToolProps } from "./message-part"

/** The image is saved in the tool result, so live and replay render the same evidence. */
export function ScopeTool(props: ToolProps) {
  const dialog = useDialog()
  const images = createMemo(() => (props.attachments ?? []).filter((file) => file.mime === "image/png" && file.url.startsWith("data:image/png;base64,")))
  return (
    <BasicTool {...props} defer={props.deferContent} icon="mcp" trigger={{ title: SCOPE_CONTRACT.label, subtitle: SCOPE_CONTRACT.summary(props.input) }}>
      <div data-component="scope-tool">
        <Show when={props.output}><pre data-scrollable>{props.output}</pre></Show>
        <For each={images()}>{(file) => (
          <figure>
            <button type="button" aria-label="放大示波器截图" onClick={() => dialog.show(() => <ImagePreview src={file.url} alt="示波器仪器截图" />)}>
              <img src={file.url} alt={file.filename ?? "示波器仪器截图"} loading="lazy" onLoad={() => props.onContentRendered?.()} />
            </button>
            <figcaption>仪器截图。保存的波形可在右侧“调试”面板缩放、查看游标。</figcaption>
          </figure>
        )}</For>
      </div>
    </BasicTool>
  )
}
