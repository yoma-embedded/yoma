/**
 * 调试工具条的图标。ui 的图标库里没有步进这一族,形状照 VS Code 调试栏:
 * 跳过 = 弧线越过一个点,进入 = 箭头落进点,跳出 = 箭头从点里出来。16×16,描边用 currentColor。
 */
import type { JSX } from "solid-js"

export type GdbIconName = "continue" | "pause" | "over" | "into" | "out" | "restart" | "disconnect"

// 值是函数:Solid 的 JSX 在求值那一刻就建好 DOM 节点,模块级共享一个节点的话,
// 第二个按钮会把它从第一个按钮里"搬走"。
const PATHS: Record<GdbIconName, () => JSX.Element> = {
  continue: () => <path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none" />,
  pause: () => (
    <>
      <rect x="4.5" y="3.5" width="2.5" height="9" fill="currentColor" stroke="none" />
      <rect x="9" y="3.5" width="2.5" height="9" fill="currentColor" stroke="none" />
    </>
  ),
  over: () => (
    <>
      <path d="M2.5 9.5a5.5 5.5 0 0 1 10.6-2" fill="none" />
      <path d="M13.5 4.5v3.2h-3.2" fill="none" />
      <circle cx="8" cy="12.5" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  into: () => (
    <>
      <path d="M8 2v7" fill="none" />
      <path d="M5 6.5L8 9.5l3-3" fill="none" />
      <circle cx="8" cy="13" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  out: () => (
    <>
      <path d="M8 10V3" fill="none" />
      <path d="M5 5.5L8 2.5l3 3" fill="none" />
      <circle cx="8" cy="13" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  restart: () => (
    <>
      <path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" fill="none" />
      <path d="M11.8 2v3h-3" fill="none" />
    </>
  ),
  disconnect: () => <rect x="4" y="4" width="8" height="8" fill="currentColor" stroke="none" />,
}

export function GdbIcon(props: { name: GdbIconName }) {
  return (
    <svg
      data-slot="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {PATHS[props.name]()}
    </svg>
  )
}
