/**
 * 真正动像素的那一段:解码 → 按 EXIF 转正 → 缩放 → 编码,一次调用把"压到限额以内"这件事做完。
 *
 * 【为什么在 worker 线程里跑】实测(本机,4000×3000 的 PNG):解码 29 ms + Lanczos3 缩放 360 ms +
 * PNG 编码 63 ms + JPEG 编码 60 ms,一轮约 0.5 秒,压不下去还要再来几轮。内核是 **utilityProcess,
 * 一个进程伺候所有会话和界面的 RPC** —— 在它的事件循环上同步跑半秒,表现就是整个 app 卡一下。
 * worker 一趟的开销实测 19 ms(含起线程与 wasm 编译),换掉这半秒很划算。
 *
 * 【为什么 worker 的源码是 `toString()` 出来的,不是一个文件】worker 入口若是磁盘上的文件,就要在
 * 四种运行环境(tsx、vitest、electron-vite 的 out/main、esbuild 的 .mjs、打包后的 asar)里各自找得到
 * 它 —— 而这正是 photon.ts 头注释里那套麻烦。`new Worker(源码字符串, { eval: true })` 把文件这一环
 * 整个去掉:打包器看不见任何路径,产物里也不需要多一个文件。
 *
 * 【因此 renderImage 必须自包含】它的源码会被原样塞进 worker,引用任何模块作用域的东西在那边都是
 * ReferenceError。所以类型之外的一切(旋转、编码、收缩循环)都嵌在函数体里。两条路的输出由
 * test/image-render.test.ts 逐字节比对钉着 —— 谁不小心从外面引了一个符号,那条用例立刻红。
 */

import { Worker } from "node:worker_threads"

import type { PhotonImage } from "@silvia-odwyer/photon-node"

import { loadPhoton, type Photon, resolvePhotonEntry } from "./photon.ts"

export interface RenderRequest {
  bytes: Uint8Array
  /** EXIF 方向 1..8(解析在父侧,见 exif.ts);1 = 不用转。 */
  orientation: number
  maxWidth: number
  maxHeight: number
  /** base64 之后的字节上限;`Number.POSITIVE_INFINITY` = 不限。 */
  maxBase64Bytes: number
  /** 依次尝试的 JPEG 质量;空数组 = 只出 PNG。 */
  jpegQualities: number[]
  /** 即使没超限也必须重新编码(源格式模型收不了,比如 BMP)。 */
  forceEncode: boolean
}

export type RenderResult =
  /** 原图就在限额内,方向也不用转:调用方**原样用源字节**,连重编码都不要。 */
  | { kind: "unchanged"; originalWidth: number; originalHeight: number }
  | {
      kind: "encoded"
      bytes: Uint8Array
      mimeType: string
      originalWidth: number
      originalHeight: number
      width: number
      height: number
    }
  /** 一路缩到 1×1 都压不进 maxBase64Bytes。 */
  | { kind: "too-big"; originalWidth: number; originalHeight: number }
  /** photon 认不出这份字节(损坏、或它这一版没编进这个解码器)。 */
  | { kind: "undecodable" }
  /** 有图像后端,但这一次渲染没成(worker 超时、或渲染本身抛了)。**不是**"这个版本没装图像功能"。 */
  | { kind: "failed" }

/**
 * 解码 → 转正 → 缩放 → 编码。**自包含**(见文件头):只许碰两个参数与全局。
 *
 * 候选顺序是 PNG 在前、JPEG 质量在后,取第一个塞得进限额的 —— 与 pi 一致,而且对 yoma 是对的:
 * 供应商按**像素尺寸**计费而不是按字节,所以留着无损的 PNG 不多花一个 token,波形图、示波器截图、
 * 数据手册那一页上的小字也不会被 JPEG 糊掉。字节限额只是防止把请求撑爆。
 */
