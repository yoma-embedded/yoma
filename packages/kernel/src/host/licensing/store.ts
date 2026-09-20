/**
 * 授权文件的落盘:`<configDir>/license.json`。
 *
 * 与模型凭据 `auth.json` **分开**:两样东西的来源、生命周期、敏感度都不同(授权文件是开发者签发、
 * 可以再发一遍的;API key 是客户自己的秘密),混在一个文件里,任何一边写坏都会连累另一边。
 *
 * 写入是"临时文件 + rename":同目录下写完、fsync、再整体替换。断电或崩溃之后盘上要么是旧的那份、
 * 要么是新的那份,不会是半份 —— 半份授权读出来是"授权无效",而客户什么都没做错。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

import { LICENSE_MAX_BYTES } from "../../license-view.ts"

export const LICENSE_FILE_NAME = "license.json"

/**
 * 默认的全局配置目录。**这是 `host/auth.ts` 的 `yomaConfigDir()` 的副本** —— 本目录必须保持叶子模块
 * (desktop 的 main 要经叶子门 import 它,而 `auth.ts` 会把模型目录整个拖进来)。
 * 两份的漂移由 `licensing.test.ts` 里的断言兜住。
 */
export function defaultLicenseConfigDir(): string {
  return path.join(homedir(), ".yoma")
}

export function licenseFilePath(configDir: string = defaultLicenseConfigDir()): string {
  return path.join(configDir, LICENSE_FILE_NAME)
}

export type StoredLicenseRead =
  | { kind: "missing" }
  | { kind: "too-large"; bytes: number }
  | { kind: "unreadable"; message: string }
  | { kind: "text"; text: string }

/** 读存盘的授权。先看大小再读:一个被换成几个 GB 的文件不该被整个读进内存。 */
export function readStoredLicense(configDir?: string): StoredLicenseRead {
  const file = licenseFilePath(configDir)
  let size: number
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return { kind: "unreadable", message: `${file} 不是普通文件` }
    size = stat.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
    return { kind: "unreadable", message: (error as Error).message }
  }
  if (size > LICENSE_MAX_BYTES) return { kind: "too-large", bytes: size }
  try {
    return { kind: "text", text: readFileSync(file, "utf8") }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
    return { kind: "unreadable", message: (error as Error).message }
  }
}

const RENAME_RETRIES = 5

/** 原子写。失败时抛出,原文件保持原样,临时文件清掉。 */
export function writeStoredLicenseAtomic(text: string, configDir?: string): string {
  const file = licenseFilePath(configDir)
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = path.join(dir, `.${LICENSE_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    const fd = openSync(temp, "wx", 0o600)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // Windows 上目标文件被别的进程(杀毒、另一个正在读的 Yoma 进程)短暂占着时 rename 会 EPERM / EBUSY。
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(temp, file)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
      }
    }
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return file
}
