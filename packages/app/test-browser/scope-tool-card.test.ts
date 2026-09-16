import { afterEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import type { FilePart } from "@yoma-desktop/kernel"

vi.mock("@yoma-desktop/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn() }) }))
vi.mock("@yoma-desktop/session-ui/basic-tool", () => ({ BasicTool: (props: { children?: JSX.Element }) => props.children }))
import { ScopeTool } from "@yoma-desktop/session-ui/scope-tool"

let dispose: (() => void) | undefined
const root = document.createElement("div")
afterEach(() => { dispose?.(); root.replaceChildren() })
const image = (mime = "image/png", url = "data:image/png;base64,AAAA"): FilePart => ({
  id: "image", sessionID: "s", messageID: "m", type: "file", mime, url,
})

describe("scope tool screenshot", () => {
  test("live attachment updates and restored results display the same PNG", () => {
    const [props, setProps] = createStore({ tool: "scope", input: { action: "screenshot" }, metadata: {}, attachments: [] as FilePart[] })
    dispose = render(() => createComponent(ScopeTool, props), root)
    expect(root.querySelector("img")).toBeNull()
    setProps("attachments", [image()])
    const live = root.querySelector("img")?.getAttribute("src")
    expect(live).toBe(image().url)
    dispose()
    dispose = render(() => createComponent(ScopeTool, { ...props, attachments: [image()] }), root)
    expect(root.querySelector("img")?.getAttribute("src")).toBe(live)
  })
  test("file paths and other MIME types are not silently loaded as instrument images", () => {
    dispose = render(() => createComponent(ScopeTool, {
      tool: "scope", input: { action: "screenshot" }, metadata: {}, output: "saved screenshot",
      attachments: [image("image/png", "file:///some/capture.png"), image("image/svg+xml", "data:image/svg+xml;base64,AAAA")],
    }), root)
    expect(root.querySelector("img")).toBeNull()
    expect(root.textContent).toContain("saved screenshot")
  })
})
