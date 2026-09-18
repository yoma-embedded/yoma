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
import { benchPins, instrumentById, isVisible } from "../bench/instruments"
import { useLogFeed } from "../bench/log-feed"
import { TargetStrip } from "../bench/target-strip"
import { debug as dock } from "../debug/debug-data"
import { consoleUI } from "./console-state"
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

  const reveal = (id: InstrumentId) => {
    const instrument = instrumentById(id)
    if (!instrument) return
    // 藏着的那台点一下就钉住 —— 不钉的话打开了也立刻消失。
    if (!isVisible(instrument, bench.ctx())) benchPins.pin(id)
    if (instrument.surface === "text") {
      consoleUI.open(id)
      return
    }
    dock.open()
    dock.setMode("debug")
    consoleUI.setRail(id)
  }

  const toggleKey = () => command.keybind("console.toggle")

  /** 日志那一格:控制台收着的这段时间里又来了 error —— 灯变黄,但**不自动把控制台弹开**。 */
  const attention = createMemo(() => (unseenErrors() > 0 ? new Set<InstrumentId>(["log"]) : undefined))

  return (
    <footer class="ybench" data-component="session-status-bar" aria-label={t("session.statusBar.label")}>
      <TargetStrip
        status={bench.status()}
        onSelect={reveal}
        attention={attention()}
        emptyHint={t("session.bench.strip.empty")}
      />

      <span data-slot="rule" />

      <Show when={feed.state.name}>
        <span data-slot="readout" title={[feed.state.name, feed.state.path].filter(Boolean).join("\n")}>
          {/* 哪一份日志。名字里带时间戳,而"最新那一份"是面板自己挑的 —— 挑错了只有这里看得出来。
              挤不下时它先打省略号,后面的数字不让位。 */}
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
