/**
 * la.view / la.captures:波形面板的数据通路。
 *
 * 面板要的是"这 N 个像素列上每根线什么样 + 窗口里有哪些注解",不是原始样本。这里按视口做列聚合
 * (每列 2bit,复杂度 O(列数 + 边沿数)),注解按窗口二分取、按行分泳道、每条泳道封顶;跨进程一次
 * 几十 KB。缓存与布局都在 coding-agent 的 la.captureStore —— 与 `la` 工具同一份。
 */
import { la } from "@yoma/coding-agent"
import type { LaCaptureInfo, LaViewLaneItem, LaViewParams, LaViewResult } from "../types.ts"

const MAX_COLUMNS = 4096
const MAX_LANE_ITEMS = 2000

export function laCaptures(directory: string): Promise<LaCaptureInfo[]> {
  return la.captureStore.list(directory)
}

export async function laView(params: LaViewParams): Promise<LaViewResult> {
  const cap = await la.captureStore.open(params.dir)
  const h = cap.dsl.header
  const columns = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(params.columns)))
  const from = Math.max(0, Math.floor(params.from ?? 0))
  const to = Math.min(h.totalSamples, Math.ceil(params.to ?? h.totalSamples))
  if (to <= from) throw new Error(`la.view: empty window ${from}..${to} (capture has ${h.totalSamples} samples)`)

  const channels = h.channels.map((ch) => {
    const e = cap.edges(ch.index)
    return { index: ch.index, name: ch.name, edges: e.edges.length, bits: Buffer.from(la.columnBits(e, from, to, columns)).toString("base64") }
  })

  const lanes: LaViewResult["lanes"] = []
  const set = await cap.annotations()
  if (set) {
    for (const dec of set.meta.decoders) {
      const anns = set.byKey.get(dec.key) ?? []
      // 列表按 s 升序,e 不单调:从 s >= from - 最长注解 处二分起步,再按 e 过滤,既不漏跨窗口的长注解也不全扫
      const floor = from - (set.spanMax.get(dec.key) ?? 0)
      let lo = 0
      let hi = anns.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (anns[mid]!.s < floor) lo = mid + 1
        else hi = mid
      }
      const byRow = new Map<string, LaViewLaneItem[]>()
      const totals = new Map<string, number>()
      for (let i = lo; i < anns.length; i++) {
        const a = anns[i]!
        if (a.s >= to) break
        if (a.e < from || la.BIT_ROWS.has(a.r)) continue
        totals.set(a.r, (totals.get(a.r) ?? 0) + 1)
        let items = byRow.get(a.r)
        if (!items) {
          items = []
          byRow.set(a.r, items)
        }
        if (items.length < MAX_LANE_ITEMS) items.push({ s: a.s, e: a.e, cls: a.cls, text: la.annText(a), short: la.annShort(a) })
      }
      for (const [row, items] of byRow) {
        const total = totals.get(row) ?? items.length
        lanes.push({ key: dec.key, decoderId: dec.id, row, items, total, truncated: total > items.length })
      }
    }
  }

  return { samplerate: h.samplerate, totalSamples: h.totalSamples, triggerPos: h.triggerPos, from, to, columns, channels, lanes }
}