export function renderImage(photon: Photon, request: RenderRequest): RenderResult {
  const base64Size = (byteLength: number): number => Math.ceil(byteLength / 3) * 4

  const rotate90 = (
    source: PhotonImage,
    dstIndex: (x: number, y: number, w: number, h: number) => number,
  ): PhotonImage => {
    const w = source.get_width()
    const h = source.get_height()
    const src = source.get_raw_pixels()
    const dst = new Uint8Array(src.length)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const from = (y * w + x) * 4
        const to = dstIndex(x, y, w, h) * 4
        dst[to] = src[from]
        dst[to + 1] = src[from + 1]
        dst[to + 2] = src[from + 2]
        dst[to + 3] = src[from + 3]
      }
    }
    return new photon.PhotonImage(dst, h, w)
  }

  // 翻转是原地改,旋转会造一张新的(调用方负责把两张都 free 掉)。
  const orient = (source: PhotonImage): { image: PhotonImage; changed: boolean } => {
    switch (request.orientation) {
      case 2:
        photon.fliph(source)
        return { image: source, changed: true }
      case 3:
        photon.fliph(source)
        photon.flipv(source)
        return { image: source, changed: true }
      case 4:
        photon.flipv(source)
        return { image: source, changed: true }
      case 5: {
        const rotated = rotate90(source, (x, y, _w, h) => x * h + (h - 1 - y))
        photon.fliph(rotated)
        return { image: rotated, changed: true }
      }
      case 6:
        return { image: rotate90(source, (x, y, _w, h) => x * h + (h - 1 - y)), changed: true }
      case 7: {
        const rotated = rotate90(source, (x, y, w, h) => (w - 1 - x) * h + y)
        photon.fliph(rotated)
        return { image: rotated, changed: true }
      }
      case 8:
        return { image: rotate90(source, (x, y, w, h) => (w - 1 - x) * h + y), changed: true }
      default:
        return { image: source, changed: false }
    }
  }

  let decoded: PhotonImage | undefined
  let rotated: PhotonImage | undefined
  try {
    try {
      decoded = photon.PhotonImage.new_from_byteslice(request.bytes)
    } catch {
      return { kind: "undecodable" }
    }
    const oriented = orient(decoded)
    if (oriented.image !== decoded) rotated = oriented.image
    const image = oriented.image

    const originalWidth = image.get_width()
    const originalHeight = image.get_height()

    if (
      !request.forceEncode &&
      !oriented.changed &&
      originalWidth <= request.maxWidth &&
      originalHeight <= request.maxHeight &&
      base64Size(request.bytes.byteLength) < request.maxBase64Bytes
    ) {
      return { kind: "unchanged", originalWidth, originalHeight }
    }

    let width = originalWidth
    let height = originalHeight
    if (width > request.maxWidth) {
      height = Math.max(1, Math.round((height * request.maxWidth) / width))
      width = request.maxWidth
    }
    if (height > request.maxHeight) {
      width = Math.max(1, Math.round((width * request.maxHeight) / height))
      height = request.maxHeight
    }
    width = Math.max(1, width)
    height = Math.max(1, height)

    while (true) {
      // 尺寸没变就别重采样:1:1 的 Lanczos3 既慢又会让边缘发虚,而"只换格式"(BMP→PNG)恰恰走这条路。
      const sameSize = width === originalWidth && height === originalHeight
      const resized = sameSize ? image : photon.resize(image, width, height, photon.SamplingFilter.Lanczos3)
      try {
        const candidates: Array<{ bytes: Uint8Array; mimeType: string }> = [
          { bytes: resized.get_bytes(), mimeType: "image/png" },
        ]
        for (const quality of request.jpegQualities) {
          candidates.push({ bytes: resized.get_bytes_jpeg(quality), mimeType: "image/jpeg" })
        }
        for (const candidate of candidates) {
          if (base64Size(candidate.bytes.length) >= request.maxBase64Bytes) continue
          return {
            kind: "encoded",
            // 拷一份再交出去:下面的 finally 立刻 free 掉这张图,而 wasm 的返回值可能是它内存上的视图。
            bytes: new Uint8Array(candidate.bytes),
            mimeType: candidate.mimeType,
            originalWidth,
            originalHeight,
            width,
            height,
          }
        }
      } finally {
        if (!sameSize) resized.free()
      }

      if (width === 1 && height === 1) break
      const nextWidth = Math.max(1, Math.floor(width * 0.75))
      const nextHeight = Math.max(1, Math.floor(height * 0.75))
      if (nextWidth === width && nextHeight === height) break
      width = nextWidth
      height = nextHeight
    }

    return { kind: "too-big", originalWidth, originalHeight }
  } finally {
    rotated?.free()
    decoded?.free()
  }
}

