/**
 * 读图缩放(host/domain/image/)的验收:EXIF 方向解析、渲染原语、限额策略、以及 photon 的加载姿势。
 *
 * 这一组里有两条是**承重**的,别顺手删:
 * - "worker 与进程内逐字节一致":renderImage 的源码被 `toString()` 塞进 worker,它一旦引用了模块作用域
 *   的任何东西,在 worker 里就是 ReferenceError —— 这条用例是唯一会当场变红的地方。
 * - "源码里不许 import photon":这个包必须对打包器隐形(理由见 photon.ts 头注释);写成 import 的那一刻
 *   信箱产物会在加载时 ERR_AMBIGUOUS_MODULE_SYNTAX,而那个失败和图片八竿子打不着。
 *
 * 图片夹具用 zlib 现造,不塞几十行 base64 常量:尺寸、颜色、噪声都要按用例调。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { crc32, deflateSync } from "node:zlib"

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { createAgentTools } from "../src/host/session-manager.ts"

import { ORIENTATION_NONE, readExifOrientation } from "../src/host/domain/image/exif.ts"
import { loadPhoton, resetPhotonCache, resolvePhotonEntry } from "../src/host/domain/image/photon.ts"
import {
  DEFAULT_MAX_BASE64_BYTES,
  formatDimensionNote,
  processImage,
  resizeImage,
} from "../src/host/domain/image/process.ts"
import {
  RENDER_WORKER_SOURCE,
  type RenderRequest,
  type RenderResult,
  renderImage,
  resetRenderWorkerState,
  runRender,
} from "../src/host/domain/image/render.ts"

const imageDir = path.join(fileURLToPath(new URL("..", import.meta.url)), "src", "host", "domain", "image")

// ─── 夹具 ────────────────────────────────────────────────────────────────────

function pngChunk(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(body.length, 0)
  header.write(type, 4, "ascii")
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0)
  return Buffer.concat([header, body, checksum])
}

/** 造一张 24bpp 的 PNG。`noisy` 决定像素是不是压不动 —— 要测字节限额就得压不动。 */
function createPng(width: number, height: number, noisy = false): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  let seed = 0x2f6e2b1
  for (let y = 0; y < height; y++) {
    const row = y * stride
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3
      if (noisy) {
        // Math.imul 才是 32 位乘法:写 `*` 会超出 double 精度,低位被抹平,噪声退化成可压缩的花纹。
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
        raw[at] = seed & 0xff
        raw[at + 1] = (seed >> 8) & 0xff
        raw[at + 2] = (seed >> 16) & 0xff
      } else {
        raw[at] = (x * 7) & 0xff
        raw[at + 1] = (y * 5) & 0xff
        raw[at + 2] = 0x40
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function pngSize(base64Data: string): { width: number; height: number } {
  const buffer = Buffer.from(base64Data, "base64")
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** 1×1 的 24bpp BMP:模型收不了 BMP,它走的是"必须重编码"那条路。 */
function createBmp1x1(): Buffer {
  const buffer = Buffer.alloc(58)
  buffer.write("BM", 0, "ascii")
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(1, 18)
  buffer.writeInt32LE(1, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(0, 30)
  buffer.writeUInt32LE(4, 34)
  buffer[56] = 0xff
  return buffer
}

/** 2×1 的极小 JPEG(pi 的夹具),用来拼 EXIF 段。 */
const TINY_JPEG_2X1 =
  "/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAIDAREAAhEBAxEB/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4H8Q/8h/Uv+vmX/0M1/o1wJ/ySWU/9g1D/wBNRMOM/wDkp8z/AOv9b/05I//Z"

function app1Segment(payload: Buffer): Buffer {
  const segment = Buffer.alloc(payload.length + 4)
  segment[0] = 0xff
  segment[1] = 0xe1
  segment.writeUInt16BE(payload.length + 2, 2)
  segment.set(payload, 4)
  return segment
}

/** XMP 也是 APP1,而且常常排在 EXIF 前面 —— 碰到第一个 APP1 就停的解析会把方向读丢。 */
function jpegWithXmpBeforeOrientation(): Buffer {
  const jpeg = Buffer.from(TINY_JPEG_2X1, "base64")
  const xmp = app1Segment(Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'))
  const orientation6 = app1Segment(
    Buffer.concat([
      Buffer.from("Exif\0\0"),
      Buffer.from("49492a0008000000010112010300010000000600000000000000", "hex"),
    ]),
  )
  return Buffer.concat([jpeg.subarray(0, 2), xmp, orientation6, jpeg.subarray(2)])
}

function request(bytes: Buffer, overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    bytes: new Uint8Array(bytes),
    orientation: ORIENTATION_NONE,
    maxWidth: 2000,
    maxHeight: 2000,
    maxBase64Bytes: DEFAULT_MAX_BASE64_BYTES,
    jpegQualities: [80],
    forceEncode: false,
    ...overrides,
  }
}

/** 直接起一个 worker 跑那段 toString 出来的源码 —— 不经过 runRender 的降级逻辑。 */
function renderInWorkerDirectly(entry: string, payload: RenderRequest): Promise<RenderResult> {
  const worker = new Worker(RENDER_WORKER_SOURCE, { eval: true, workerData: { entry } })
  return new Promise<RenderResult>((resolve, reject) => {
    worker.once("message", (message: { ok?: boolean; value?: RenderResult; error?: string }) => {
      if (message?.ok) resolve(message.value as RenderResult)
      else reject(new Error(message?.error ?? "worker failed"))
    })
    worker.once("error", reject)
    worker.once("exit", (code) => reject(new Error(`worker exited ${code}`)))
    worker.postMessage(payload)
  }).finally(() => {
    void worker.terminate().catch(() => {})
  })
}

const originalPhotonDir = process.env.YOMA_PHOTON_DIR

beforeEach(() => {
  delete process.env.YOMA_PHOTON_DIR
  resetPhotonCache()
  resetRenderWorkerState()
})

afterEach(() => {
  if (originalPhotonDir === undefined) delete process.env.YOMA_PHOTON_DIR
  else process.env.YOMA_PHOTON_DIR = originalPhotonDir
  resetPhotonCache()
  resetRenderWorkerState()
})

// ─── EXIF ────────────────────────────────────────────────────────────────────

describe("readExifOrientation", () => {
  it("没有 EXIF 的 PNG / JPEG 一律当作不用转", () => {
    expect(readExifOrientation(new Uint8Array(createPng(4, 4)))).toBe(ORIENTATION_NONE)
    expect(readExifOrientation(new Uint8Array(Buffer.from(TINY_JPEG_2X1, "base64")))).toBe(ORIENTATION_NONE)
  })

  it("EXIF 排在 XMP 后面也读得到方向:不能碰到第一个 APP1 就收手", () => {
    expect(readExifOrientation(new Uint8Array(jpegWithXmpBeforeOrientation()))).toBe(6)
  })

  it("截断、乱码、空字节都不炸,一律回落到不用转", () => {
    expect(readExifOrientation(new Uint8Array(0))).toBe(ORIENTATION_NONE)
    expect(readExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]))).toBe(ORIENTATION_NONE)
    expect(readExifOrientation(new Uint8Array(jpegWithXmpBeforeOrientation().subarray(0, 40)))).toBe(ORIENTATION_NONE)
  })
})

// ─── 渲染原语 ────────────────────────────────────────────────────────────────

describe("renderImage", () => {
  it("没超限又不用转向:报 unchanged,让调用方原样用源字节(不白白重编码一遍)", () => {
    const photon = loadPhoton()!
    const result = renderImage(photon, request(createPng(32, 24)))
    expect(result).toEqual({ kind: "unchanged", originalWidth: 32, originalHeight: 24 })
  })

  it("forceEncode 时即使没超限也重新编码 —— BMP 这类模型收不了的格式走这条路", () => {
    const photon = loadPhoton()!
    const result = renderImage(photon, request(createBmp1x1(), { forceEncode: true, jpegQualities: [] }))
    expect(result.kind).toBe("encoded")
    if (result.kind !== "encoded") return
    expect(result.mimeType).toBe("image/png")
    expect(result.width).toBe(1)
    expect(result.height).toBe(1)
  })

  it("超尺寸就按比例缩,长边压到上限", () => {
    const photon = loadPhoton()!
    const result = renderImage(photon, request(createPng(120, 60), { maxWidth: 40, maxHeight: 40 }))
    expect(result.kind).toBe("encoded")
    if (result.kind !== "encoded") return
    expect([result.originalWidth, result.originalHeight]).toEqual([120, 60])
    expect([result.width, result.height]).toEqual([40, 20])
  })

  it("认不出的字节报 undecodable,不抛", () => {
    const photon = loadPhoton()!
    const result = renderImage(photon, request(Buffer.from("这不是图片")))
    expect(result).toEqual({ kind: "undecodable" })
  })

  it("怎么缩都塞不进限额时报 too-big,而不是交一张超限的图出去", () => {
    const photon = loadPhoton()!
    const result = renderImage(photon, request(createPng(64, 64, true), { maxBase64Bytes: 1 }))
    expect(result.kind).toBe("too-big")
  })

  it("worker 与进程内逐字节一致 —— renderImage 必须自包含(源码要被 toString 塞进 worker)", async () => {
    const photon = loadPhoton()!
    const entry = resolvePhotonEntry()!
    const source = createPng(90, 60, true)
    for (const payload of [
      request(source, { maxWidth: 40, maxHeight: 40 }),
      request(source, { orientation: 6 }),
      request(source, { maxBase64Bytes: 1 }),
      request(Buffer.from("这不是图片")),
    ]) {
      const inProcess = renderImage(photon, payload)
      const viaWorker = await renderInWorkerDirectly(entry, payload)
      expect(viaWorker).toEqual(inProcess)
    }
  }, 30_000)

  it("EXIF 方向 6 会把宽高对调 —— 竖着拍的照片不该横着交给模型", () => {
    const photon = loadPhoton()!
    const upright = renderImage(photon, request(createPng(60, 20), { forceEncode: true }))
    const rotated = renderImage(photon, request(createPng(60, 20), { orientation: 6, forceEncode: true }))
    expect(upright.kind).toBe("encoded")
    expect(rotated.kind).toBe("encoded")
    if (upright.kind !== "encoded" || rotated.kind !== "encoded") return
    expect([upright.width, upright.height]).toEqual([60, 20])
    expect([rotated.width, rotated.height]).toEqual([20, 60])
  })
})

describe("runRender", () => {
  it("默认走 worker,结果与进程内一致;调用方的字节不被 transfer 摘走", async () => {
    const photon = loadPhoton()!
    const source = createPng(80, 50, true)
    const payload = request(source, { maxWidth: 30, maxHeight: 30 })
    const keep = payload.bytes
    const viaWorker = await runRender(payload)
    expect(keep.byteLength).toBeGreaterThan(0) // transfer 了拷贝而不是本体
    expect(viaWorker).toEqual(renderImage(photon, request(source, { maxWidth: 30, maxHeight: 30 })))
  }, 30_000)

  it("没有 photon 时返回 undefined,而不是抛", async () => {
    process.env.YOMA_PHOTON_DIR = path.join(imageDir, "没有这个目录")
    resetPhotonCache()
    expect(resolvePhotonEntry()).toBeUndefined()
    expect(await runRender(request(createPng(8, 8)))).toBeUndefined()
  })
})

// ─── 限额策略 ────────────────────────────────────────────────────────────────

describe("resizeImage", () => {
  it("没超限:原样返回源字节与源格式,wasResized 为假", async () => {
    const png = createPng(32, 24)
    const outcome = await resizeImage(new Uint8Array(png), "image/png")
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.image.data).toBe(png.toString("base64"))
    expect(outcome.image.wasResized).toBe(false)
    expect([outcome.image.originalWidth, outcome.image.originalHeight]).toEqual([32, 24])
  }, 30_000)

  it("超字节限额:换成更小的一份,尺寸与原图一并报出来", async () => {
    const png = createPng(200, 200, true)
    const outcome = await resizeImage(new Uint8Array(png), "image/png", {
      maxBytes: Math.floor((png.length * 4) / 3 / 2),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(Buffer.from(outcome.image.data, "base64").length).toBeLessThan(png.length)
    expect(outcome.image.originalWidth).toBe(200)
  }, 30_000)

  it("image/jpg 当作 image/jpeg;认不出的字节报 undecodable", async () => {
    const jpeg = Buffer.from(TINY_JPEG_2X1, "base64")
    const outcome = await resizeImage(new Uint8Array(jpeg), "image/jpg")
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.image.mimeType).toBe("image/jpeg")
    expect(await resizeImage(new Uint8Array(Buffer.from("nope")), "image/png")).toEqual({
      ok: false,
      reason: "undecodable",
    })
  }, 30_000)
})

describe("formatDimensionNote", () => {
  it("缩过才说,并给出坐标换算比例", () => {
    const base = { data: "", mimeType: "image/png", originalWidth: 2000, originalHeight: 1000 }
    expect(formatDimensionNote({ ...base, width: 2000, height: 1000, wasResized: false })).toBeUndefined()
    const note = formatDimensionNote({ ...base, width: 1000, height: 500, wasResized: true })
    expect(note).toContain("original 2000x1000")
    expect(note).toContain("displayed at 1000x500")
    expect(note).toContain("2.00")
  })
})

describe("processImage", () => {
  it("BMP 转成 PNG 并说明转过 —— 不缩放时也要转,否则模型根本收不了", async () => {
    for (const autoResizeImages of [true, false]) {
      const result = await processImage(new Uint8Array(createBmp1x1()), "image/bmp", { autoResizeImages })
      expect(result.ok, JSON.stringify(result)).toBe(true)
      if (!result.ok) return
      expect(result.mimeType).toBe("image/png")
      expect(result.hints).toContain("[Image converted from image/bmp to image/png.]")
      expect(Buffer.from(result.data, "base64").subarray(1, 4).toString("ascii")).toBe("PNG")
    }
  }, 30_000)

  it("缩过就把换算比例一并交给模型", async () => {
    const result = await processImage(new Uint8Array(createPng(120, 60)), "image/png", {
      resizeOptions: { maxWidth: 40, maxHeight: 40 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(pngSize(result.data)).toEqual({ width: 40, height: 20 })
    expect(result.hints.join("\n")).toContain("original 120x60")
  }, 30_000)

  it("autoResizeImages:false 时不缩,只在必要时转格式", async () => {
    // 尺寸必须**超过缺省上限**,否则两条分支的结果一模一样,这条用例就是空转的:
    // 开着自动缩放会被压到 2000 宽,关掉则原样。
    const png = createPng(2400, 1200)
    const result = await processImage(new Uint8Array(png), "image/png", { autoResizeImages: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toBe(png.toString("base64"))
    expect(result.hints).toEqual([])

    const resized = await processImage(new Uint8Array(png), "image/png")
    expect(resized.ok).toBe(true)
    if (!resized.ok) return
    expect(pngSize(resized.data)).toEqual({ width: 2000, height: 1000 })
  }, 30_000)

  it("压不进限额就明说没送,不交一张超限的图出去(超限会让整段对话被拒)", async () => {
    const result = await processImage(new Uint8Array(createPng(64, 64, true)), "image/png", {
      resizeOptions: { maxBytes: 1 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("could not be resized")
  }, 30_000)

  it("没有图像后端时:能内嵌又没超限的原样放过去,要转/要压的才说明为什么没送", async () => {
    process.env.YOMA_PHOTON_DIR = path.join(imageDir, "没有这个目录")
    resetPhotonCache()
    const png = createPng(16, 16)

    const passthrough = await processImage(new Uint8Array(png), "image/png")
    expect(passthrough).toEqual({ ok: true, data: png.toString("base64"), mimeType: "image/png", hints: [] })

    const needsConversion = await processImage(new Uint8Array(createBmp1x1()), "image/bmp")
    expect(needsConversion.ok).toBe(false)
    if (needsConversion.ok) return
    expect(needsConversion.message).toContain("no image backend")

    const tooBig = await processImage(new Uint8Array(png), "image/png", { resizeOptions: { maxBytes: 8 } })
    expect(tooBig.ok).toBe(false)
  })
})

// ─── 接线 ────────────────────────────────────────────────────────────────────

describe("read 工具接上了图像处理", () => {
  it("读一张 BMP 拿到的是 PNG 附件,而不是发动机那句「配个 imageProcessor」", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yoma-image-read-"))
    try {
      const file = path.join(dir, "board.bmp")
      writeFileSync(file, createBmp1x1())
      const read = createAgentTools().find((tool) => tool.name === "read")!
      const result = await read.execute(
        "c1",
        { path: file },
        () => {},
        { env: new NodeExecutionEnv({ cwd: dir }) },
        {
          invocationId: "inv-1",
          operationId: "op-1",
          turnId: "turn-1",
          getMemo: async () => undefined,
          setMemo: async () => {},
        },
        BACKGROUND_CONTEXT,
      )
      const image = result.content.find((part) => part.type === "image")
      expect(image, JSON.stringify(result.content)).toBeDefined()
      expect((image as { mimeType?: string }).mimeType).toBe("image/png")
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      expect(text).toContain("converted from image/bmp")
      expect(text).not.toContain("configure an imageProcessor")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// ─── 打包纪律 ────────────────────────────────────────────────────────────────

describe("photon 对打包器隐形", () => {
  it("源码里一个 photon 的 import 说明符都没有(类型位置除外);包名只作为运行期字符串出现", () => {
    // 认的是**语法**而不是字面量:`const PACKAGE = "@silvia-odwyer/photon-node"` 正是我们要的写法 ——
    // 它在运行期才交给 createRequire().resolve(),打包器静态分析不到。
    const importing = /(\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["'])@silvia-odwyer\/photon-node/
    const offenders: string[] = []
    for (const name of ["photon.ts", "exif.ts", "render.ts", "process.ts"]) {
      const text = readFileSync(path.join(imageDir, name), "utf8")
      for (const line of text.split("\n")) {
        if (!importing.test(line)) continue
        // 只有类型位置合法:`import type { … } from`、`typeof import("…")`。两者都会被编译器抹掉。
        if (/^\s*import type /.test(line) || /typeof import\(/.test(line)) continue
        offenders.push(`${name}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("按 --keep-names 打成包之后 worker 照样跑得起来(那时函数体里会多出 __name)", async () => {
    const { build } = await import("esbuild")
    const dir = mkdtempSync(path.join(tmpdir(), "yoma-image-bundle-"))
    try {
      const entry = path.join(dir, "entry.ts")
      const png = createPng(60, 40).toString("base64")
      writeFileSync(
        entry,
        [
          `import { Worker } from "node:worker_threads"`,
          `import { RENDER_WORKER_SOURCE } from ${JSON.stringify(path.join(imageDir, "render.ts"))}`,
          `import { resolvePhotonEntry } from ${JSON.stringify(path.join(imageDir, "photon.ts"))}`,
          `const worker = new Worker(RENDER_WORKER_SOURCE, { eval: true, workerData: { entry: resolvePhotonEntry() } })`,
          `worker.once("message", (m) => {`,
          `  console.log(JSON.stringify({ ok: m.ok, error: m.error, kind: m.value && m.value.kind, w: m.value && m.value.width }))`,
          `  void worker.terminate()`,
          `})`,
          `worker.postMessage({`,
          `  bytes: new Uint8Array(Buffer.from(${JSON.stringify(png)}, "base64")),`,
          `  orientation: 1, maxWidth: 20, maxHeight: 20, maxBase64Bytes: 1e9, jpegQualities: [80], forceEncode: false,`,
          `})`,
        ].join("\n"),
      )
      const outfile = path.join(dir, "bundle.cjs")
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: "node",
        format: "cjs",
        keepNames: true,
        logLevel: "silent",
      })
      // 打包后的产物里 photon 应当一点痕迹都没有(否则带顶层 await 的产物会 ERR_AMBIGUOUS_MODULE_SYNTAX)。
      expect(readFileSync(outfile, "utf8")).not.toContain("photon_rs_bg.wasm")
      const stdout = execFileSync(process.execPath, [outfile], { encoding: "utf8", cwd: process.cwd() })
      expect(JSON.parse(stdout.trim())).toEqual({ ok: true, error: undefined, kind: "encoded", w: 20 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("压缩过的包里 worker 那份副本会坏掉,但结果照样对 —— 退回进程内是承重的兜底", async () => {
    const { build } = await import("esbuild")
    const dir = mkdtempSync(path.join(tmpdir(), "yoma-image-min-"))
    try {
      const entry = path.join(dir, "entry.ts")
      const png = createPng(60, 40).toString("base64")
      // 走 runRender(而不是直接起 worker):它先试 worker,坏了就退回进程内。压缩会把 esbuild 注入的
      // 辅助函数改名,于是 worker 里那份 toString 出来的副本必然 ReferenceError —— 名字对不上,shim 救不了。
      // 能救的是"worker 报错就退回进程内"这条路,这条用例钉的就是它。
      writeFileSync(
        entry,
        [
          `import { runRender } from ${JSON.stringify(path.join(imageDir, "render.ts"))}`,
          `const result = await runRender({`,
          `  bytes: new Uint8Array(Buffer.from(${JSON.stringify(png)}, "base64")),`,
          `  orientation: 1, maxWidth: 20, maxHeight: 20, maxBase64Bytes: 1e9, jpegQualities: [80], forceEncode: false,`,
          `})`,
          `console.log(JSON.stringify({ kind: result && result.kind, w: result && result.width }))`,
        ].join("\n"),
      )
      const outfile = path.join(dir, "bundle.mjs")
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        keepNames: true,
        minify: true,
        logLevel: "silent",
      })
      const stdout = execFileSync(process.execPath, [outfile], { encoding: "utf8", cwd: process.cwd() })
      expect(JSON.parse(stdout.trim())).toEqual({ kind: "encoded", w: 20 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("这条规矩管用:真写成 import 会被抓出来", () => {
    const importing = /(\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["'])@silvia-odwyer\/photon-node/
    expect(importing.test('import photon from "@silvia-odwyer/photon-node"')).toBe(true)
    expect(importing.test('const p = await import("@silvia-odwyer/photon-node")')).toBe(true)
    expect(importing.test('const p = require("@silvia-odwyer/photon-node")')).toBe(true)
    expect(importing.test('const PACKAGE = "@silvia-odwyer/photon-node"')).toBe(false)
  })
})
