// 手册库:官方数据手册(shared 层,索引常驻本地、产物按手册显式下载)+ 用户自己的
// 文档(overlay 层,本地 Docling 解析,不出本机)。Node 侧工作全部走 Electron 主进程
// (packages/desktop/src/main/manuals.ts),浏览器/web 平台下仅显示提示。
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { SelectV2 } from "@yoma-desktop/ui/v2/select-v2"
import { TextInputV2 } from "@yoma-desktop/ui/v2/text-input-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@yoma-desktop/ui/v2/dialog-v2"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import type { ManualItem, ManualsConfig, ManualsEvent } from "@/manuals/types"

type DownloadProgress = { done: number; total: number; bytes: number; error?: string }

const LABEL = "text-[12px] text-v2-text-text-muted [font-weight:500]"
const TH = "px-3 py-2 text-left text-[12px] text-v2-text-text-muted [font-weight:500] whitespace-nowrap"
const TD = "px-3 py-2 text-[13px] text-v2-text-text-base whitespace-nowrap"

// kind (标注,不参与检索):datasheet 不显示徽标;其余在文档名旁标一个小徽标。
const KIND_OPTIONS = ["datasheet", "schematic", "tutorial", "reference"] as const
const KIND_LABEL: Record<string, string> = {
  datasheet: "数据手册",
  schematic: "原理图",
  tutorial: "教程",
  reference: "参考资料",
}
const KIND_BADGE: Record<string, string> = {
  schematic: "原理图",
  tutorial: "教程",
  reference: "参考",
}
// tutorial/reference 属通用语料,scope 固定为 GENERAL(检索不指定 rev 时并入)。
const CHIP_LOCKED_KINDS = new Set(["tutorial", "reference"])

function fmtMB(bytes: number | null): string {
  return bytes == null ? "—" : `${(bytes / 1e6).toFixed(1)} MB`
}

// kind≠datasheet 时显示的小徽标(文本即可,风格跟随现有 v2 class)。
function KindBadge(props: { kind: string }) {
  const label = createMemo(() => (props.kind && props.kind !== "datasheet" ? KIND_BADGE[props.kind] : undefined))
  return (
    <Show when={label()}>
      <span class="ml-1.5 whitespace-nowrap rounded-[4px] border border-v2-border-border-base px-1 text-[11px] text-v2-text-text-muted [font-weight:500]">
        {label()}
      </span>
    </Show>
  )
}