/** worker 的整段源码。导出只为可测(测试直接起它,验证 toString 出来的东西真能跑)。 */
export const RENDER_WORKER_SOURCE = [
  'const { parentPort, workerData } = require("node:worker_threads")',
  // esbuild 的 `--keep-names` 会把函数体里的每个内部函数裹成 `__name(fn, "名字")`,而 `__name` 是产物
  // 顶部的辅助函数 —— 跟着 toString 过来的只有函数体,于是 worker 里是 ReferenceError。它只在**打包产物**
  // 里发作:源码跑的测试一律绿,用户装上包才发现图片全没了。这一行是恒等函数,不打包时它一次都不会被调到。
  "const __name = (value) => value",
  "const photon = require(workerData.entry)",
  `const renderImage = ${renderImage.toString()}`,
  'parentPort.once("message", (request) => {',
  "  try {",
  "    parentPort.postMessage({ ok: true, value: renderImage(photon, request) })",
  "  } catch (error) {",
  "    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })",
  "  }",
  "})",
].join("\n")

/** 一张图最多让 worker 干这么久。挂住的 wasm 不该把这次调用永远吊着。 */
const WORKER_TIMEOUT_MS = 60_000

/**
 * worker 连续失败多少次之后彻底改走进程内。
 *
 * 不是一次就判死:一张超大图把 worker 撑到 OOM 是**这一张**的事,为它把后面每张图都拽回内核的事件循环
 * (每张 0.5 秒起步的硬卡顿)不划算。也不是永不放弃:打包器改名把 worker 那份副本整个弄坏时,
 * 每张图先白起一个必死的线程同样不划算。连续三次 = 这条路真坏了。成功一次就归零。
 */
const MAX_WORKER_FAILURES = 3
let workerFailures = 0

function renderInWorker(entry: string, request: RenderRequest): Promise<RenderResult> {
  const worker = new Worker(RENDER_WORKER_SOURCE, { eval: true, workerData: { entry } })
  return new Promise<RenderResult>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      // 超时**不退回进程内**:真挂住的话,同一段活在内核的事件循环上跑就是整个 app 冻死,
      // 比等满 60 秒糟得多。这一张放弃,下一张照样起 worker。
      resolve({ kind: "failed" })
    }, WORKER_TIMEOUT_MS)
    timer.unref?.()
    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      run()
    }
    worker.once("message", (message: { ok?: boolean; value?: RenderResult; error?: string }) => {
      // `ok:false` **只可能**是 renderImage 在 worker 里抛了 —— 坏图片走的是 `ok:true` + `kind:"undecodable"`。
      // 也就是说这是 worker 那份副本的程序性故障(最典型的:打包器改名了它注入的辅助函数,见 __name 那一行),
      // 而进程内那份是好的。所以按"worker 坏了"处理:reject 出去,让 runRender 退回进程内。
      finish(() =>
        message?.ok && message.value
          ? resolve(message.value)
          : reject(new Error(message?.error ?? "image worker failed")),
      )
    })
    worker.once("error", (error: Error) => finish(() => reject(error)))
    worker.once("exit", (code: number) => finish(() => reject(new Error(`image worker exited with code ${code}`))))
    // 传进去的是**拷贝**:transfer 会把调用方的 buffer 摘掉,而放不下时调用方还要原样透传源字节。
    const copy = new Uint8Array(request.bytes)
    worker.postMessage({ ...request, bytes: copy }, [copy.buffer])
  }).finally(() => {
    void worker.terminate().catch(() => {})
  })
}

/**
 * 渲染一张图。**undefined 只有一个意思:这台机器根本没有图像后端**(没找到 photon)——
 * 单次渲染失败是 `{kind:"failed"}`。两者分开,因为给用户的话完全不同:一个是"这个版本没装这功能",
 * 一个是"这张图这次没弄成"。
 */
export async function runRender(request: RenderRequest): Promise<RenderResult | undefined> {
  const entry = resolvePhotonEntry()
  if (!entry) return undefined
  if (workerFailures < MAX_WORKER_FAILURES) {
    try {
      const result = await renderInWorker(entry, request)
      workerFailures = 0
      return result
    } catch {
      workerFailures++
    }
  }
  const photon = loadPhoton()
  if (!photon) return undefined
  try {
    return renderImage(photon, request)
  } catch {
    // 进程内这份也抛了(wasm 内存涨不上去之类)。renderImage 只兜住了解码那一步,别让它穿到
    // prompt() —— 那里没人接,一条没能压缩的图片会把用户整条消息变成一个 RPC 报错。
    return { kind: "failed" }
  }
}

/** 只给测试:把 worker 的失败计数清零。 */
export function resetRenderWorkerState(): void {
  workerFailures = 0
}
