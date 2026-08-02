/**
 * 模型悬浮卡。
 *
 * 数据源换成内核的 `ModelInfo`:opencode 的 `capabilities` / `modalities` / `limit.context`
 * 都没有了,内核给的是 `contextWindow` 和 `thinkingLevels`。"能不能推理"直接由
 * `thinkingLevels` 是否非空回答,不再需要单独一个 reasoning 布尔。
 */

import type { ModelInfo } from "@yoma-desktop/kernel"
import { Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"

type TooltipModel = Pick<ModelInfo, "id" | "name" | "thinkingLevels" | "contextWindow"> & {
  provider: { name: string }
}

export const ModelTooltip: Component<{ model: TooltipModel }> = (props) => {
  const language = useLanguage()
  const sourceName = (model: TooltipModel) => {
    const value = `${model.id} ${model.name}`.toLowerCase()

    if (/claude|anthropic/.test(value)) return language.t("model.provider.anthropic")
    if (/gpt|o[1-4]|codex|openai/.test(value)) return language.t("model.provider.openai")
    if (/gemini|palm|bard|google/.test(value)) return language.t("model.provider.google")
    if (/grok|xai/.test(value)) return language.t("model.provider.xai")
    if (/llama|meta/.test(value)) return language.t("model.provider.meta")

    return model.provider.name
  }
  const title = () => `${sourceName(props.model)} ${props.model.name}`
  const reasoning = () =>
    props.model.thinkingLevels.length > 0
      ? language.t("model.tooltip.reasoning.allowed")
      : language.t("model.tooltip.reasoning.none")

  return (
    <div class="flex flex-col gap-1 py-1">
      <div class="text-13-medium">{title()}</div>
      <div class="text-12-regular text-text-invert-base">{reasoning()}</div>
      <Show when={props.model.contextWindow}>
        {(limit) => (
          <div class="text-12-regular text-text-invert-base">
            {language.t("model.tooltip.context", { limit: limit().toLocaleString() })}
          </div>
        )}
      </Show>
    </div>
  )
}
