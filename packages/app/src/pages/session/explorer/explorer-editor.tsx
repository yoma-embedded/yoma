/**
 * 资源管理器编辑器 —— 可直接修改文件内容的轻量代码编辑器。
 *
 * 结构：透明文字的 <textarea>（负责输入/光标/选区）叠在逐行渲染的高亮镜像层上。
 *  - 键入时同步做行级 diff 补丁（纯文本，保证几何永远精确），随后异步用 shiki
 *    整篇重新着色（只更新变化行的 innerHTML）。
 *  - 镜像行高固定（--exp-line-h），行号槽与之逐行对齐，横向 sticky。
 *  - 双击/三击/拖选出现 "Add to Chat" 浮层；Ctrl+L 同效并聚焦输入框。
 *  - 二进制 / 媒体 / 超大文件退回 pierre 只读查看器。
 */
import { createEffect, createMemo, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useFileComponent } from "@yoma-desktop/ui/context/file"
import { Markdown } from "@yoma-desktop/session-ui/markdown"
import { previewSelectedLines } from "@yoma-desktop/session-ui/pierre/selection-bridge"
import { sampledChecksum } from "@yoma-desktop/util/encode"
import { useCommand } from "@/context/command"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import {
  isEditableContent,
  isMarkdownPath,
  selectionFromOffsets,
  lineColFromIndex,
  type ExplorerScope,
} from "./explorer-state"
import type { ExplorerActions } from "./explorer-actions"
import {
  canHighlight,
  HIGHLIGHT_MAX_LINES,
  languageForPath,
  tokenizeLines,
  type ThemedToken,
} from "./explorer-highlight"

/** 编辑上限：超过退回只读查看器（pierre 有虚拟化，大文件更稳） */
const TEXT_EDIT_MAX_BYTES = 4_000_000
const TEXT_EDIT_MAX_LINES = 30_000

const LINE_H = 20
const PAD_TOP = 8
const PAD_BOTTOM = 96

/** 每个工作区目录一份的滚动位置记忆（不持久化） */
const scrollMemory = new Map<string, { x: number; y: number }>()

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function tokensToHtml(tokens: ThemedToken[]): string {
  let out = ""
  for (const token of tokens) {
    const style: string[] = []
    if (token.color) style.push(`color:${token.color}`)
    const font = typeof token.fontStyle === "number" && token.fontStyle > 0 ? token.fontStyle : 0
    if (font & 1) style.push("font-style:italic")
    if (font & 2) style.push("font-weight:600")
    if (font & 4) style.push("text-decoration:underline")
    if (style.length === 0) {
      out += escapeHtml(token.content)
      continue
    }
    out += `<span style="${style.join(";")}">${escapeHtml(token.content)}</span>`
  }
  return out
}

/**
 * 镜像层（代码行 + 行号）的命令式渲染器。
 * cache 记录每行当前 DOM 的来源（"t:"纯文本 / "h:"高亮 html），避免无谓写 DOM。
 */
