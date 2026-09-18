/**
 * 状态栏最左的**目标格**,以及它带出来的那张目标卡。
 *
 * 状态栏本来那三格(烧录 / GDB / 日志)说的是"现在什么状况";这一格说的是**这是哪块板子** ——
 * 工程名加上认出来的芯片短名(`f405-motor-ctrl · stm32f4x`)。两件事不重复:身份不点灯,
 * 状况不写型号。什么都没认出来时它只剩工程名 —— 那也是答案,不是空格。
 *
 * 卡是**借来的**(`bench/target-card.tsx`,来自 v3-bench 的右侧工作台):固定三行读数,
 * 哪一行没发生过就是一条暗着的 `—`。v3 把它常驻在右栏顶上;状态栏只有 24px 高,所以这一版
 * 是一张悬停卡 —— 停 200ms 弹出来,移开就没,点一下钉住。
 *
 * 两处踩过的坑:
 * 1. **必须走 Portal。** 状态栏是 24px 高的 flex 行、控制台上面还有一层 `overflow: hidden`,
 *    卡直接挂在格子里会被裁成一条缝(v3 在抽屉里吃过这个亏)。所以它挂在 body 上,
 *    位置由格子的 `getBoundingClientRect()` 现算。
 * 2. **浮层自带 `.ybench`。** `bench.css` 的 token 块挂在 `.ybench` 与几个能独立存在的根上,
 *    而 `bench-target-card` 不在那张表里 —— 挂到 body 上之后没有任何祖先带 token,
 *    不补这个 class 的话 LED 与读数颜色全部落到 `initial`(黑底黑字,而且不报错)。
 */
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { useBench } from "../bench/bench-context"
import type { InstrumentId } from "../bench/bench-status"
import { TargetCard } from "../bench/target-card"
import { useTargetIdentity } from "../bench/use-target-identity"
import { targetCardPin } from "./target-card-state"
import "./target-slot.css"

/** 悬停多久才弹。再短一点的话,鼠标从聊天区扫过状态栏就会闪一张卡。 */
export const TARGET_CARD_HOVER_MS = 200
/** 移开之后的宽限:鼠标要从格子走到卡上,中间隔着 6px 的缝。 */
export const TARGET_CARD_CLOSE_MS = 120
/** 卡宽。三行读数里最长的是「GDB … 已结束 故障 foc.c:45」,320 够它一行说完。 */
export const TARGET_CARD_WIDTH = 320

export interface PopoverAnchor {
  left: number
  bottom: number
}

/**
 * 卡片相对视口的落点。**纯函数**:卡在格子正上方、左边对齐,贴不住就往里收 8px。
 *
 * 用 `bottom` 而不是 `top`:状态栏在整页最底下,卡是往上长的 —— 按 top 定位的话,
 * 内容多一行整张卡就往下盖住状态栏自己。
 */
export function anchorPopover(
  rect: { left: number; top: number },
  viewport: { width: number; height: number },
  width = TARGET_CARD_WIDTH,
  gap = 6,
): PopoverAnchor {
  const rightmost = Math.max(8, viewport.width - width - 8)
  return {
    left: Math.round(Math.min(Math.max(8, rect.left), rightmost)),
    bottom: Math.round(Math.max(8, viewport.height - rect.top + gap)),
  }
}

