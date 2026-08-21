/**
 * la(逻辑分析仪)波形的 **DOM 侧工具箱** —— 卡片(本包 `la-tool.tsx`)与 dock 面板
 * (app 的 `pages/session/debug/la-waveform.tsx`)共用同一份画法、同一份取色。
 *
 * 线格式与格式化在内核的 `la-codec.ts`(那边没有 DOM lib,host 也要用),这里只加
 * 需要 DOM 的那一层:读主题 token、盯明暗切换、量 canvas、画泳道。**两半都从这里
 * 出去**(下面原样 re-export 内核那几个),于是消费方 import 一个模块就够了。
 *
 * 单独一个模块而不是塞进 `la-tool.tsx`,有两个理由:
 *  - 卡片要 import `Markdown`,而那条链上有 vite 的 `?worker&url` 说明符 —— `bun test`
 *    解不开它,于是任何 import 卡片的测试都只会得到一个模块加载错误。
 *  - 这里没有一个模块级可变状态(除了一张按对象身份索引的 WeakMap 缓存):画布是
 *    (数据, 尺寸, 颜色) → 像素的纯函数,虚拟列表随时卸载/重挂都能原样重画。
 */
import { decodeColumns, foldColumns, LA_COLUMN_EDGE, LA_COLUMN_HIGH, type LaToolDetails } from "@yoma-desktop/kernel"

export {
  decodeColumns,
  foldColumns,
  formatFreq,
  formatSamples,
  formatTime,
  LA_COLUMN_EDGE,
  LA_COLUMN_HIGH,
  LA_COLUMN_LOW,
} from "@yoma-desktop/kernel"

export type LaPreview = NonNullable<LaToolDetails["preview"]>
export type LaChannel = NonNullable<LaToolDetails["channels"]>[number]

/** 一个通道一条泳道的高度(CSS px),卡片的标签层按同一个数排版。 */
export const LA_LANE_HEIGHT = 16

/**
 * 主题色只能在**画的那一刻**读:canvas 里的像素不参与 CSS 级联,换主题不会自己变。
 * token 是自定义属性,会继承到画布上,所以对着画布(或它的容器)问就够了。
 *
 * 返回读取器而不是直接返回值:`getComputedStyle` 每调一次都可能强算一遍样式,而一次
 * 绘制要取七八个 token —— 面板那边曾经是一个 token 一次调用。
 */
export function cssTokenReader(element: Element | undefined | null): (name: string, fallback: string) => string {
  if (!element || typeof getComputedStyle !== "function") return (_name, fallback) => fallback
  const style = getComputedStyle(element)
  return (name, fallback) => style.getPropertyValue(name).trim() || fallback
}

/** 只取一个 token 时的写法;取多个请用 `cssTokenReader`,别在循环里调这个。 */
export function readCssToken(element: Element | undefined | null, name: string, fallback: string): string {
  return cssTokenReader(element)(name, fallback)
}

/**
 * 换明暗时 documentElement 上变的是 `data-color-scheme`,`data-theme` 是同一个 apply
 * 顺手写的(`packages/ui/src/theme/context.tsx`)—— 两个都盯,别的属性一律不管:
 * 盯 `class` 会被任何一次无关的类名切换拽着重画整张波形。
 */
export function observeColorScheme(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-color-scheme", "data-theme"],
  })
  return () => observer.disconnect()
}

export function pixelRatio(): number {
  if (typeof window === "undefined") return 1
  return window.devicePixelRatio || 1
}

/**
 * 按 dpr 量好 backing store 并把坐标系换成 CSS px,返回清好的上下文。
 * 尺寸没变时不碰 `canvas.width` —— 给它赋值(哪怕是同一个数)会清空整张图。
 */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr = pixelRatio(),
): CanvasRenderingContext2D | undefined {
  const w = Math.max(1, Math.round(width * dpr))
  const h = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  canvas.style.width = `${Math.max(1, width)}px`
  canvas.style.height = `${Math.max(1, height)}px`
  const ctx = canvas.getContext("2d")
  if (!ctx) return undefined
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, Math.max(1, width), Math.max(1, height))
  return ctx
}

export interface PaintLanesOptions {
  /** 泳道区左上角(CSS px);面板要给通道名让出 LABEL_W,卡片是 0。 */
  x: number
  y: number
  /** 泳道宽度,必须等于 rows 里每条的长度 */
  width: number
  laneHeight: number
  /** 泳道上下各留多少 —— 高电平线与低电平线之间就是 laneHeight - 2*pad */
  pad: number
  /** 波形线颜色 */
  trace: string
  lineWidth?: number
  /** 给了才画泳道之间的分隔线;**最后一条下面不画**,免得看起来像多了一个空通道 */
  separator?: string
}

