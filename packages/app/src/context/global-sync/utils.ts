import type { ProviderInfo } from "@yoma-desktop/kernel"
import { NormalizedProviderListResponse } from "@yoma-desktop/session-ui/context"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * 把内核的 provider 目录摊成 UI 用的形状。
 *
 * 删掉的:normalizeAgentList(内核没有 Agent)、sanitizeProject(Project 上没有 icon)。
 * `default` 留空 —— opencode 是后端下发"每个 provider 的默认模型",内核没有这个概念,
 * 默认模型由会话自己的 Session.model 决定。
 */
export function normalizeProviderList(input: ProviderInfo[]): NormalizedProviderListResponse {
  return {
    all: new Map(input.map((provider) => [provider.id, provider] as const)),
    connected: input.filter((provider) => provider.authenticated).map((provider) => provider.id),
    default: {},
  }
}
