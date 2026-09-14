/**
 * 图片进模型之前的那一道:格式归一 + 压到限额以内 + 给模型留一句尺寸说明。
 *
 * 两个入口都走这里:`read` 工具读到一张图(发动机的 imageProcessor 钩子),以及输入框里贴进来的
 * 附件(session-manager 的 prompt)。
 *
 * 【为什么非做不可】供应商对单条请求里的内嵌图片有硬上限(5 MB base64),而超限不是"这张图没了",
 * 是**整段对话被拒**。手机拍的板子照片、示波器截图动辄十几 MB —— 不压就等于这一轮直接失败,
 * 而报错里只字不提图片。
 *
 * 【尺寸而不是字节】供应商按像素尺寸计 token,所以候选里 PNG 排在 JPEG 前面(见 render.ts):
 * 无损不多花一个 token,波形和小字不会被糊掉。
 */

import { readExifOrientation } from "./exif.ts"
import { runRender } from "./render.ts"

/** 与 pi 同一组缺省:4.5 MB 的 base64 给 5 MB 的上限留出余量。 */
export const DEFAULT_MAX_WIDTH = 2000
export const DEFAULT_MAX_HEIGHT = 2000
export const DEFAULT_MAX_BASE64_BYTES = 4.5 * 1024 * 1024
export const DEFAULT_JPEG_QUALITY = 80

/** 模型能直接收的内嵌图片格式。别的(BMP、TIFF…)要先转成 PNG。 */
const INLINE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export interface ImageResizeOptions {
  maxWidth?: number
  maxHeight?: number
  /** base64 之后的字节上限。 */
  maxBytes?: number
  jpegQuality?: number
}

export interface ResizedImage {
  /** base64,不带 data: 前缀。 */
  data: string
  mimeType: string
  originalWidth: number
  originalHeight: number
  width: number
  height: number
  wasResized: boolean
}

export type ResizeOutcome =
  | { ok: true; image: ResizedImage }
  /**
   * unavailable = 这台机器没有图像后端;failed = 有后端但这次没弄成(超时/渲染抛了);
   * too-big = 缩到 1×1 也塞不进;undecodable = 认不出这份字节。
   */
  | { ok: false; reason: "unavailable" | "failed" | "too-big" | "undecodable" }

export type ProcessImageResult =
  | { ok: true; data: string; mimeType: string; hints: string[] }
  | { ok: false; message: string }

export interface ProcessImageOptions {
  /** 缺省 true。false 只做必要的格式转换,不缩放。 */
  autoResizeImages?: boolean
  resizeOptions?: ImageResizeOptions
}

/** `image/png; charset=x` → `image/png`;顺便把 image/jpg 归一成 image/jpeg。 */
export function baseMimeType(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase()
  return base === "image/jpg" ? "image/jpeg" : base
}

