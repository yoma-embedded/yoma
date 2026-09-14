/**
 * EXIF 方向标记的解析(从 pi 的 utils/exif-orientation.ts 移植的**解析那一半**)。
 *
 * 为什么要管它:手机拍的照片、很多截图工具存的 JPEG 都是"像素横着存、EXIF 里写一句该转 90°"。
 * 不认这句话就会把一张竖着的板子照片横着交给模型 —— 而模型会认真地按横着的样子描述接线。
 *
 * 纯字节解析,不碰 photon:于是它能单测,也能留在父进程(真正转像素的那几下在 render.ts 的
 * worker 里)。返回 1..8 的 EXIF 方向值,认不出来一律当 1(不用转)。
 */

/** JPEG / WebP 里没有 EXIF、或读不懂时的方向:不用转。 */
export const ORIENTATION_NONE = 1

function readOrientationFromTiff(bytes: Uint8Array, tiffStart: number): number {
  if (tiffStart + 8 > bytes.length) return ORIENTATION_NONE

  const byteOrder = (bytes[tiffStart] << 8) | bytes[tiffStart + 1]
  const le = byteOrder === 0x4949

  const read16 = (pos: number): number => {
    if (le) return bytes[pos] | (bytes[pos + 1] << 8)
    return (bytes[pos] << 8) | bytes[pos + 1]
  }

  const read32 = (pos: number): number => {
    if (le) return bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)
    return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0
  }

  const ifdOffset = read32(tiffStart + 4)
  const ifdStart = tiffStart + ifdOffset
  if (ifdStart + 2 > bytes.length) return ORIENTATION_NONE

  const entryCount = read16(ifdStart)
  for (let i = 0; i < entryCount; i++) {
    const entryPos = ifdStart + 2 + i * 12
    if (entryPos + 12 > bytes.length) return ORIENTATION_NONE
    // 0x0112 = Orientation
    if (read16(entryPos) === 0x0112) {
      const value = read16(entryPos + 8)
      return value >= 1 && value <= 8 ? value : ORIENTATION_NONE
    }
  }

  return ORIENTATION_NONE
}

function hasExifHeader(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes[offset] === 0x45 && // E
    bytes[offset + 1] === 0x78 && // x
    bytes[offset + 2] === 0x69 && // i
    bytes[offset + 3] === 0x66 && // f
    bytes[offset + 4] === 0x00 &&
    bytes[offset + 5] === 0x00
  )
}

/**
 * JPEG:逐个段往后走找带 Exif 头的 APP1。
 *
 * **不能碰到第一个 APP1 就停** —— 很多工具把 XMP(也是 APP1)写在 EXIF 前面,那一版会在 XMP 上
 * 判定"没有方向"然后把照片横过来(pi 的用例专门钉了这个形状)。
 */
function findJpegTiffOffset(bytes: Uint8Array): number {
  let offset = 2
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) return -1
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset++
      continue
    }

    if (marker === 0xe1) {
      if (offset + 4 >= bytes.length) return -1
      const segmentStart = offset + 4
      if (segmentStart + 6 > bytes.length) return -1
      if (hasExifHeader(bytes, segmentStart)) return segmentStart + 6
    }

    if (offset + 4 > bytes.length) return -1
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (length < 2) return -1
    offset += 2 + length
  }

  return -1
}

function findWebpTiffOffset(bytes: Uint8Array): number {
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    const chunkSize =
      bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)
    const dataStart = offset + 8

    if (chunkId === "EXIF") {
      if (chunkSize < 0 || dataStart + chunkSize > bytes.length) return -1
      // 有些 WebP 在 TIFF 头前面还带一段 "Exif\0\0"。
      return chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart
    }

    // RIFF 的块按偶数字节对齐。
    const next = dataStart + chunkSize + (chunkSize % 2)
    if (next <= offset) return -1
    offset = next
  }

  return -1
}

/** 这张图该转多少:1..8,没有或读不懂就是 1。只有 JPEG 与 WebP 带 EXIF。 */
export function readExifOrientation(bytes: Uint8Array): number {
  let tiffOffset = -1

  // JPEG:FF D8 开头。
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    tiffOffset = findJpegTiffOffset(bytes)
  }
  // WebP:RIFF....WEBP。
  else if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    tiffOffset = findWebpTiffOffset(bytes)
  }

  if (tiffOffset === -1) return ORIENTATION_NONE
  return readOrientationFromTiff(bytes, tiffOffset)
}
