/**
 * 日志面板 —— 工程 `.yoma/logs` 里最新那份硬件日志的尾巴。
 *
 * 它读的是**磁盘**(`log-feed.ts`),不是 transcript:采集停了、会话重开了,日志照样在。
 * 采集状态那一格才来自 transcript(`BenchStatus.log`),因为"还在采不采"只有工具知道。
 *
 * 2000 行还能滑动靠的是 CSS 的 `content-visibility: auto`(见 bench.css):视口外的行
 * 不排版不绘制,而 `contain-intrinsic-size` 给出占位高度,滚动条长度不会跳。
 * 没有虚拟列表 —— 这里要的是"简单且不会坏",行是定高的纯文本,浏览器自己就做得很好。
 */
import { createEffect, createMemo, Index, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useBenchStatus } from "./use-bench-status"
import { useLogFeed } from "./log-feed"
import { filterLogLines } from "./log-lines"
import { logHeadline } from "./bench-status"

export function LogPanel() {
  const language = useLanguage()
  const sdk = useSDK()
  const status = useBenchStatus()
  const feed = useLogFeed(() => sdk().directory)
  const [ui, setUi] = createStore({ filter: "" })

  let scroller: HTMLDivElement | undefined

  const lines = createMemo(() => filterLogLines(feed.state.lines, ui.filter))

  // 跟随尾部:新的一批行落地之后滚到底。用户自己往上翻时 onScroll 会把 follow 关掉。
  createEffect(
    on(
      () => [feed.state.lines.length, feed.state.updatedAt, ui.filter] as const,
      () => {
        if (!feed.state.follow || !scroller) return
        queueMicrotask(() => {
          if (scroller) scroller.scrollTop = scroller.scrollHeight
        })
      },
    ),
  )

  const onScroll = () => {
    if (!scroller) return
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24
    if (atBottom !== feed.state.follow) feed.setFollow(atBottom)
  }

  const capture = () => status().log
  const captureLabel = () => {
    const log = capture()
    if (!log) return undefined
    const head = log.capturing
      ? language.t("session.bench.state.capturing")
      : language.t("session.bench.state.stopped")
    return [head, logHeadline(log)].filter(Boolean).join(" ")
  }

  return (
    <div data-component="bench-log-panel">
      {/* 细头:左边是采集状态(一个词),右边是文件名与行数。仪器名在外层窗口的名牌上,
          这里不重复 —— 单独挂载(比如底部控制台)时状态词本身就是标题。 */}
      <div data-component="bench-panel-head">
        <span data-slot="title">{captureLabel() ?? language.t("session.bench.state.idle")}</span>
        <span data-slot="rule" />
        <span data-slot="meta" title={feed.state.path}>
          {[feed.state.name, language.t("session.bench.log.lines", { count: lines().length })]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      <div data-slot="toolbar">
        <input
          data-slot="filter"
          type="search"
          value={ui.filter}
          placeholder={language.t("session.bench.log.filter")}
          aria-label={language.t("session.bench.log.filter")}
          onInput={(event) => setUi("filter", event.currentTarget.value)}
        />
        <button
          type="button"
          data-slot="follow"
          aria-pressed={feed.state.follow ? "true" : "false"}
          onClick={() => {
            feed.setFollow(!feed.state.follow)
            if (!feed.state.follow && scroller) scroller.scrollTop = scroller.scrollHeight
          }}
        >
          {language.t("session.bench.log.follow")}
        </button>
        <button type="button" data-slot="refresh" onClick={() => feed.refresh()} title={language.t("session.bench.log.refresh")}>
          ↻
        </button>
      </div>

      <Show
        when={feed.state.name}
        fallback={
          <div data-component="bench-empty">
            {language.t("session.bench.log.empty")}
            <span data-slot="hint">{language.t("session.bench.log.emptyHint")}</span>
          </div>
        }
      >
        {/* 来源全文("serial /dev/cu.usbmodem1103 @ 115200 8N1")正是"我现在到底在听哪儿"的
            答案,只塞进标题的 title 属性太隐蔽了 —— 给它一行读数。 */}
        <Show when={capture()?.source}>
          {(source) => (
            <div data-component="bench-readout">
              <span data-slot="key">{language.t("session.bench.log.source")}</span>
              <span data-slot="dots" />
              <span data-slot="val">{source()}</span>
            </div>
          )}
        </Show>
        <Show when={feed.state.truncated}>
          <div data-slot="notice">{language.t("session.bench.log.truncated")}</div>
        </Show>
        <Show when={feed.state.clipped > 0}>
          <div data-slot="notice">{language.t("session.bench.log.clipped", { count: feed.state.clipped })}</div>
        </Show>
        <div
          data-slot="lines"
          ref={(element) => (scroller = element)}
          onScroll={onScroll}
          role="log"
          aria-live="off"
          aria-label={language.t("session.bench.instrument.log")}
        >
          {/* **`Index` 而不是 `For`**:每一拍的行都是新对象,`For` 按引用比,于是 2000 个
              DOM 节点每 2 秒整体重建 —— 用户正选中的一段栈回溯会被清掉(复制不走),
              节点重排还会夹一次 scrollTop 把"跟随"关掉。`Index` 按下标复用节点,只更新变了的字。 */}
          <Index
            each={lines()}
            fallback={<div data-slot="line" data-level="info"><span data-slot="text">{language.t("session.bench.log.noMatch")}</span></div>}
          >
            {(line) => (
              <div data-slot="line" data-level={line().level}>
                <span data-slot="no">{line().no}</span>
                <span data-slot="text">{line().text}</span>
              </div>
            )}
          </Index>
        </div>
        <Show when={feed.state.error}>
          <div data-slot="notice">{feed.state.error}</div>
        </Show>
      </Show>
    </div>
  )
}