export function isInlineMimeType(mimeType: string): boolean {
  return INLINE_MIME_TYPES.has(baseMimeType(mimeType))
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

function base64Size(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

/**
 * 压到 maxWidth/maxHeight 与 maxBytes 以内。源格式模型收不了(BMP 之类)时**一定**重新编码,
 * 所以返回的 mimeType 永远是能直接内嵌的那几种。
 */
export async function resizeImage(
  bytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizeOutcome> {
  const base = baseMimeType(mimeType)
  const quality = options?.jpegQuality ?? DEFAULT_JPEG_QUALITY
  const result = await runRender({
    bytes,
    orientation: readExifOrientation(bytes),
    maxWidth: options?.maxWidth ?? DEFAULT_MAX_WIDTH,
    maxHeight: options?.maxHeight ?? DEFAULT_MAX_HEIGHT,
    maxBase64Bytes: options?.maxBytes ?? DEFAULT_MAX_BASE64_BYTES,
    // 质量从高到低试,去重后顺序不变。
    jpegQualities: [...new Set([quality, 85, 70, 55, 40])],
    forceEncode: !isInlineMimeType(base),
  })
  if (!result) return { ok: false, reason: "unavailable" }
  switch (result.kind) {
    case "failed":
      return { ok: false, reason: "failed" }
    case "undecodable":
      return { ok: false, reason: "undecodable" }
    case "too-big":
      return { ok: false, reason: "too-big" }
    case "unchanged":
      return {
        ok: true,
        image: {
          data: toBase64(bytes),
          mimeType: base,
          originalWidth: result.originalWidth,
          originalHeight: result.originalHeight,
          width: result.originalWidth,
          height: result.originalHeight,
          wasResized: false,
        },
      }
    case "encoded":
      return {
        ok: true,
        image: {
          data: toBase64(result.bytes),
          mimeType: result.mimeType,
          originalWidth: result.originalWidth,
          originalHeight: result.originalHeight,
          width: result.width,
          height: result.height,
          wasResized: result.width !== result.originalWidth || result.height !== result.originalHeight,
        },
      }
  }
}

/**
 * 缩过的图要告诉模型缩放比例:它看到的坐标不是原图坐标。
 * 没缩就不说 —— 每一句都要花 token。
 */
export function formatDimensionNote(image: ResizedImage): string | undefined {
  if (!image.wasResized) return undefined
  const scale = image.originalWidth / image.width
  return `[Image: original ${image.originalWidth}x${image.originalHeight}, displayed at ${image.width}x${image.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`
}

function conversionHint(from: string, to: string): string | undefined {
  return from === to ? undefined : `[Image converted from ${from} to ${to}.]`
}

/**
 * 一张图从字节到"能交给模型的 base64 + 几句说明"。
 *
 * 没有图像后端时**不是直接丢掉**:本来就能内嵌、又没超限的图原样放过去(与装 photon 之前的行为一致),
 * 只有真的需要转换或压缩时才说明为什么没送。
 */
export async function processImage(
  bytes: Uint8Array,
  mimeType: string,
  options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
  const base = baseMimeType(mimeType)
  const autoResize = options?.autoResizeImages ?? true
  const limits: ImageResizeOptions = autoResize
    ? (options?.resizeOptions ?? {})
    : {
        maxWidth: Number.POSITIVE_INFINITY,
        maxHeight: Number.POSITIVE_INFINITY,
        maxBytes: Number.POSITIVE_INFINITY,
        ...options?.resizeOptions,
      }

  const outcome = await resizeImage(bytes, base, limits)
  if (outcome.ok) {
    const hints: string[] = []
    const converted = conversionHint(base, outcome.image.mimeType)
    if (converted) hints.push(converted)
    const note = formatDimensionNote(outcome.image)
    if (note) hints.push(note)
    return { ok: true, data: outcome.image.data, mimeType: outcome.image.mimeType, hints }
  }

  if (outcome.reason === "undecodable") {
    return { ok: false, message: `[Image omitted: ${base} could not be decoded as an image.]` }
  }
  if (outcome.reason === "failed") {
    // 别说成"这个版本没装图像功能":后端在,是这一张没弄成,重试或换张图是合理的下一步。
    return { ok: false, message: "[Image omitted: processing it failed this time; the image backend is present.]" }
  }
  if (outcome.reason === "too-big") {
    return { ok: false, message: "[Image omitted: could not be resized below the inline image size limit.]" }
  }
  // unavailable:能内嵌又没超限的就原样过去,别为了"没装缩放器"把一张本来好好的图扣下。
  const withinLimit = base64Size(bytes.byteLength) < (limits.maxBytes ?? DEFAULT_MAX_BASE64_BYTES)
  if (isInlineMimeType(base) && withinLimit) {
    return { ok: true, data: toBase64(bytes), mimeType: base, hints: [] }
  }
  return {
    ok: false,
    message: isInlineMimeType(base)
      ? "[Image omitted: it is over the inline size limit and no image backend is available to resize it.]"
      : `[Image omitted: ${base} needs converting and no image backend is available in this build.]`,
  }
}
