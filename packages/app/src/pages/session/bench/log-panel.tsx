/**
 * 日志面板 —— 工程 `.yoma/logs` 里最新那份硬件日志的尾巴。
 *
 * 它读的是**磁盘**(`log-feed.ts`),不是 transcript:采集停了、会话重开了,日志照样在。
 * 串口控制与状态直接查询会话持有的采集器;手动操作与 agent 共用同一个日志源。
 *
 * 2000 行还能滑动靠的是 CSS 的 `content-visibility: auto`(见 bench.css):视口外的行
 * 不排版不绘制,而 `contain-intrinsic-size` 给出占位高度,滚动条长度不会跳。
 * 没有虚拟列表 —— 这里要的是"简单且不会坏",行是定高的纯文本,浏览器自己就做得很好。
 *
 * **拆成三件是为了能被容器拆开摆**(底部控制台把过滤框提到了页签行上):
 * - `<LogControls/>` 过滤框 / 跟随 / 重读;
 * - `<LogBody/>` 来源读数 + 提示 + 行区;
 * - `<LogPanel/>` 名牌 + 上面两件(注册表的缺省装配,右栏那种"一台仪器一个窗口"的摆法)。
 *
 * 底部控制台只有日志这一台时**不画自己的页签行**(2026-09-23):它把最大化 / 关闭递进来(`chrome`),
 * `<LogBody/>` 把过滤框和它们一起挂到串口那一行工具条的右端 —— 日志上面只剩一行。
 * 三件都无 props、都自己去 `useLogFeed()` 拿同一份(按工程目录引用计数的)feed,所以
 * 过滤词与跟随开关住在 feed 的 store 里而不是组件里 —— 不然页签行上的框和下面的行区各过滤各的。
 */
import { createEffect, createMemo, Index, on, Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useBenchStatus } from "./use-bench-status"
import { useLogFeed } from "./log-feed"
import { filterLogLines } from "./log-lines"
import { logCaptureLabel } from "./bench-status"
import { SerialControls } from "./serial-controls"
import { serialCopy } from "./serial-copy"

/** 过滤框 + 跟随 + 重读。容器决定它站哪一行(面板里自己一行,控制台里挤在页签行右边)。 */
export function LogControls() {
  const language = useLanguage()
  const sdk = useSDK()
  const feed = useLogFeed(() => sdk().directory)

  /**
   * 过滤之后的命中数。**过滤是有损的,而且没有别的地方说得出这件事**:行号保留的是原始行号
   * (跳号勉强看得出在过滤),状态栏那一格说的是整份文件的总行数 —— 于是"18 行"与屏幕上的
   * 9 行同屏出现,看起来像日志丢了一半。只在真过滤时出现,不占平时的位置。
   */
  const matched = createMemo(() => (feed.state.filter ? filterLogLines(feed.state.lines, feed.state.filter).length : 0))

  return (
    <>
      <input
        data-slot="filter"
        type="search"
        value={feed.state.filter}
        placeholder={language.t("session.bench.log.filter")}
        aria-label={language.t("session.bench.log.filter")}
        onInput={(event) => feed.setFilter(event.currentTarget.value)}
      />
      <Show when={feed.state.filter}>
        <span data-slot="match" data-empty={matched() === 0 ? "true" : "false"}>
          {language.t("session.bench.log.match", { shown: matched(), total: feed.state.lines.length })}
        </span>
      </Show>
      <button
        type="button"
        data-slot="follow"
        aria-pressed={feed.state.follow ? "true" : "false"}
        onClick={() => feed.setFollow(!feed.state.follow)}
      >
        {language.t("session.bench.log.follow")}
      </button>
      <button
        type="button"
        data-slot="refresh"
        onClick={() => feed.refresh()}
        aria-label={language.t("session.bench.log.refresh")}
        title={language.t("session.bench.log.refresh")}
      >
        ↻
      </button>
    </>
  )
}

/**
 * 来源读数 + 提示 + 行区。容器给它多少高度就用多少(bench.css 给了一个保底的 max-height)。
 *
 * `chrome`:容器**没有**自己的页签行时递进来的那几颗按钮。给了它,过滤框 / 跟随 / 重读也由这里挂上
 * (没有页签行替它们站),工具条的读数在没连着时说"这份日志是哪来的"(页签行名牌右边原来那句)。
 */
export function LogBody(props: { chrome?: () => JSX.Element }) {
  const language = useLanguage()
  const sdk = useSDK()
  const status = useBenchStatus()
  const feed = useLogFeed(() => sdk().directory)
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  /** 同注册表里日志的 `headline`:这次会话碰过 log 工具就说它的状态,否则说"磁盘上的上一次采集"。 */
  const note = () =>
    !props.chrome
      ? undefined
      : (logCaptureLabel(status().log, t, { full: true }) ??
        (feed.state.name ? t("session.bench.log.fromDisk") : undefined))

  let scroller: HTMLDivElement | undefined

  const lines = createMemo(() => filterLogLines(feed.state.lines, feed.state.filter))

  // 跟随尾部:新的一批行落地之后滚到底。用户自己往上翻时 onScroll 会把 follow 关掉。
  // `follow` 也进依赖:把开关重新按上时行没变,不看它的话得等下一拍才回到底。
  createEffect(
    on(
      () => [feed.state.lines.length, feed.state.updatedAt, feed.state.filter, feed.state.follow] as const,
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

  return (
    <SerialControls
      onChange={() => feed.refresh()}
      note={note()}
      toolbar={
        props.chrome ? (
          <>
            <div data-slot="controls">
              <LogControls />
            </div>
            {props.chrome()}
          </>
        ) : undefined
      }
    >
      <Show
        when={feed.state.name}
        fallback={
          <div data-slot="idle">
            {serialCopy[language.locale()].empty} · {serialCopy[language.locale()].emptyHint}
          </div>
        }
      >
        {/* 来源全文("serial /dev/cu.usbmodem1103 @ 115200 8N1")正是"我现在到底在听哪儿"的
          答案,只塞进标题的 title 属性太隐蔽了 —— 给它一行读数。 */}
        <Show when={status().log?.source}>
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
            fallback={
              <div data-slot="line" data-level="info">
                <span data-slot="text">{language.t("session.bench.log.noMatch")}</span>
              </div>
            }
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
    </SerialControls>
  )
}

/**
 * 容器自己带了名牌与工具条(底部控制台)时用这一件:只有正文。
 * 外面这层 `bench-log-panel` 还在,因为 bench.css 的行区样式挂在它下面。
 * `chrome` 见 `LogBody`:容器没画页签行时,它的按钮由这里挂到串口那一行上。
 */
export function LogCompact(props: { chrome?: () => JSX.Element }) {
  return (
    <div data-component="bench-log-panel" data-chrome="bare">
      <LogBody chrome={props.chrome} />
    </div>
  )
}

export function LogPanel() {
  const language = useLanguage()
  const sdk = useSDK()
  const status = useBenchStatus()
  const feed = useLogFeed(() => sdk().directory)
  const captureLabel = () => logCaptureLabel(status().log, (key) => language.t(key as Parameters<typeof language.t>[0]))
  const lines = createMemo(() => filterLogLines(feed.state.lines, feed.state.filter))

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
        <LogControls />
      </div>

      <LogBody />
    </div>
  )
}