function createMirror(code: HTMLElement, gutter: HTMLElement) {
  let cache: string[] = []

  const makeLine = (text: string) => {
    const div = document.createElement("div")
    div.className = "exp-line"
    div.textContent = text
    return div
  }

  const syncGutter = (count: number) => {
    while (gutter.children.length > count) gutter.lastElementChild!.remove()
    if (gutter.children.length < count) {
      const fragment = document.createDocumentFragment()
      for (let i = gutter.children.length; i < count; i++) {
        const div = document.createElement("div")
        div.className = "exp-ln"
        div.textContent = String(i + 1)
        fragment.appendChild(div)
      }
      gutter.appendChild(fragment)
    }
  }

  const setPlainLine = (index: number, text: string) => {
    const key = `t:${text}`
    if (cache[index] === key) return
    const el = code.children[index] as HTMLElement | undefined
    if (!el) return
    el.textContent = text
    cache[index] = key
  }

  return {
    reset() {
      code.textContent = ""
      gutter.textContent = ""
      cache = []
    },
    /** 行级 diff 补丁：只动中间变化区，前后缀（含高亮结果）原样保留 */
    patch(prev: string[], next: string[]) {
      const oldLen = prev.length
      const newLen = next.length
      let prefix = 0
      while (prefix < oldLen && prefix < newLen && prev[prefix] === next[prefix]) prefix++
      let suffix = 0
      while (suffix < oldLen - prefix && suffix < newLen - prefix && prev[oldLen - 1 - suffix] === next[newLen - 1 - suffix])
        suffix++

      const oldMid = oldLen - prefix - suffix
      const newMid = newLen - prefix - suffix
      const common = Math.min(oldMid, newMid)

      for (let i = 0; i < common; i++) {
        const index = prefix + i
        if (prev[index] === next[index]) continue
        setPlainLine(index, next[index]!)
      }

      if (oldMid > common) {
        for (let i = 0; i < oldMid - common; i++) code.children[prefix + common]?.remove()
        cache.splice(prefix + common, oldMid - common)
      } else if (newMid > common) {
        const fragment = document.createDocumentFragment()
        const inserted: string[] = []
        for (let i = prefix + common; i < prefix + newMid; i++) {
          fragment.appendChild(makeLine(next[i]!))
          inserted.push(`t:${next[i]}`)
        }
        code.insertBefore(fragment, code.children[prefix + common] ?? null)
        cache.splice(prefix + common, 0, ...inserted)
      }

      syncGutter(newLen)
    },
    /** 异步高亮结果落地：仅替换与缓存不同的行 */
    applyTokens(tokens: ThemedToken[][]) {
      if (tokens.length !== code.children.length) return
      for (let i = 0; i < tokens.length; i++) {
        const html = tokensToHtml(tokens[i]!)
        const key = `h:${html}`
        if (cache[i] === key) continue
        ;(code.children[i] as HTMLElement).innerHTML = html
        cache[i] = key
      }
    },
  }
}

/** tab 展开后的可视列号（tab-size: 4） */
function expandedCol(lineText: string, col: number): number {
  let out = 0
  for (let i = 0; i < col && i < lineText.length; i++) {
    if (lineText.charCodeAt(i) === 9) out += 4 - (out % 4)
    else out += 1
  }
  return out
}