/**
 * 唯一的泳道画法:高/低电平画横线,`LA_COLUMN_EDGE`(该像素里翻转过)画一根竖线把
 * 两条横线连上 —— 于是缩略图与面板是同一个方波,不是"卡片一串点、面板一条线"。
 *
 * rows 必须**已经折到像素**(`foldColumns`),一列就是一像素:预览是 1024 列而卡片只有
 * 几百像素宽,逐列画出来是一片灰雾,边沿全糊掉。半像素偏移是为了 1px 线不跨两行像素。
 */
export function paintLanes(
  ctx: CanvasRenderingContext2D,
  rows: readonly Uint8Array[],
  options: PaintLanesOptions,
): void {
  const { x, y, width, laneHeight, pad, trace } = options
  if (width <= 0 || rows.length === 0) return

  if (options.separator && rows.length > 1) {
    ctx.beginPath()
    ctx.strokeStyle = options.separator
    ctx.lineWidth = 1
    for (let lane = 1; lane < rows.length; lane += 1) {
      const yy = y + lane * laneHeight - 0.5
      ctx.moveTo(x, yy)
      ctx.lineTo(x + width, yy)
    }
    ctx.stroke()
  }

  ctx.beginPath()
  ctx.strokeStyle = trace
  ctx.lineWidth = options.lineWidth ?? 1
  for (let lane = 0; lane < rows.length; lane += 1) {
    const masks = rows[lane]!
    const laneTop = y + lane * laneHeight
    const high = laneTop + pad + 0.5
    const low = laneTop + laneHeight - pad - 0.5
    // 连续同电平的像素攒成一条线段再画:一像素一次 moveTo/lineTo 的路径能有上万段。
    let level: number | undefined
    let runStart = 0
    const flush = (end: number) => {
      if (level === undefined) return
      ctx.moveTo(x + runStart, level)
      ctx.lineTo(x + end, level)
      level = undefined
    }
    for (let px = 0; px < width; px += 1) {
      const mask = masks[px] ?? 0
      if (mask === LA_COLUMN_EDGE) {
        flush(px)
        ctx.moveTo(x + px + 0.5, high)
        ctx.lineTo(x + px + 0.5, low)
        continue
      }
      if (mask === 0) {
        // 没有样本(通道没这一行,或折叠后这一像素是空的):断开,别拿线连过去。
        flush(px)
        continue
      }
      const yy = mask === LA_COLUMN_HIGH ? high : low
      if (level === undefined) {
        level = yy
        runStart = px
        continue
      }
      if (level !== yy) {
        // 相邻两像素直接换了电平(翻转恰好落在像素边界上):补一根竖线,否则是断开的两截。
        flush(px)
        ctx.moveTo(x + px, high)
        ctx.lineTo(x + px, low)
        level = yy
        runStart = px
      }
    }
    flush(width)
  }
  ctx.stroke()
}

interface FoldedRows {
  width: number
  channels: readonly LaChannel[]
  rows: Uint8Array[]
}

/**
 * 缓存按 **preview 对象身份 + 宽度**:details 在会话里是同一个对象,而 transcript 的
 * 虚拟列表会把卡片反复卸载重挂,每次重解 1024 列 × N 通道纯属白烧。
 * WeakMap 于是不需要失效逻辑 —— details 走了,缓存跟着走。
 */
const foldCache = new WeakMap<LaPreview, FoldedRows>()

/** 预览 → 每通道一条已折到 width 像素的掩码行,喂给 `paintLanes`。 */
export function foldedPreviewRows(
  preview: LaPreview | undefined,
  channels: readonly LaChannel[],
  width: number,
): Uint8Array[] {
  if (!preview || width <= 0 || channels.length === 0) return []
  const hit = foldCache.get(preview)
  if (hit && hit.width === width && hit.channels === channels) return hit.rows
  const rows = channels.map((channel) =>
    foldColumns(decodeColumns(preview.rows[String(channel.index)] ?? "", preview.columns), width),
  )
  foldCache.set(preview, { width, channels, rows })
  return rows
}

/**
 * 画波形要的通道表。details 里 channels 与 preview.rows 未必同时齐全 ——
 * 只有 rows 时按 key 兜一份出来,否则重放旧采集会得到一张空画布。
 */
export function previewChannels(details: Partial<LaToolDetails>): readonly LaChannel[] {
  const declared = details.channels ?? []
  if (declared.length > 0) return declared
  const rows = details.preview?.rows
  if (!rows) return []
  return Object.keys(rows)
    .map((key) => Number(key))
    .filter((index) => Number.isFinite(index))
    .sort((a, b) => a - b)
    .map((index) => ({ index, name: `D${index}` }))
}
