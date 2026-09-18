/**
 * 提示点在 **v2-console 这个布局里**的接线:哪几台仪器此刻"开着",于是哪几台该点提示点。
 *
 * 证据本身(指纹、看过没看过)在 `bench/evidence.ts`,与布局无关。这个文件回答的是布局
 * 才知道的那半句:**"开着"在这一版里等于什么。**
 *
 * - 文本流仪器(日志 / GDB):底部控制台开着,而且停在它那一页。
 * - 波形仪器(示波器 / 逻辑分析仪):右栏展开、停在「调试」档,而且页签选的是它。
 *
 * 收着的时候证据才会积累 —— 面板开着时新东西直接就在眼前,再点一个点是噪声。
 */
import { createEffect, createMemo, type Accessor } from "solid-js"
import { useSessionKey } from "@/pages/session/session-layout"
import { useBench } from "../bench/bench-context"
import type { InstrumentId } from "../bench/bench-status"
import { markSeen, unseenInstruments } from "../bench/evidence"
import { visibleOnSurface, type InstrumentContext, type InstrumentSurface } from "../bench/instruments"
import { debug as dock } from "../debug/debug-data"
import { consoleUI } from "./console-state"

/**
 * 某一种数据形状里此刻显示的是哪一台。
 *
 * 与 `session-console.tsx` / `instrument-rail.tsx` 里那两个 `active` memo 同一条规矩:
 * 记着的那台不在了就回落到第一台。两边都要能单独回答这个问题(状态栏够不着那两个组件的
 * 局部 memo),所以规则写在这里一份。
 */
export function activeOnSurface(
  surface: InstrumentSurface,
  ctx: InstrumentContext,
  want: InstrumentId | undefined,
): InstrumentId | undefined {
  const list = visibleOnSurface(surface, ctx)
  return (list.find((instrument) => instrument.id === want) ?? list[0])?.id
}

/** 此刻用户正看着的那些仪器(0–2 台:底部控制台一台、右栏一台)。 */
export function openInstruments(ctx: InstrumentContext): Set<InstrumentId> {
  const open = new Set<InstrumentId>()
  if (consoleUI.opened()) {
    const id = activeOnSurface("text", ctx, consoleUI.tab())
    if (id) open.add(id)
  }
  if (dock.opened() && dock.mode() === "debug") {
    const id = activeOnSurface("wave", ctx, consoleUI.rail())
    if (id) open.add(id)
  }
  return open
}

/**
 * 同一格上「黄灯 + 条数」与提示点的取舍:**黄灯赢**。
 *
 * 今天只有日志那一格两样都会成立(控制台收着的这段时间里又来了 error,而那一套还带条数)。
 * 但这里**按集合算、不写死 `log`** —— 多一台仪器有了自己的 attention 来源时,
 * 规矩该自动对它也成立,而不是等人想起来再加一个 id(同 flash 那道确认门的教训:
 * 话术写死某一个工具,下一个工具来的时候就是假话)。
 *
 * 两个记号挤在一格上只会让人问哪个是哪个:出了事的那一格说"出了什么事、几条",
 * 没出事只是多了些行的那一格才安静地点一个点。
 */
export function dotsBesideAttention(
  unseen: ReadonlySet<InstrumentId>,
  attention: ReadonlySet<InstrumentId> | undefined,
): ReadonlySet<InstrumentId> {
  if (!attention?.size) return unseen
  let next: Set<InstrumentId> | undefined
  for (const id of attention) {
    if (!unseen.has(id)) continue
    next ??= new Set(unseen)
    next.delete(id)
  }
  return next ?? unseen
}

/** 此刻该点提示点的那些仪器。状态栏 / 控制台页签 / 右栏页签三处都读它。 */
export function useUnseenSet(): Accessor<ReadonlySet<InstrumentId>> {
  const bench = useBench()
  const { params } = useSessionKey()
  return createMemo(() => {
    const ctx = bench.ctx()
    return unseenInstruments(ctx, params.id, openInstruments(ctx))
  })
}

/**
 * 开着的那台就算看过了。
 *
 * 挂在容器组件上(控制台、右栏),`active` 为 undefined 时什么都不做 —— 控制台收着、
 * 右栏不在调试档时,证据继续积累。面板开着时它每拍都会跑,`benchSeen.record` 自己先比一次
 * 再落盘,所以不会每 100 ms 打一次 localStorage。
 */
export function useMarkSeen(active: () => InstrumentId | undefined) {
  const bench = useBench()
  const { params } = useSessionKey()
  createEffect(() => {
    const id = active()
    if (!id) return
    markSeen(id, bench.ctx(), params.id)
  })
}
