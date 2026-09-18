/**
 * 会话页最底下那一条状态栏 —— **目标板的在场**。
 *
 * 不用点、不用切页、不用记得右栏有第三档:烧了哪一版、gdb 停在哪、串口还在不在吐字,
 * 一直在余光里。这是这套界面与"一个深色的通用聊天应用"之间唯一不用解释的差别。
 *
 * 右半边两样:
 * - 一行轻量读数(日志行数 / 还没看过的 error 数)。它们来自**已经在读的那份 feed**
 *   (`log-feed.ts` 按工程目录引用计数),不额外发请求;
 * - 控制台开合。
 *
 * 点状态条上的一格 = 打开对应的地方:文本流仪器(日志 / GDB)开底部控制台的那一页签,
 * 波形仪器(示波器 / LA)切右栏。哪一台走哪条路由注册表的 `surface` 说了算,这里不写死。
 */
import { createEffect, createMemo, Show } from "solid-js"
import { Icon } from "@yoma-desktop/ui/icon"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useBench } from "../bench/bench-context"
import type { InstrumentId } from "../bench/bench-status"
import { useLogFeed } from "../bench/log-feed"
import { TargetStrip } from "../bench/target-strip"
import { consoleUI } from "./console-state"
import { dotsBesideAttention, useUnseenSet } from "./evidence-view"
import { revealInstrument } from "./reveal-instrument"
import { TargetSlot } from "./target-slot"
import "./console.css"

export function SessionStatusBar() {
  const language = useLanguage()
  const command = useCommand()
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  const sdk = useSDK()
  const bench = useBench()
  /**
   * 状态栏自己也订一份日志 —— 于是**会话页开着就一直有一份 2 秒一拍的轮询**(而不是像
   * foundation 那样"右栏切到调试档才有")。这是这一版的一笔明账:要在状态栏上说"多少行、
   * 几条还没看的 error",就得有人在读那个文件。feed 按工程目录引用计数,控制台开着时
   * 两边共用同一次轮询,不会变成两份。
   */
  const feed = useLogFeed(() => sdk().directory)

  const errors = createMemo(() => feed.state.lines.reduce((n, line) => (line.level === "error" ? n + 1 : n), 0))
  /** 控制台收着(或没停在日志页)时新来的 error —— 状态条那一格据此变 attention。 */
  const unseenErrors = createMemo(() => Math.max(0, errors() - consoleUI.seenErrors()))

  // 控制台开着且停在日志页 = 用户正看着它,水位一直推平。
  createEffect(() => {
    if (consoleUI.opened() && consoleUI.tab() === "log") consoleUI.markErrorsSeen(errors())
  })

  // 点一格去哪、藏着的要不要先钉住 —— 规则在 `reveal-instrument.ts`,与卡片上的
  // 「在面板中打开」共用同一份(别在这里再写一遍)。
  const reveal = (id: InstrumentId) => void revealInstrument(id, bench.ctx())

  const toggleKey = () => command.keybind("console.toggle")

  /** 日志那一格:控制台收着的这段时间里又来了 error —— 灯变黄,但**不自动把控制台弹开**。 */
  const attention = createMemo(() => (unseenErrors() > 0 ? new Set<InstrumentId>(["log"]) : undefined))

  /**
   * 「有我还没看过的新证据」的提示点(`bench/evidence.ts`)—— 对应面板收着的那些才点,
   * 已经挂了黄灯的那一格让给黄灯(取舍在 `dotsBesideAttention`,那里有为什么)。
   */
  const unseen = useUnseenSet()
  const dots = createMemo(() => dotsBesideAttention(unseen(), attention()))

  return (
    <footer class="ybench" data-component="session-status-bar" aria-label={t("session.statusBar.label")}>
      {/* 最左是身份(这是哪块板子),右边才是状况(烧录 / GDB / 日志)。两件事不重复。 */}
      <TargetSlot onSelect={reveal} />

      <TargetStrip
        status={bench.status()}
        onSelect={reveal}
        attention={attention()}
        unseen={dots()}
        emptyHint={t("session.bench.strip.empty")}
      />

      <span data-slot="rule" />

      <Show when={feed.state.name}>
        <span data-slot="readout" title={[feed.state.name, feed.state.path].filter(Boolean).join("\n")}>
          {/* 哪一份日志。名字里带时间戳,而"最新那一份"是面板自己挑的 —— 挑错了只有这里看得出来。
              挤不下时它先打省略号,后面的数字不让位。 */}
          {/* 这次会话没碰过 log 工具、而工程里躺着上一次的日志时(状态条上因此没有「日志」那一格),
              先说一句"上一次的" —— 否则左边说没采过、右边报着 18 行,同一条栏自相矛盾(复审 D2)。 */}
          <Show when={!bench.status().log}>
            <span data-slot="stale">{t("session.bench.log.fromDiskShort")}</span>
          </Show>
          <span data-slot="file">{feed.state.name}</span>
          <span aria-hidden="true">·</span>
          <span>{language.t("session.bench.log.lines", { count: feed.state.lines.length })}</span>
          <Show when={unseenErrors() > 0}>
            <span aria-hidden="true">·</span>
            <span data-level="error" title={t("session.statusBar.unreadErrorsHint")}>
              {language.t("session.statusBar.unreadErrors", { count: unseenErrors() })}
            </span>
          </Show>
        </span>
      </Show>

      <button
        type="button"
        data-slot="console-toggle"
        aria-pressed={consoleUI.opened() ? "true" : "false"}
        aria-label={t("session.console.toggle")}
        title={[t("session.console.toggle"), toggleKey()].filter(Boolean).join(" ")}
        onClick={() => consoleUI.toggle()}
      >
        <Icon name={consoleUI.opened() ? "layout-bottom-full" : "layout-bottom"} size="small" />
        <span>{t("session.console.title")}</span>
        <Show when={toggleKey()}>{(key) => <kbd>{key()}</kbd>}</Show>
      </button>
    </footer>
  )
}
