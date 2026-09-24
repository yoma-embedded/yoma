/**
 * 主进程的 JSON 存储:一个文件一份对象,内存里留着,改了就整份原子写回。顶替 electron-store(conf)。
 *
 * 换掉它的理由是量出来的:conf 光 import 就要约 23 ms(背着 ajv 一家子,而我们不用 schema),在启动的关键路径上;
 * 它每次 get 都重读整个文件,每次 set 都是 读 + 解析 + 序列化 + 写。这里文件只在第一次用到时读一次。
 *
 * **文件格式原样不动**(制表符缩进的一个 JSON 对象,文件名不带扩展名):老档案直接读,退回旧版本也读得了我们写的。
 * 写仍然是同步的、带 fsync 的原子写(临时文件 + rename):主进程的这些设置是用户动一下才写一次,渲染器那边的写
 * 已经攒成批了(app 的 namespace-storage.ts),一次 4–6 ms 不值得为它引入"内存和磁盘暂时不一致"的异步写。
 *
 * 前提:一个文件只有这一个进程在写。别的进程改了文件,这里不会知道(也没有别的进程在改)。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import path from "node:path"

export type JsonStore = {
  readonly path: string
  get(key: string): unknown
  /** 值不能是 undefined(JSON 里没有它):要清掉一个键用 delete。 */
  set(key: string, value: unknown): void
  delete(key: string): void
  clear(): void
  /** 当前全部内容的浅拷贝。 */
  entries(): Record<string, unknown>
  /** 一批插入 / 覆盖 / 删除,只写一次盘。 */
  update(insert: Record<string, unknown>, remove: readonly string[]): void
}

/** 出一份新对象,不动传进来的那份。同一批里又插又删同一个键:删赢。 */
export function applyUpdate(
  data: Record<string, unknown>,
  insert: Record<string, unknown>,
  remove: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...data, ...insert }
  for (const key of remove) delete next[key]
  return next
}

// Windows 上文件正被杀毒 / 索引服务打开时,读和 rename 都会短暂地 EPERM / EBUSY / EACCES。等一等再试。
const RETRY_MS = [10, 20, 40, 80]
const retryable = (error: unknown) =>
  ["EPERM", "EBUSY", "EACCES", "EMFILE", "ENFILE", "EAGAIN"].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? "",
  )
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function writeFileAtomic(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, "w")
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  for (const wait of [...RETRY_MS, undefined]) {
    try {
      return renameSync(tmp, file)
    } catch (error) {
      if (wait === undefined || !retryable(error)) {
        // 实在换不进去:宁可直接写(不原子),也不把这次改动丢掉。
        try {
          writeFileSync(file, content)
        } finally {
          rmSync(tmp, { force: true })
        }
        return
      }
      sleepSync(wait)
    }
  }
}

/** 没有文件是 undefined。别的读错误退避重试,还不行就抛 —— 交给调用方,不在这里猜。 */
function readText(file: string): string | undefined {
  for (const wait of [...RETRY_MS, undefined]) {
    try {
      return readFileSync(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      if (wait === undefined || !retryable(error)) throw error
      sleepSync(wait)
    }
  }
}

/**
 * 没有文件 = 空。**读不了 ≠ 坏了**:I/O 错误(文件被占着、没权限)原样抛出去,这时候当成空的继续,下一次写就把
 * 一份好好的文件盖成只剩几个键 —— 审查抓到的,头一版把它和 JSON 解析失败混在一个 catch 里了。
 * 只有内容确实不是一个 JSON 对象时才挪到一边(`.corrupt`,已经有一份了就带上时间戳,不盖掉上一次的)、当作空的
 * 继续,不挡启动 —— electron-store 在这里是直接抛。
 */
function read(file: string, onCorrupt?: (error: unknown) => void): Record<string, unknown> {
  const text = readText(file)
  if (text === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    throw new TypeError("not a JSON object")
  } catch (error) {
    onCorrupt?.(error)
    try {
      renameSync(file, existsSync(`${file}.corrupt`) ? `${file}.corrupt-${Date.now()}` : `${file}.corrupt`)
    } catch {}
    return {}
  }
}

export function createJsonStore(
  file: string,
  options: { persist?: (file: string, content: string) => void; onCorrupt?: (error: unknown) => void } = {},
): JsonStore {
  const persist = options.persist ?? writeFileAtomic
  let data: Record<string, unknown> | undefined
  const load = () => (data ??= read(file, options.onCorrupt))
  const commit = (next: Record<string, unknown>) => {
    // 先写成再认:写盘抛了的话内存里还是旧的,和磁盘一致。
    persist(file, JSON.stringify(next, undefined, "\t"))
    data = next
  }
  return {
    path: file,
    get: (key) => load()[key],
    set: (key, value) => {
      if (value === undefined) throw new TypeError(`Use \`delete()\` to clear values: ${key}`)
      commit({ ...load(), [key]: value })
    },
    delete: (key) => {
      if (!(key in load())) return
      commit(applyUpdate(load(), {}, [key]))
    },
    clear: () => commit({}),
    entries: () => ({ ...load() }),
    update: (insert, remove) => commit(applyUpdate(load(), insert, remove)),
  }
}
