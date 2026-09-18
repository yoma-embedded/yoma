/**
 * 页签行的方向键导航(WAI-ARIA 的 tablist 模式,自动激活)。
 *
 * 底部控制台与右栏的仪器页各有一排手写的 `role="tab"`。光有 `aria-selected` 是不够的:
 * 屏幕阅读器按 tablist 念出来之后,用户按的是 ←/→ 而不是 Tab —— 不接的话左右键什么都不做,
 * 而 Tab 会把焦点一格一格挪出页签行去。两处一份实现,免得写两遍走样。
 *
 * 自动激活(移到哪一格就切到哪一台)是这里正确的取舍:切页签只是换一份**已经在内存里**的
 * 只读视图,没有请求、没有副作用,所以不需要 ARIA 那套"手动激活"的补丁。
 */
export function handleTablistKeys(event: KeyboardEvent) {
  const key = event.key
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return

  const current = event.target as HTMLElement | null
  const list = current?.closest('[role="tablist"]')
  if (!list) return
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].filter((tab) => !tab.disabled)
  if (tabs.length < 2) return

  const index = tabs.indexOf(current as HTMLButtonElement)
  if (index < 0) return

  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? tabs.length - 1
        : // 环形:最后一格再按 → 回到第一格,同 VS Code / 浏览器标签页。
          (index + (key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length

  event.preventDefault()
  tabs[next]?.focus()
  tabs[next]?.click()
}
