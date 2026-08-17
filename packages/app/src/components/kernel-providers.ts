/**
 * 内核模型目录的读取入口。
 *
 * opencode 时代 provider 目录是后端 config 下发的,经 `serverSync().data.provider` +
 * `hooks/use-providers` 一层层规范化;yoma 没有 config 服务,目录就是
 * `kernel.model.list()` 返回的 `ProviderInfo[]`(带 `authenticated` 和每个模型的
 * `thinkingLevels`)。这里是 components/ 下唯一的读取点。
 *
 * 写入(auth.set / auth.remove)之后调用 `invalidateProviders()`,所有挂着的组件重新拉一次 ——
 * 内核没有 provider 变更事件,所以只能靠写入方主动通知。
 */

import type { ProviderInfo } from "@yoma-desktop/kernel"
import { createResource, onCleanup } from "solid-js"
import { kernel, kernelAvailable } from "@/utils/kernel"

const listeners = new Set<() => void>()

/** 写入凭据之后调用,让所有目录订阅者重新拉取。 */
export function invalidateProviders() {
  for (const listener of [...listeners]) listener()
}

async function load(): Promise<ProviderInfo[]> {
  // web host / 单测里没有内核通道,给空目录而不是让 resource 进 error 态。
  if (!kernelAvailable()) return []
  return kernel.model.list()
}

/** 返回一个始终有值(默认空数组)的 provider 目录访问器。 */
export function createProviderCatalog() {
  const [providers, { refetch }] = createResource(load, { initialValue: [] })
  const listener = () => void refetch()
  listeners.add(listener)
  onCleanup(() => listeners.delete(listener))
  return providers
}

/** 目录里所有模型,拍平成带 provider 的条目 —— 模型选择器按这个渲染。 */
export function flattenModels(providers: ProviderInfo[]) {
  return providers.flatMap((provider) => provider.models.map((model) => ({ ...model, provider })))
}

export type CatalogModel = ReturnType<typeof flattenModels>[number]