function EditorSurface(props: { path: string; scope: ExplorerScope; actions: ExplorerActions; directory: string }) {
  const language = useLanguage()
  const platform = usePlatform()
  const prompt = usePrompt()
  const command = useCommand()

  const buffer = () => props.scope.buffer(props.path)
  const text = createMemo(() => buffer()?.text ?? "")
  const lang = createMemo(() => languageForPath(props.path))
  const scrollKey = `${props.directory}\n${props.path}`

  let scrollEl: HTMLDivElement | undefined
  let codeEl: HTMLDivElement | undefined
  let gutterEl: HTMLDivElement | undefined
  let textareaEl: HTMLTextAreaElement | undefined

  let mirror: ReturnType<typeof createMirror> | undefined
  let prevLines: string[] = []
  let highlightSeq = 0
  let highlightTimer: number | undefined
  let charWidth = 7.2
  let pointerAt = { x: 0, y: 0, time: 0 }

  const [popup, setPopup] = createStore({ visible: false, x: 0, y: 0 })

  const lineCount = createMemo(() => {
    let count = 1
    const value = text()
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) count++
    return count
  })
  const gutterCh = createMemo(() => Math.max(3, String(lineCount()).length) + 2)

  const scheduleHighlight = (value: string, lines: number) => {
    const seq = ++highlightSeq
    if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
    if (!canHighlight(value, lang()) || lines > HIGHLIGHT_MAX_LINES) return
    highlightTimer = window.setTimeout(() => {
      highlightTimer = undefined
      void tokenizeLines(value, lang()).then((tokens) => {
        if (seq !== highlightSeq || !tokens) return
        mirror?.applyTokens(tokens)
      })
    }, 80)
  }

  onMount(() => {
    if (!codeEl || !gutterEl) return
    mirror = createMirror(codeEl, gutterEl)

    // 等宽字符宽度（横向滚动跟随光标用）
    const probe = document.createElement("span")
    probe.className = "exp-line"
    probe.style.position = "absolute"
    probe.style.visibility = "hidden"
    probe.textContent = "0000000000"
    codeEl.appendChild(probe)
    charWidth = probe.getBoundingClientRect().width / 10 || charWidth
    probe.remove()

    prevLines = []
    const restore = scrollMemory.get(scrollKey)
    if (restore && scrollEl) {
      requestAnimationFrame(() => {
        if (!scrollEl) return
        scrollEl.scrollTop = restore.y
        scrollEl.scrollLeft = restore.x
      })
    }
  })

  createEffect(
    on(text, (value) => {
      const lines = value.split("\n")
      mirror?.patch(prevLines, lines)
      prevLines = lines
      scheduleHighlight(value, lines.length)
    }),
  )

  onCleanup(() => {
    if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
  })

  const saveScroll = () => {
    if (!scrollEl) return
    scrollMemory.set(scrollKey, { x: scrollEl.scrollLeft, y: scrollEl.scrollTop })
  }

  const gutterPx = () => (gutterEl ? gutterEl.getBoundingClientRect().width : 0)

  /** 光标移动后把滚动容器跟到光标处（textarea 自身不滚动） */
  const ensureCaretVisible = () => {
    requestAnimationFrame(() => {
      const el = textareaEl
      const scroller = scrollEl
      if (!el || !scroller) return
      const value = untrack(text)
      const { line, col } = lineColFromIndex(value, el.selectionEnd)
      const lineText = prevLines[line - 1] ?? ""
      const y0 = PAD_TOP + (line - 1) * LINE_H
      const y1 = y0 + LINE_H
      if (y0 < scroller.scrollTop + 4) scroller.scrollTop = Math.max(0, y0 - 8)
      else if (y1 > scroller.scrollTop + scroller.clientHeight - 4)
        scroller.scrollTop = y1 - scroller.clientHeight + 8

      const gutter = gutterPx()
      const x = gutter + 16 + expandedCol(lineText, col) * charWidth
      const viewLeft = scroller.scrollLeft + gutter + 8
      const viewRight = scroller.scrollLeft + scroller.clientWidth - 16
      if (x < viewLeft) scroller.scrollLeft = Math.max(0, x - gutter - 24)
      else if (x > viewRight) scroller.scrollLeft = x - scroller.clientWidth + 48
    })
  }

  const hidePopup = () => {
    if (popup.visible) setPopup("visible", false)
  }

  const showPopupForSelection = () => {
    const el = textareaEl
    if (!el || el.selectionStart === el.selectionEnd) {
      hidePopup()
      return
    }
    const value = untrack(text)
    const end = lineColFromIndex(value, Math.max(el.selectionStart, el.selectionEnd))
    const recentPointer = Date.now() - pointerAt.time < 600
    const lineText = prevLines[end.line - 1] ?? ""
    const anchorX = recentPointer ? pointerAt.x : 16 + expandedCol(lineText, end.col) * charWidth
    const anchorY = PAD_TOP + end.line * LINE_H + 6

    // 夹取到当前视口可见范围（弹层坐标相对 code-wrap，wrap 在 sticky 行号槽右侧）
    const scroller = scrollEl
    const gutter = gutterPx()
    const visibleLeft = scroller ? Math.max(8, scroller.scrollLeft - gutter + 8) : 8
    const visibleRight = scroller ? scroller.scrollLeft + scroller.clientWidth - gutter - 190 : 400
    setPopup({
      visible: true,
      x: Math.max(visibleLeft, Math.min(anchorX, Math.max(visibleLeft, visibleRight))),
      y: Math.max(4, anchorY),
    })
  }

  const addSelectionToChat = () => {
    const el = textareaEl
    if (!el || el.selectionStart === el.selectionEnd) return false
    const value = untrack(text)
    const selection = selectionFromOffsets(value, el.selectionStart, el.selectionEnd)
    const preview = previewSelectedLines(value, { start: selection.startLine, end: selection.endLine })
    prompt.context.add({ type: "file", path: props.path, selection, preview })
    hidePopup()
    command.trigger("input.focus")
    return true
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()

    if (mod && !event.shiftKey && !event.altKey && key === "s") {
      event.preventDefault()
      event.stopPropagation()
      void props.actions.save(props.path)
      return
    }
    if (mod && !event.shiftKey && !event.altKey && key === "l") {
      event.preventDefault()
      event.stopPropagation()
      if (!addSelectionToChat()) command.trigger("input.focus")
      return
    }
    if (event.key === "Tab" && !mod && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      document.execCommand("insertText", false, "  ")
      return
    }
    if (event.key === "Escape") {
      hidePopup()
      return
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
      ensureCaretVisible()
    }
  }

  return (
    <div
      ref={scrollEl}
      class="exp-scroll flex-1 min-h-0"
      onScroll={() => {
        saveScroll()
      }}
    >
      <div class="exp-surface" style={{ "--exp-gutter-ch": `${gutterCh()}ch` }}>
        <div ref={gutterEl} class="exp-gutter" aria-hidden="true" />
        <div class="exp-code-wrap">
          <div ref={codeEl} class="exp-code" aria-hidden="true" />
          <textarea
            ref={textareaEl}
            class="exp-input"
            value={text()}
            wrap="off"
            spellcheck={false}
            autocomplete="off"
            autocapitalize="off"
            data-gramm="false"
            aria-label={props.path}
            readOnly={!platform.writeTextFile}
            onInput={(event) => {
              props.scope.edit(props.path, event.currentTarget.value)
              hidePopup()
              ensureCaretVisible()
            }}
            onKeyDown={onKeyDown}
            onSelect={() => showPopupForSelection()}
            onPointerDown={() => hidePopup()}
            onPointerUp={(event) => {
              const wrap = event.currentTarget.parentElement
              if (wrap) {
                const rect = wrap.getBoundingClientRect()
                pointerAt = { x: event.clientX - rect.left, y: event.clientY - rect.top, time: Date.now() }
              }
              showPopupForSelection()
            }}
            onBlur={() => hidePopup()}
          />
          <Show when={popup.visible}>
            <button
              type="button"
              class="exp-addchat"
              style={{ left: `${popup.x}px`, top: `${popup.y}px` }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => addSelectionToChat()}
            >
              <span>{language.t("explorer.addToChat")}</span>
              <span class="exp-addchat-kbd">{platform.os === "macos" ? "⌘L" : "Ctrl+L"}</span>
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}

