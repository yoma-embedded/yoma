/**
 * 授权状态的**唯一**共享来源。授权页、提交失败提示、调试台横幅都读它。
 *
 * 为什么是**模块级** `createStore` 而不是 context:三个消费者住在三棵不同的子树上
 * (设置对话框走 `dialog.show` 另起一个 root、调试台是另一条路由、提交路径在会话页),
 * 各自拉一次 `license.status` 的代价不是多一个 RPC,而是**三份可能不一致的答案**
 * —— 导入成功之后只有正在看的那一份会刷新,另外两处继续按旧状态说话。
 *
 * 界面只**显示**这个状态。能不能开始一轮由内核在执行入口自己判,这里不做任何放行判断,
 * 也不往内核传"已付费"之类的东西(协议里也没有这样的参数)。
 */

import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { LicenseStatusView } from "@yoma-desktop/kernel"
import { useServerSDK } from "@/context/server-sdk"
import { kernel } from "@/utils/kernel"
import { nextLicenseCheckDelay } from "./format"

interface LicenseStoreState {
  status?: LicenseStatusView
  /** 第一次问过内核了吗(问出错也算,免得每个消费者都重打一枪)。 */
  loaded: boolean
  loading: boolean
  /** `license.status` 本身失败了(内核还没起来 / web host 没有内核通道)。 */
  error?: string
}

const [state, setState] = createStore<LicenseStoreState>({ loaded: false, loading: false })

/** 在飞的那一次 `status()`:三个消费者同时开页只打一枪。 */
let inflight: Promise<LicenseStatusView | undefined> | undefined
let timer: ReturnType<typeof setTimeout> | undefined

function clearTimer() {
  if (timer === undefined) return
  clearTimeout(timer)
  timer = undefined
}

/**
 * 到点(到期 / 生效)重新问一次。
 *
 * 期限跨过 `setTimeout` 上限时先睡到上限 —— 醒来照样重新问一次(多打一枪纯本地 RPC,
 * 比"醒来自己再算一次"少一个分支:那条分支在期限恰好等于上限时会算出负延迟、再也不排,
 * 症状是徽标永远停在旧答案上)。`applyLicenseStatus` 会接着排下一次。
 */
function rearm(status: LicenseStatusView | undefined) {
  clearTimer()
  const delay = nextLicenseCheckDelay(status, Date.now())
  if (delay === undefined) return
  timer = setTimeout(() => {
    timer = undefined
    void refreshLicenseStatus()
  }, delay)
}

/** 内核给了新状态(RPC 回来、导入成功、`license.updated` 事件)。 */
export function applyLicenseStatus(status: LicenseStatusView) {
  setState({ status, loaded: true, loading: false, error: undefined })
  rearm(status)
}

/** 重新问内核。并发调用共用同一次在飞请求。 */
export function refreshLicenseStatus(): Promise<LicenseStatusView | undefined> {
  if (inflight) return inflight
  setState("loading", true)
  inflight = kernel.license
    .status()
    .then((status) => {
      applyLicenseStatus(status)
      return status
    })
    .catch((error: unknown) => {
      setState({ loaded: true, loading: false, error: error instanceof Error ? error.message : String(error) })
      return undefined
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

/**
 * 消费者接线:订阅 `license.updated`,第一次挂载时问一次现状(事件不重放)。
 *
 * 订阅走 `serverSDK().event.listen` 这道已有的多路分发,不自己开第二条 transport
 * 订阅 —— 一批事件在一个 `batch()` 里分发完是流式渲染的性能地基。
 */
export function useLicenseStatus() {
  const serverSDK = useServerSDK()

  onMount(() => {
    const stop = serverSDK().event.listen((event) => {
      if (event.type === "license.updated") applyLicenseStatus(event.status)
    })
    onCleanup(stop)
    if (!state.loaded) void refreshLicenseStatus()
  })

  return {
    status: () => state.status,
    loading: () => state.loading,
    loaded: () => state.loaded,
    error: () => state.error,
    refresh: refreshLicenseStatus,
  }
}