export default function ManualsPage() {
  const platform = usePlatform()
  const manuals = platform.manuals

  const [config, setConfig] = createSignal<ManualsConfig | null>(null)
  const [items, setItems] = createSignal<ManualItem[]>([])
  const [progress, setProgress] = createStore<Record<string, DownloadProgress | undefined>>({})
  const [ingestLog, setIngestLog] = createSignal<string[]>([])
  const [ingestRunning, setIngestRunning] = createSignal(false)
  const [indexBusy, setIndexBusy] = createSignal(false)
  const [indexProgress, setIndexProgress] = createSignal<{ phase: string; bytes: number; total: number } | null>(null)
  const [indexMessage, setIndexMessage] = createSignal<{ text: string; error?: boolean } | null>(null)
  const dialog = useDialog()

  const shared = createMemo(() => items().filter((item) => item.tier === "shared"))
  const overlay = createMemo(() => items().filter((item) => item.tier === "overlay"))

  // 官方手册按虚拟目录(catalog folder)分组;组内按 chip/rev 排,命名文件夹在前、"未分类"(根)最后。
  const sharedGroups = createMemo(() => {
    const byFolder = new Map<string, ManualItem[]>()
    for (const item of shared()) {
      const list = byFolder.get(item.folder)
      if (list) list.push(item)
      else byFolder.set(item.folder, [item])
    }
    const groups = [...byFolder.entries()].map(([folder, list]) => ({
      folder,
      items: list.slice().sort((a, b) => a.chip.localeCompare(b.chip) || a.rev.localeCompare(b.rev)),
    }))
    groups.sort((a, b) => {
      if (!a.folder !== !b.folder) return a.folder ? -1 : 1
      return a.folder.localeCompare(b.folder)
    })
    return groups
  })

  async function refresh() {
    if (!manuals) return
    setItems(await manuals.list())
  }

  onMount(() => {
    if (!manuals) return
    void manuals.config().then(setConfig)
    void refresh()
    const off = manuals.subscribe((event: ManualsEvent) => {
      if (event.type === "download-progress") {
        setProgress(`${event.chip}/${event.rev}`, {
          done: event.done,
          total: event.total,
          bytes: event.bytes,
        })
      } else if (event.type === "download-end") {
        setProgress(`${event.chip}/${event.rev}`, event.ok ? undefined : { done: 0, total: 0, bytes: 0, error: event.error })
      } else if (event.type === "index-update-progress") {
        setIndexProgress({ phase: event.phase, bytes: event.bytes, total: event.total })
      } else if (event.type === "ingest-log") {
        setIngestLog((lines) => [...lines.slice(-400), event.line])
      } else if (event.type === "ingest-end") {
        setIngestRunning(false)
      } else if (event.type === "changed") {
        void refresh()
      }
    })
    onCleanup(off)
  })

  async function download(item: ManualItem) {
    if (!manuals) return
    setProgress(`${item.chip}/${item.rev}`, { done: 0, total: item.fileCount ?? 0, bytes: 0 })
    await manuals.download(item.chip, item.rev)
  }

  async function updateIndex() {
    if (!manuals || indexBusy()) return
    setIndexBusy(true)
    setIndexMessage(null)
    setIndexProgress(null)
    const result = await manuals.updateIndex()
    setIndexBusy(false)
    setIndexProgress(null)
    if (result.ok) {
      setIndexMessage({
        text: result.upToDate
          ? `索引已是最新(v${result.version})`
          : `索引已更新到 v${result.version}(${result.numManuals ?? "?"} 本手册)`,
      })
      void manuals.config().then(setConfig)
      void refresh()
    } else {
      setIndexMessage({ text: `索引更新失败:${result.error ?? "未知错误"}`, error: true })
    }
  }

  const indexButtonLabel = createMemo(() => {
    if (!indexBusy()) return "更新索引"
    const p = indexProgress()
    if (p?.phase === "download" && p.total > 0)
      return `下载快照 ${(p.bytes / 1e6).toFixed(1)}/${(p.total / 1e6).toFixed(1)} MB`
    if (p?.phase === "install") return "安装中…"
    return "检查中…"
  })

  function openUpload() {
    dialog.show(() => (
      <UploadDialog
        onStart={() => {
          setIngestLog([])
          setIngestRunning(true)
        }}
      />
    ))
  }

  return (
    <div class="mx-auto flex h-full w-full max-w-[880px] flex-col gap-6 overflow-y-auto px-6 py-6">
      <Show
        when={manuals}
        fallback={<div class="text-[13px] text-v2-text-text-muted">手册库仅在桌面端可用。</div>}
      >
        <header class="flex items-center gap-3">
          <h1 class="text-[16px] text-v2-text-text-base [font-weight:600]">手册库</h1>
          <span class="flex-1" />
          <ButtonV2 variant="neutral" onClick={() => void updateIndex()} disabled={indexBusy()}>
            {indexButtonLabel()}
          </ButtonV2>
          <ButtonV2 variant="contrast" onClick={openUpload} disabled={ingestRunning()}>
            {ingestRunning() ? "解析中…" : "上传我的文档"}
          </ButtonV2>
        </header>
        <Show when={indexMessage()}>
          <div
            class={`text-[12px] ${indexMessage()!.error ? "text-v2-state-fg-danger" : "text-v2-text-text-muted"}`}
          >
            {indexMessage()!.text}
          </div>
        </Show>
        <Show when={config() && !config()!.serverUrl}>
          <div class="rounded-[8px] border border-v2-border-border-base px-3 py-2 text-[12px] text-v2-text-text-muted">
            未配置文件服务器:在 ~/.my-pi/.env 中加一行 YOMA_DATASHEET_SERVER=http://服务器:端口,
            「更新索引」与官方手册下载才能工作。检索(datasheet_search)不受影响。
          </div>
        </Show>

        <section class="flex flex-col gap-2">
          <h2 class={LABEL}>
            官方手册(索引{config()?.indexVersion != null ? `快照 v${config()!.indexVersion}` : "版本未记录"}
            ,产物按需下载)
          </h2>
          <div class="overflow-x-auto rounded-[8px] border border-v2-border-border-base">
            <table class="w-full border-collapse">
              <thead>
                <tr class="border-b border-v2-border-border-base">
                  <th class={TH}>芯片</th>
                  <th class={TH}>手册</th>
                  <th class={TH}>chunks</th>
                  <th class={TH}>产物大小</th>
                  <th class={TH}>状态</th>
                  <th class={TH}></th>
                </tr>
              </thead>
              <tbody>
                <Show
                  when={sharedGroups().length > 0}
                  fallback={
                    <tr>
                      <td class={`${TD} text-v2-text-text-muted`} colSpan={6}>
                        索引里还没有官方手册。
                      </td>
                    </tr>
                  }
                >
                  <For each={sharedGroups()}>
                    {(group) => (
                      <>
                        <tr class="border-b border-v2-border-border-base bg-v2-background-bg-deep">
                          <td class={`${TD} text-v2-text-text-muted [font-weight:600]`} colSpan={6}>
                            {group.folder || "未分类"}
                          </td>
                        </tr>
                        <For each={group.items}>
                          {(item) => (
                            <SharedRow
                              item={item}
                              progress={progress[`${item.chip}/${item.rev}`]}
                              locked={indexBusy()}
                              onDownload={() => void download(item)}
                            />
                          )}
                        </For>
                      </>
                    )}
                  </For>
                </Show>
              </tbody>
            </table>
          </div>
        </section>

        <section class="flex flex-col gap-2">
          <h2 class={LABEL}>我的文档(本机解析,仅存本地 overlay 层)</h2>
          <div class="overflow-x-auto rounded-[8px] border border-v2-border-border-base">
            <table class="w-full border-collapse">
              <thead>
                <tr class="border-b border-v2-border-border-base">
                  <th class={TH}>芯片</th>
                  <th class={TH}>文档</th>
                  <th class={TH}>chunks</th>
                  <th class={TH}>解析时间</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={overlay()}
                  fallback={
                    <tr>
                      <td class={`${TD} text-v2-text-text-muted`} colSpan={4}>
                        还没有上传过文档。点右上角「上传我的文档」,选择 PDF 并填写芯片家族即可本地解析入库。
                      </td>
                    </tr>
                  }
                >
                  {(item) => (
                    <tr class="border-b border-v2-border-border-base last:border-b-0">
                      <td class={TD}>{item.chip}</td>
                      <td class={TD}>
                        {item.manualName}
                        <KindBadge kind={item.kind} />
                      </td>
                      <td class={TD}>{item.numChunks ?? "—"}</td>
                      <td class={TD}>{item.builtAt?.replace("T", " ").replace(/\.\d+Z$/, "") ?? "—"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </section>

        <Show when={ingestRunning() || ingestLog().length > 0}>
          <section class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <h2 class={LABEL}>{ingestRunning() ? "解析进行中…(大文档需要数分钟)" : "解析日志"}</h2>
              <span class="flex-1" />
              <Show when={ingestRunning()}>
                <ButtonV2 size="small" variant="neutral" onClick={() => void manuals?.cancelIngest()}>
                  取消
                </ButtonV2>
              </Show>
            </div>
            <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-v2-border-border-base px-3 py-2 text-[12px] text-v2-text-text-muted">
              {ingestLog().join("\n")}
            </pre>
          </section>
        </Show>
      </Show>
    </div>
  )
}

function SharedRow(props: {
  item: ManualItem
  progress?: DownloadProgress
  /** true while the index snapshot is being replaced — downloads are held off */
  locked?: boolean
  onDownload: () => void
}) {
  const busy = createMemo(() => Boolean(props.progress && !props.progress.error))
  const status = createMemo(() => {
    if (props.progress?.error) return { text: "下载失败", cls: "text-v2-state-fg-danger" }
    if (busy()) {
      const { done, total } = props.progress!
      return { text: total ? `下载中 ${done}/${total}` : "下载中…", cls: "text-v2-text-text-base" }
    }
    switch (props.item.downloaded) {
      case "complete":
        return { text: "已下载", cls: "text-v2-text-text-muted" }
      case "partial":
        return { text: "不完整", cls: "text-v2-state-fg-danger" }
      case "none":
        return { text: "未下载", cls: "text-v2-text-text-muted" }
      default:
        return { text: "未知", cls: "text-v2-text-text-muted" }
    }
  })
  return (
    <tr class="border-b border-v2-border-border-base last:border-b-0">
      <td class={TD}>{props.item.chip}</td>
      <td class={TD} title={props.item.rev}>
        {props.item.manualName}
        <KindBadge kind={props.item.kind} />
      </td>
      <td class={TD}>{props.item.numChunks ?? "—"}</td>
      <td class={TD}>{fmtMB(props.item.totalBytes)}</td>
      <td class={TD}>
        <span class={status().cls} title={props.progress?.error}>
          {status().text}
        </span>
      </td>
      <td class={`${TD} text-right`}>
        <ButtonV2
          size="small"
          variant={props.item.downloaded === "complete" ? "neutral" : "contrast"}
          disabled={busy() || props.locked}
          onClick={props.onDownload}
        >
          {props.item.downloaded === "complete" ? "校验/更新" : "下载"}
        </ButtonV2>
      </td>
    </tr>
  )
}

function UploadDialog(props: { onStart: () => void }) {
  const platform = usePlatform()
  const dialog = useDialog()
  const [pdfPath, setPdfPath] = createSignal("")
  const [chip, setChip] = createSignal("")
  const [rev, setRev] = createSignal("")
  const [kind, setKind] = createSignal("datasheet")
  const [figures, setFigures] = createSignal(true)
  const [error, setError] = createSignal("")

  // tutorial/reference = 通用语料,scope 锁定为 GENERAL(chip 输入禁用)。
  const chipLocked = createMemo(() => CHIP_LOCKED_KINDS.has(kind()))
  createEffect(() => {
    if (chipLocked()) setChip("GENERAL")
  })

  const canStart = createMemo(() => Boolean(pdfPath()) && Boolean(chip().trim()) && Boolean(rev().trim()))

  function pickPdf() {
    void platform.openAttachmentPickerDialog?.({ title: "选择要解析的 PDF", multiple: false, extensions: ["pdf"] }, async (file) => {
      const nativePath = platform.getPathForFile?.(file)
      if (!nativePath) {
        setError("无法获取所选文件的本地路径")
        return
      }
      setPdfPath(nativePath)
      if (!rev()) setRev(file.name.replace(/\.pdf$/i, ""))
    })
  }

  async function start() {
    if (!canStart() || !platform.manuals) return
    setError("")
    const request = { pdfPath: pdfPath(), chip: chip().trim(), rev: rev().trim(), kind: kind(), figures: figures() }
    props.onStart()
    dialog.close()
    const result = await platform.manuals.ingest(request)
    if (!result.ok && result.error) {
      // 结果同时会以 ingest-end 事件到达页面;这里不再弹窗,日志区已可见错误
      console.warn("manual ingest failed:", result.error)
    }
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title="上传我的文档"
          description="在本机用 Docling 解析,索引与产物只写入本地 overlay 层,不会上传到任何服务器。"
        />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-4 px-4 pb-4">
        <div class="flex flex-col gap-1.5">
          <span class={LABEL}>PDF 文件</span>
          <div class="flex h-8 items-center gap-2 rounded-[8px] border border-v2-border-border-base pl-2.5 pr-1">
            <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-base" title={pdfPath()}>
              {pdfPath() || "未选择"}
            </span>
            <ButtonV2 size="small" variant="ghost" onClick={pickPdf}>
              浏览…
            </ButtonV2>
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <span class={LABEL}>文档类型</span>
          <SelectV2
            appearance="large"
            class="!w-full"
            options={[...KIND_OPTIONS]}
            current={kind()}
            value={(k) => k}
            label={(k) => KIND_LABEL[k] ?? k}
            onSelect={(k) => k && setKind(k)}
          />
        </div>
        <label class="flex flex-col gap-1.5">
          <span class={LABEL}>
            {chipLocked() ? "芯片家族(教程/参考归入通用语料,已固定为 GENERAL)" : "芯片家族(检索按它过滤,必填,如 STM32F1)"}
          </span>
          <TextInputV2
            value={chip()}
            appearance="large"
            class="!w-full"
            placeholder="STM32F1"
            spellcheck={false}
            autocomplete="off"
            disabled={chipLocked()}
            onInput={(event) => setChip(event.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class={LABEL}>文档标识(默认取文件名)</span>
          <TextInputV2
            value={rev()}
            appearance="large"
            class="!w-full"
            placeholder="MYBOARD-V2"
            spellcheck={false}
            autocomplete="off"
            onInput={(event) => setRev(event.currentTarget.value)}
          />
        </label>
        <label class="flex items-center gap-2 text-[13px] text-v2-text-text-base">
          <input type="checkbox" checked={figures()} onChange={(event) => setFigures(event.currentTarget.checked)} />
          提取图表(可被检索并支持看图,稍慢)
        </label>
        <Show when={error()}>
          <span class="text-[12px] text-v2-state-fg-danger">{error()}</span>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          取消
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!canStart()} onClick={() => void start()}>
          开始解析
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
