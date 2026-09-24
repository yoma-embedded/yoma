import { createMemo, Index, untrack, type Accessor, type JSX } from "solid-js"
import type { ToolPart } from "@yoma-desktop/kernel"
import { ContextToolGroup, type PartRef } from "@yoma-desktop/session-ui/message-part"

/**
 * 时间线上「一串找东西的工具」那一行(`groupParts` 的 context 组)。展开状态都记在时间线的 `toolOpen` 里:
 * 每张卡片按 part id,组按组的 key。
 *
 * 要守住的一件事:**第二个工具到的那一下,用户正开着的卡片不许收起来。** 那一刻组的 key 还没人写过,
 * 照缺省(折叠)画的话,用户刚点开的文件内容当场消失。所以组成形的那一刻看一眼:里面有卡片开着,组就接着开着。
 * 只在成形时定一次(memo 记着上一次的值),之后卡片各自开合不再牵动组;用户自己收起 / 展开过组,以用户的为准。
 * 卡片列表由 `ContextToolGroup` 在同一个位置渲染,1 → 2 时实例不换(见它的注释)。
 */
export function ContextGroupRow(props: {
  groupKey: string
  refs: PartRef[]
  parts: ToolPart[]
  isOpen: (key: string) => boolean | undefined
  onOpenChange: (key: string, open: boolean) => void
  renderCard: (ref: Accessor<PartRef>) => JSX.Element
}) {
  const grouped = createMemo(() => props.refs.length > 1)
  const openWhenFormed = createMemo<boolean | undefined>((previous) => {
    if (previous !== undefined) return previous
    if (!grouped()) return undefined
    return untrack(() => props.refs.some((ref) => props.isOpen(ref.partID) === true))
  })

  return (
    <ContextToolGroup
      parts={props.parts}
      grouped={grouped()}
      open={props.isOpen(props.groupKey) ?? openWhenFormed() ?? false}
      onOpenChange={(open) => props.onOpenChange(props.groupKey, open)}
    >
      <Index each={props.refs}>{(ref) => props.renderCard(ref)}</Index>
    </ContextToolGroup>
  )
}
