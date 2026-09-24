/**
 * 「把这台仪器亮出来」——v2-console 这套布局里"打开一台仪器"的**唯一**一份实现。
 *
 * 从前它是 `session-status-bar.tsx` 里的一个闭包(`reveal`)。时间线里的卡片多了一个
 * 「在面板中打开」之后就有了第二个调用点,而这件事的规则不止一条:
 *
 * 1. **去哪由注册表的 `surface` 说了算**,不是由调用点写死:`text`(日志)去底部控制台的
 *    那一页签,`wave`(调试器 / 示波器 / 逻辑分析仪)去右栏。加下一台仪器时这里一个字不用改。
 * 2. **藏着的那台要先钉住** —— 可见集是"核心 ∪ 用过 ∪ 有数据 ∪ 钉住"算出来的,不钉的话
 *    打开了也会在下一拍消失(右栏只摊开可见集里的那一台)。
 * 3. 波形那条路要同时做三件事(展开右栏、把模式切到「调试」、选中那一台),漏一件的表现
 *    是"点了没反应":右栏收着的时候,只 setRail 谁都看不见。
 *
 * 认不出来的 id 一律**静默忽略**而不是抛:session-ui 那边的工具清单与这边的注册表各有一份,
 * 两边漂移时该表现为"那个按钮没反应",不该是一个红屏。
 */
import { EMPTY_BENCH_STATUS, type InstrumentId } from "../bench/bench-status"
import { benchPins, EMPTY_BENCH_DISK, instrumentById, isVisible, type InstrumentContext } from "../bench/instruments"
import { debug as dock } from "../debug/debug-data"
import { consoleUI } from "./console-state"

/** 这台仪器现在是不是正摊在它自己的那一面上。顶栏按钮的按下态和「再点一次收起」用同一条。 */
export function instrumentShown(id: InstrumentId, ctx: InstrumentContext): boolean {
  const instrument = instrumentById(id)
  if (!instrument) return false
  if (instrument.surface === "text") return consoleUI.opened() && consoleUI.tab() === id
  return dock.opened() && dock.mode() === "debug" && consoleUI.rail() === id && isVisible(instrument, ctx)
}

/**
 * 顶栏那一排:没开就打开,开着再点就收起。
 * 文本仪器收的是底部控制台,波形仪器收的是右栏。
 */
export function toggleInstrument(id: InstrumentId, ctx: InstrumentContext): boolean {
  const instrument = instrumentById(id)
  if (!instrument) return false
  if (instrumentShown(id, ctx)) {
    if (instrument.surface === "text") {
      consoleUI.close()
      // 再点一次是把这一下打开的东西收回去。空的波形页不是用户点开的,跟着收。
      if (dock.opened() && dock.mode() === "debug" && !consoleUI.rail()) dock.close()
    } else dock.close()
    return true
  }
  return revealInstrument(id, ctx)
}

/**
 * 首页卡片进会话。文本仪器只留控制台:右栏若还停在波形档(包括上一回点开的示波器),
 * 收起来,别跟进这个新会话。
 */
export function openWorkbenchInstrument(id: InstrumentId): boolean {
  const opened = revealInstrument(id, usedInstrumentContext(id))
  const instrument = instrumentById(id)
  if (opened && instrument?.surface === "text" && dock.mode() === "debug") dock.close()
  return opened
}

/** 亮出这台仪器。认得出来并且真去开了返回 true。 */
export function revealInstrument(id: InstrumentId, ctx: InstrumentContext): boolean {
  const instrument = instrumentById(id)
  if (!instrument) return false
  if (!isVisible(instrument, ctx)) benchPins.pin(id)
  if (instrument.surface === "text") {
    consoleUI.open(id)
    // 没人点过波形仪器时,右栏停在空的「波形」页。那是跟着日志一起冒出来的,收掉。
    // 已经点过示波器 / 逻辑分析仪(rail 有值)就留着,两台可以同时开。
    if (dock.opened() && dock.mode() === "debug" && !consoleUI.rail()) dock.close()
    return true
  }
  dock.open()
  dock.setMode("debug")
  consoleUI.setRail(id)
  return true
}

/**
 * 时间线里那张卡片自己就是"这次会话用过这台仪器"的证据 —— 于是 `isVisible` 必定成立,
 * 上面第 2 条那一步是个空操作。
 *
 * 为什么不直接把真的 `useBench().ctx()` 递进来:`DataProvider`(卡片回调的挂点)在路由的
 * 目录层,而 `BenchProvider` 挂在会话页里面,外层够不着。与其为了一个必然成立的判断把
 * provider 往上搬,不如在这里把那条证据写明白。磁盘那一半同理不参与判断(`use-console-commands.ts`
 * 里的命令面板走的是同一种取舍)。
 */
export function usedInstrumentContext(id: InstrumentId): InstrumentContext {
  return {
    status: { ...EMPTY_BENCH_STATUS, used: new Set<InstrumentId>([id]) },
    disk: EMPTY_BENCH_DISK,
    pinned: benchPins.all(),
  }
}
