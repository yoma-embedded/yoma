/**
 * 模型目录的本机缓存:`<configDir>/models-store.json`。
 *
 * 【为什么需要它】内建目录(`builtinProviders()`)是**随版本冻结的一张快照** —— 它随 pi 的生成数据一起进仓,
 * 而同步工具明确不动那份数据(见 UPSTREAM.md"模型目录 JSON 是单独的生成快照")。厂商上新模型的节奏
 * 比我们发版快得多:2026-09-14 实测,同一个 DeepSeek,pi 的命令行列得出 `deepseek-flash`,yoma 列不出 ——
 * 不是同步落后,是那个模型**从来没进过任何一份内建目录**,它是 pi 在运行时联网刷出来、写进用户目录的。
 *
 * pi-ai 本身已经备好了整条机制:`Provider.refreshModels()` 先把 `context.stored` 恢复回来、再联网拉新的、
 * 然后经 `context.publish({ persist })` 落盘,而"落到哪儿"由宿主给的这个 `ModelsStore` 决定。缺的只是
 * 一个真的写文件的实现 —— 缺省的 `InMemoryModelsStore` 一关进程就忘光。
 *
 * 【为什么不读 pi 的那份】`~/.pi/agent/models-store.json` 是 pi 的用户配置。读它等于把 yoma 绑在
 * "这台机器上装没装过 pi、pi 最近有没有跑过"上 —— 与上游同步不该依赖某台机器上的检出是同一条规矩。
 *
 * 【容错立场】这是**缓存**,不是账本:文件不存在、JSON 坏了、某个 provider 的条目形状不对,一律当"没有缓存"
 * 处理,让内建目录兜底。缓存读不出来绝不能让会话开不起来 —— 那比模型列表旧了严重得多。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"

import type { Api, Model, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai"

/** 文件形状:provider id → 该 provider 的缓存条目。与 pi 的同名文件同构,但各存各的。 */
type StoreFile = Record<string, ModelsStoreEntry>

export const MODELS_STORE_FILE = "models-store.json"

function isEntry(value: unknown): value is ModelsStoreEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as { models?: unknown }
  if (!Array.isArray(entry.models)) return false
  // 逐条过滤:一条坏的不连累同一个 provider 里其它写对的(同 toolchain 账本的立场)。
  return entry.models.every(
    (model) => !!model && typeof model === "object" && typeof (model as Model<Api>).id === "string",
  )
}

/**
 * 落到 `<configDir>/models-store.json`。
 *
 * 写是"整份读改写 + rename",所以同一个进程里两路并发写会互相踩掉(后写的抹掉先写的那一条)。
 * 这里**故意不排队**:pi-ai 的 refresh 对每个 provider 串行走一遍 publish,而且这是缓存 ——
 * 真丢了一条,下一次 refresh 会重新拉回来。与 toolchain 账本不同,那边丢的是用户亲口说过的路径。
 */
export class FileModelsStore implements ModelsStore {
  private readonly file: string

  constructor(configDir: string) {
    this.file = join(configDir, MODELS_STORE_FILE)
  }

  private load(): StoreFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
      const out: StoreFile = {}
      for (const [providerId, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (isEntry(entry)) out[providerId] = entry
      }
      return out
    } catch {
      // 不存在 / 坏了 / 没权限 —— 一律当没有缓存。
      return {}
    }
  }

  private save(next: StoreFile): void {
    const temporary = join(dirname(this.file), `.models-store-${randomUUID()}.tmp`)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 })
      // rename 是原子的:读的人要么看见旧的一整份,要么看见新的一整份,不会看见半份。
      renameSync(temporary, this.file)
    } catch {
      rmSync(temporary, { force: true })
      // 写不进去(磁盘满、只读目录)不该让刷新变成一次失败:模型已经在内存里可用了,
      // 只是下次启动要重新联网拉一遍。
    }
  }

  async read(providerId: string, options?: { signal?: AbortSignal }): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted()
    return this.load()[providerId]
  }

  async write(providerId: string, entry: ModelsStoreEntry, options?: { signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted()
    const next = this.load()
    next[providerId] = entry
    this.save(next)
  }

  async delete(providerId: string, options?: { signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted()
    const next = this.load()
    if (!(providerId in next)) return
    delete next[providerId]
    this.save(next)
  }
}