/** 只读兜底：媒体 / 二进制 / 超大文件，走既有 pierre 查看器（含虚拟化） */
function ReadonlyFile(props: { path: string; notice?: string }) {
  const file = useFile()
  const fileComponent = useFileComponent()
  const state = createMemo(() => file.get(props.path))
  const contents = createMemo(() => {
    const content = state()?.content
    if (!content || content.type !== "text" || content.encoding === "base64") return ""
    return content.content
  })

  return (
    <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
      <Show when={props.notice}>
        <div class="shrink-0 px-4 py-1.5 text-12-regular text-text-weak bg-background-stronger border-b border-border-weaker-base">
          {props.notice}
        </div>
      </Show>
      <div class="flex-1 min-h-0 overflow-auto">
        <div class="relative overflow-hidden pb-24">
          <Dynamic
            component={fileComponent}
            mode="text"
            file={{ name: props.path, contents: contents(), cacheKey: sampledChecksum(contents()) }}
            media={{ mode: "auto", path: props.path, current: state()?.content }}
            class="select-text"
          />
        </div>
      </div>
    </div>
  )
}

/**
 * 单个文件视图：加载 → 采纳磁盘内容为缓冲 → 编辑器 / Markdown 预览 / 只读兜底。
 */
export function ExplorerFileView(props: {
  path: string
  scope: ExplorerScope
  actions: ExplorerActions
  directory: string
}) {
  const file = useFile()
  const language = useLanguage()

  createEffect(
    on(
      () => props.path,
      (path) => {
        void file.load(path)
      },
    ),
  )

  const state = createMemo(() => file.get(props.path))
  const content = createMemo(() => state()?.content)
  const editableText = createMemo(() => {
    const value = content()
    if (!isEditableContent(value)) return undefined
    if (value.content.length > TEXT_EDIT_MAX_BYTES) return undefined
    return value.content
  })
  const tooLarge = createMemo(() => {
    const value = editableText()
    if (value === undefined) return false
    let lines = 1
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) lines++
    return lines > TEXT_EDIT_MAX_LINES
  })
  const editable = createMemo(() => editableText() !== undefined && !tooLarge())

  // 磁盘内容 → 编辑缓冲（干净跟随，脏保留 + diskChanged）。
  // 依赖必须是 content() 对象（每次 load 都是新对象）：若依赖内容字符串，
  // 强制重载读回相同文本时 memo 按值相等不通知，discard 后缓冲永远不会重建。
  createEffect(
    on(
      () => [props.path, content()] as const,
      ([path, value]) => {
        if (!isEditableContent(value)) return
        if (value.content.length > TEXT_EDIT_MAX_BYTES) return
        props.scope.adoptDisk(path, value.content)
      },
    ),
  )

  const buffer = () => props.scope.buffer(props.path)
  const markdown = createMemo(() => isMarkdownPath(props.path))
  const previewing = createMemo(() => markdown() && props.scope.markdownView(props.path) === "preview")

  const reloadFromDisk = () => {
    props.scope.discard(props.path)
    void file.load(props.path, { force: true })
  }

  return (
    <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
      <Show when={buffer()?.diskChanged}>
        <div class="shrink-0 h-8 px-3 flex items-center gap-2 text-12-regular bg-background-stronger border-b border-border-weaker-base">
          <span class="text-text-weak flex-1 truncate">{language.t("explorer.diskChanged")}</span>
          <button
            type="button"
            class="h-5.5 px-2 rounded-md text-12-medium text-text-strong hover:bg-surface-raised-base-hover"
            onClick={reloadFromDisk}
          >
            {language.t("explorer.diskChanged.reload")}
          </button>
          <button
            type="button"
            class="h-5.5 px-2 rounded-md text-12-regular text-text-weak hover:bg-surface-raised-base-hover"
            onClick={() => props.scope.dismissDiskChange(props.path)}
          >
            {language.t("explorer.diskChanged.keep")}
          </button>
        </div>
      </Show>

      <Switch>
        <Match when={editable() && previewing()}>
          <div class="flex-1 min-h-0 overflow-y-auto">
            <div class="px-6 py-4 max-w-200">
              <Markdown text={buffer()?.text ?? ""} class="text-13-regular" />
            </div>
          </div>
        </Match>
        <Match when={editable() && buffer()}>
          <Show when={props.path} keyed>
            {(path) => (
              <EditorSurface path={path} scope={props.scope} actions={props.actions} directory={props.directory} />
            )}
          </Show>
        </Match>
        <Match when={content() && !editable()}>
          <ReadonlyFile path={props.path} notice={tooLarge() ? language.t("explorer.readonly.large") : undefined} />
        </Match>
        <Match when={state()?.error}>
          {(error) => <div class="px-6 py-4 text-12-regular text-text-weak">{error()}</div>}
        </Match>
        <Match when={true}>
          <div class="px-6 py-4 text-12-regular text-text-weak">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        </Match>
      </Switch>
    </div>
  )
}
