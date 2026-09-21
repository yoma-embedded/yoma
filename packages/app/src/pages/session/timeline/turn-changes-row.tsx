import { createMemo, For, Index, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import type { Part } from "@yoma-desktop/kernel"
import { fileChangeView, turnFileChanges, type FileChange } from "@yoma-desktop/session-ui/turn-changes"
import { Accordion } from "@yoma-desktop/ui/accordion"
import { useFileComponent } from "@yoma-desktop/ui/context/file"
import { DiffChanges } from "@yoma-desktop/ui/diff-changes"
import { Icon } from "@yoma-desktop/ui/icon"
import { StickyAccordionHeader } from "@yoma-desktop/ui/sticky-accordion-header"
import { getDirectory, getFilename } from "@yoma-desktop/util/path"
import { useLanguage } from "@/context/language"

const MAX_FILES = 10

/**
 * 「本轮改动」:这一轮里 edit / write 改过的文件,一行一个,点开是 diff。
 *
 * 外壳(data-slot / Accordion / 最多先列 10 个)是 opencode 那一行原样留下来的,CSS 还在 session-turn.css;
 * 数据换成了 turn-changes.ts 从工具结果合成的那一份。展开状态记在时间线的 toolOpen 里而不是组件自己身上:
 * 时间线是虚拟列表,这一行滚出去就卸载了,记在自己身上的话滚回来全收起了。
 */
export function TurnChangesRow(props: {
  rowKey: string
  parts: Part[]
  directory: string
  isOpen: (key: string) => boolean | undefined
  onOpenChange: (key: string, open: boolean) => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ showAll: false })
  const changes = createMemo(() => turnFileChanges(props.parts, props.directory))
  const views = createMemo(() => new Map(changes().map((change) => [change.file, fileChangeView(change)] as const)))
  const totals = createMemo(() => Array.from(views().values()))
  const overflow = createMemo(() => Math.max(0, changes().length - MAX_FILES))
  const visible = createMemo(() => (state.showAll ? changes() : changes().slice(0, MAX_FILES)))
  const openKey = (file: string) => `${props.rowKey}:${file}`
  const expanded = createMemo(() =>
    changes()
      .filter((change) => props.isOpen(openKey(change.file)))
      .map((change) => change.file),
  )

  const onChange = (next: string[]) => {
    const open = new Set(next)
    for (const change of changes()) {
      const key = openKey(change.file)
      if (!!props.isOpen(key) !== open.has(change.file)) props.onOpenChange(key, open.has(change.file))
    }
  }

  return (
    <div
      data-slot="session-turn-diffs"
      data-component="session-turn-diffs-group"
      data-show-all={state.showAll || undefined}
    >
      <div data-slot="session-turn-diffs-header">
        <span data-slot="session-turn-diffs-label">
          {language.t(changes().length === 1 ? "session.turnChanges.title.one" : "session.turnChanges.title.other", {
            count: changes().length,
          })}
        </span>
        <DiffChanges changes={totals()} />
        <Show when={overflow() > 0}>
          <span data-slot="session-turn-diffs-toggle" onClick={() => setState("showAll", !state.showAll)}>
            {language.t(state.showAll ? "session.turnChanges.showLess" : "session.turnChanges.showAll")}
          </span>
        </Show>
      </div>
      <div data-component="session-turn-diffs-content">
        <Accordion
          multiple
          style={{ "--sticky-accordion-offset": "44px" }}
          value={expanded()}
          onChange={(value) => onChange(Array.isArray(value) ? value : value ? [value] : [])}
        >
          <For each={visible()}>
            {(change) => (
              <TurnChangeItem
                change={change}
                view={views().get(change.file)!}
                open={expanded().includes(change.file)}
              />
            )}
          </For>
        </Accordion>
        <Show when={!state.showAll && overflow() > 0}>
          <div data-slot="session-turn-diffs-more" onClick={() => setState("showAll", true)}>
            {language.t("session.turnChanges.more", { count: overflow() })}
          </div>
        </Show>
      </div>
    </div>
  )
}

function TurnChangeItem(props: { change: FileChange; view: ReturnType<typeof fileChangeView>; open: boolean }) {
  const language = useLanguage()
  const fileComponent = useFileComponent()
  // 一次改动的内容都没记下(旧会话里的 write、被覆盖的文件过大):列出来,但没有东西可展开。
  const opaque = () => props.view.diffs.length === 0

  return (
    <Accordion.Item value={props.change.file} disabled={opaque()} data-file={props.change.display}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div data-slot="session-turn-diff-trigger">
            <span data-slot="session-turn-diff-path">
              <Show when={/[\\/]/.test(props.change.display)}>
                <span data-slot="session-turn-diff-directory">{`‪${getDirectory(props.change.display)}‬`}</span>
              </Show>
              <span data-slot="session-turn-diff-filename">{getFilename(props.change.display)}</span>
            </span>
            <div data-slot="session-turn-diff-meta">
              <Show when={props.change.created}>
                <span data-slot="session-turn-diff-note">{language.t("session.turnChanges.created")}</span>
              </Show>
              <Show
                when={!opaque()}
                fallback={<span data-slot="session-turn-diff-note">{language.t("session.turnChanges.opaque")}</span>}
              >
                <span data-slot="session-turn-diff-changes">
                  <DiffChanges changes={props.view} />
                </span>
                <span data-slot="session-turn-diff-chevron">
                  <Icon name="chevron-down" size="small" />
                </span>
              </Show>
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content>
        <Show when={props.open}>
          <Index each={props.view.diffs}>
            {(diff, index) => (
              <>
                <Show when={props.view.diffs.length > 1}>
                  <div data-slot="session-turn-diff-step">
                    {language.t("session.turnChanges.step", { index: index + 1, total: props.view.diffs.length })}
                  </div>
                </Show>
                <div data-slot="session-turn-diff-view" data-scrollable>
                  <Dynamic component={fileComponent} mode="diff" virtualize={false} fileDiff={diff()} />
                </div>
              </>
            )}
          </Index>
        </Show>
      </Accordion.Content>
    </Accordion.Item>
  )
}
