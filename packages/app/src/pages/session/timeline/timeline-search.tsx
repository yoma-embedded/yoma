import { createEffect, createMemo, mapArray, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { debounce } from "@solid-primitives/scheduled"
import type { Part } from "@yoma-desktop/kernel"
import { Icon } from "@yoma-desktop/ui/icon"
import { useLanguage } from "@/context/language"
import {
  centerRange,
  collectRanges,
  countOccurrences,
  locateMatch,
  SEARCH_ACTIVE,
  SEARCH_HIT,
  searchableText,
  startIndex,
  type SearchTarget,
} from "./search"
import "./timeline-search.css"

/** 打字停这么久才真去搜:每改一个字都要把整个会话的字过一遍。 */
const QUERY_DELAY_MS = 120
/** 跳到一处之后追着找它的帧数:那一行要先被虚拟列表画出来,收着的工具卡展开后正文还要再等两帧。 */
const SEEK_FRAMES = 30

const supportsHighlights = () => typeof CSS !== "undefined" && typeof Highlight !== "undefined" && !!CSS.highlights

function paint(name: string, ranges: Range[]) {
  const highlight = new Highlight()
  for (const range of ranges) highlight.add(range)
  CSS.highlights.set(name, highlight)
}

function clearPaint() {
  if (!supportsHighlights()) return
  CSS.highlights.delete(SEARCH_HIT)
  CSS.highlights.delete(SEARCH_ACTIVE)
}

/**
 * 会话内搜索条。只在开着的时候挂载 —— 索引(每个 part 一份小写副本 + 计数)和盯着 DOM 变化的观察器都跟着它走,
 * 关掉就全部释放,平时的流式渲染不为它多花一分钱。
 *
 * 索引按 part 各记一个 memo(和行的投影同一个道理):流式增量只重数正在长的那一段,改词才全部重数。
 */
export function TimelineSearch(props: {
  /** 时间线上画得出来的 part,从上到下。 */
  parts: Part[]
  rowOf: (partID: string) => number | undefined
  firstVisibleRow: () => number
  showReasoning: boolean
  root: HTMLElement | undefined
  /** 更早的消息还没加载进来:搜不到它们,得说一声。 */
  partial: boolean
  /** 再按一次 cmd+F 时加一:把焦点拿回输入框并全选。 */
  focusTick: number
  /** 让那一行滚进视口、把收着的卡片打开、停掉跟随到底。 */
  onReveal: (partID: string) => void
  onClose: () => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ value: "", needle: "", active: 0 })
  let input: HTMLInputElement | undefined
  let seekFrame: number | undefined

  const index = mapArray(
    () => props.parts,
    (part) => {
      const lower = createMemo(() => searchableText(part, props.showReasoning).toLowerCase())
      const count = createMemo(() => (state.needle ? countOccurrences(lower(), state.needle) : 0))
      return { partID: part.id, count }
    },
  )
  const entries = createMemo(() => index().map((item) => ({ partID: item.partID, count: item.count() })))
  const total = createMemo(() => entries().reduce((sum, entry) => sum + entry.count, 0))
  const active = createMemo(() => (total() === 0 ? 0 : Math.min(state.active, total() - 1)))
  const target = createMemo<SearchTarget | undefined>(() => locateMatch(entries(), active()), undefined, {
    equals: (a, b) => a?.partID === b?.partID && a?.occurrence === b?.occurrence,
  })

  const cancelSeek = () => {
    if (seekFrame === undefined) return
    cancelAnimationFrame(seekFrame)
    seekFrame = undefined
  }

  const reveal = (next: SearchTarget | undefined) => {
    cancelSeek()
    if (!next) return
    props.onReveal(next.partID)
    let frames = 0
    const seek = () => {
      seekFrame = undefined
      const root = props.root
      if (!root) return
      const found = collectRanges(root, state.needle, next)
      const last = frames >= SEEK_FRAMES
      if (found.active && (found.exact || last)) return centerRange(found.active, root)
      // 数据层有、DOM 里圈不到(命中在链接的 URL 里、卡片把输出排成了别的样子):至少把那张卡摆到眼前。
      if (last) return found.activeElement?.scrollIntoView({ block: "center" })
      frames += 1
      seekFrame = requestAnimationFrame(seek)
    }
    seekFrame = requestAnimationFrame(seek)
  }

  const commit = (value: string) => {
    setState({ needle: value.trim().toLowerCase(), active: 0 })
    if (total() === 0) return reveal(undefined)
    setState("active", startIndex(entries(), props.rowOf, props.firstVisibleRow()))
    reveal(target())
  }
  const applyNeedle = debounce(commit, QUERY_DELAY_MS)

  const move = (delta: number) => {
    // 还在防抖里就按了回车:先把词落下去,不然这一下是在旧词的结果里跳。
    if (state.value.trim().toLowerCase() !== state.needle) {
      applyNeedle.clear()
      return commit(state.value)
    }
    if (total() === 0) return
    setState("active", (active() + delta + total()) % total())
    reveal(target())
  }

  createEffect(() => {
    const root = props.root
    const needle = state.needle
    const current = target()
    if (!root || !needle || !supportsHighlights()) return clearPaint()
    let frame: number | undefined
    const apply = () => {
      frame = undefined
      const found = collectRanges(root, needle, current)
      paint(SEARCH_HIT, found.hits)
      paint(SEARCH_ACTIVE, found.active ? [found.active] : [])
    }
    apply()
    // 虚拟列表换行、流式长字、卡片展开都会让范围失效(节点没了)或者漏圈(新画出来的)。一帧最多重圈一次。
    const observer = new MutationObserver(() => {
      if (frame === undefined) frame = requestAnimationFrame(apply)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    onCleanup(() => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    })
  })

  createEffect(
    on(
      () => props.focusTick,
      () => {
        input?.focus()
        input?.select()
      },
      { defer: true },
    ),
  )

  onMount(() => input?.focus())
  onCleanup(() => {
    applyNeedle.clear()
    cancelSeek()
    clearPaint()
  })

  return (
    <div data-component="timeline-search" role="search">
      <label data-slot="timeline-search-field">
        <Icon name="magnifying-glass" size="small" />
        <input
          ref={(el) => (input = el)}
          data-slot="timeline-search-input"
          type="text"
          spellcheck={false}
          autocomplete="off"
          value={state.value}
          placeholder={language.t("session.search.placeholder")}
          aria-label={language.t("session.search.placeholder")}
          onInput={(event) => {
            setState("value", event.currentTarget.value)
            applyNeedle(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              event.stopPropagation()
              props.onClose()
              return
            }
            if (event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return
            if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              event.stopPropagation()
              move(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1)
            }
          }}
        />
        <Show when={state.needle}>
          <span data-slot="timeline-search-count" data-empty={total() === 0 || undefined}>
            {total() === 0 ? language.t("session.search.noResults") : `${active() + 1}/${total()}`}
          </span>
        </Show>
      </label>
      <button
        type="button"
        data-slot="timeline-search-button"
        data-direction="previous"
        disabled={total() === 0}
        aria-label={language.t("session.search.previous")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => move(-1)}
      >
        <Icon name="chevron-down" size="small" />
      </button>
      <button
        type="button"
        data-slot="timeline-search-button"
        disabled={total() === 0}
        aria-label={language.t("session.search.next")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => move(1)}
      >
        <Icon name="chevron-down" size="small" />
      </button>
      <button
        type="button"
        data-slot="timeline-search-button"
        aria-label={language.t("session.search.close")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onClose}
      >
        <Icon name="close-small" size="small" />
      </button>
      <Show when={props.partial}>
        <div data-slot="timeline-search-note">{language.t("session.search.partial")}</div>
      </Show>
    </div>
  )
}