export function TargetSlot(props: { onSelect?: (id: InstrumentId) => void }) {
  const language = useLanguage()
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  const bench = useBench()
  const identity = useTargetIdentity()

  const [hovering, setHovering] = createSignal(false)
  const [anchor, setAnchor] = createStore<PopoverAnchor>({ left: 0, bottom: 0 })
  const pinned = targetCardPin.pinned
  const open = () => hovering() || pinned()

  let slot: HTMLButtonElement | undefined
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  // 指针 / 焦点在不在:三处各自记一份,由 `sync()` 合成"现在该不该开"。
  let overSlot = false
  let overCard = false
  let focused = false
  /** 刚刚点了"取消钉住"——鼠标还压在格子上,不能立刻又被悬停弹回来。 */
  let suppressed = false

  const clearTimers = () => {
    if (openTimer) clearTimeout(openTimer)
    if (closeTimer) clearTimeout(closeTimer)
    openTimer = undefined
    closeTimer = undefined
  }
  onCleanup(clearTimers)

  const sync = () => {
    const want = !suppressed && (overSlot || overCard || focused)
    if (want) {
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = undefined
      if (hovering() || openTimer) return
      openTimer = setTimeout(() => {
        openTimer = undefined
        setHovering(true)
      }, TARGET_CARD_HOVER_MS)
      return
    }
    if (openTimer) clearTimeout(openTimer)
    openTimer = undefined
    if (closeTimer || !hovering()) return
    closeTimer = setTimeout(() => {
      closeTimer = undefined
      setHovering(false)
    }, TARGET_CARD_CLOSE_MS)
  }

  /** 收起:把三处标记一起清掉,否则 `sync()` 会立刻把它弹回来。 */
  const dismiss = () => {
    clearTimers()
    overCard = false
    focused = false
    setHovering(false)
  }

  const place = () => {
    if (!slot || typeof window === "undefined") return
    const rect = slot.getBoundingClientRect()
    setAnchor(anchorPopover(rect, { width: window.innerWidth, height: window.innerHeight }))
  }

  // 位置在每次打开时现算,并跟着窗口尺寸走(1280 / 1440 之间拖窗口时卡不该留在原地)。
  createEffect(() => {
    if (!open()) return
    place()
    if (typeof window === "undefined") return
    window.addEventListener("resize", place)
    onCleanup(() => window.removeEventListener("resize", place))
  })

  // Esc 关掉;钉着的话 Esc 顺手取消钉住(否则按了没反应,看着像卡死)。
  createEffect(() => {
    if (!open() || typeof window === "undefined") return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (pinned()) targetCardPin.set(false)
      suppressed = true
      dismiss()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  const label = () => {
    const spec = [identity().project, identity().chip].filter(Boolean).join(" · ")
    return `${t("session.bench.target.label")} ${spec}`
  }

  const select = (id: InstrumentId) => {
    props.onSelect?.(id)
    if (!pinned()) dismiss()
  }

  return (
    <>
      <button
        type="button"
        ref={(element) => (slot = element)}
        data-component="bench-target-slot"
        data-pinned={pinned() ? "true" : undefined}
        aria-expanded={open() ? "true" : "false"}
        aria-pressed={pinned() ? "true" : "false"}
        aria-label={label()}
        title={t(pinned() ? "session.bench.target.unpin" : "session.bench.target.pin")}
        onPointerEnter={() => {
          overSlot = true
          sync()
        }}
        onPointerLeave={() => {
          overSlot = false
          suppressed = false
          sync()
        }}
        onFocus={() => {
          focused = true
          sync()
        }}
        onBlur={() => {
          focused = false
          sync()
        }}
        onClick={() => {
          if (pinned()) {
            targetCardPin.set(false)
            // 鼠标还在格子上,不压住的话 200ms 后它自己又弹出来了。
            suppressed = true
            dismiss()
            return
          }
          targetCardPin.set(true)
          clearTimers()
          setHovering(true)
        }}
      >
        <span data-slot="name">{identity().project}</span>
        <Show when={identity().chip}>
          {(chip) => (
            <>
              <span data-slot="sep" aria-hidden="true">
                ·
              </span>
              <span data-slot="chip">{chip()}</span>
            </>
          )}
        </Show>
      </button>

      <Show when={open()}>
        <Portal>
          <div
            class="ybench"
            data-component="bench-target-popover"
            data-pinned={pinned() ? "true" : undefined}
            style={{ left: `${anchor.left}px`, bottom: `${anchor.bottom}px`, width: `${TARGET_CARD_WIDTH}px` }}
            onPointerEnter={() => {
              overCard = true
              sync()
            }}
            onPointerLeave={() => {
              overCard = false
              sync()
            }}
          >
            <TargetCard
              status={bench.status()}
              identity={identity()}
              disk={{ logFiles: bench.disk().logFiles }}
              onSelect={select}
            />
          </div>
        </Portal>
      </Show>
    </>
  )
}
