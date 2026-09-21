/**
 * list() 从 JSONL 里读会话名时的两条竞态(host/session-manager.ts 的 list)。
 *
 * 扫名字要几毫秒,这中间同一个会话可能又被列一次、或者被改了名。真文件读得太快,竞态窗口撞不上,所以这里把
 * readSessionName 换成"照常读完、再等测试放行才交回结果":读到的是放行之前那一刻的文件,交回得晚 ——
 * 正是真实世界里慢磁盘上会发生的顺序。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type Model } from "@earendil-works/pi-ai"

import { SessionManager } from "./session-manager.ts"
import { patient } from "../../test/patience.ts"

const control = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, reads: 0 }))

vi.mock("./session-names.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-names.ts")>()
  return {
    ...actual,
    readSessionName: async (file: string) => {
      const name = await actual.readSessionName(file)
      control.reads += 1
      if (control.hold) await control.hold
      return name
    },
  }
})

beforeAll(() => {
  process.env.YOMA_PROBE_LOCK = path.join(tmpdir(), `yoma-probe-test-${process.pid}.lock`)
})

const cleanups: Array<() => Promise<void>> = []
const roots: string[] = []
afterEach(async () => {
  control.hold = undefined
  control.reads = 0
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > patient(10_000)) throw new Error(`等待超时:${what}`)
    await sleep(5)
  }
}

let providerCount = 0

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "yoma-list-names-"))
  roots.push(root)
  const workspace = path.join(root, "ws")
  mkdirSync(workspace)
  const faux = fauxProvider({ provider: `list-names-${++providerCount}`, models: [{ id: "plain" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("好的")])))
  const model = faux.getModel() as Model<string>
  const open = () => {
    const manager = new SessionManager({
      sessionsRoot: path.join(root, "sessions"),
      configDir: path.join(root, "config"),
      emit: () => {},
      resolveModels: async () => ({ models, model }),
      inspectStm32Availability: async () => ({ available: false, reason: "test" }),
      subagents: { outputRoot: path.join(root, "tasks"), homeDir: root },
    })
    cleanups.push(() => manager.disposeAll())
    return manager
  }
  return { open, workspace }
}

function gate() {
  let release!: () => void
  control.hold = new Promise<void>((resolve) => (release = resolve))
  return release
}

test("同一个目录并发列两次:后一次也等名字扫完再回(先回的占位会在界面上盖掉名字)", async () => {
  const { open, workspace } = setup()
  const first = open()
  const session = await first.create(workspace, "串口乱码排查")
  await first.disposeAll()

  const manager = open()
  const release = gate()
  const one = manager.list(workspace)
  await waitFor(() => control.reads === 1, "第一次 list 开始扫")
  let secondDone = false
  const two = manager.list(workspace).then((list) => {
    secondDone = true
    return list
  })
  await sleep(50)
  expect(secondDone).toBe(false)
  release()
  const [a, b] = await Promise.all([one, two])
  expect(a.find((item) => item.id === session.id)?.title).toBe("串口乱码排查")
  expect(b.find((item) => item.id === session.id)?.title).toBe("串口乱码排查")
  // 一个文件在一个进程里只扫一次。
  expect(control.reads).toBe(1)
})

test("扫名字期间用户改了名:改的名字赢,扫出来的旧名字不盖回去", async () => {
  const { open, workspace } = setup()
  const first = open()
  const session = await first.create(workspace, "旧名")
  await first.disposeAll()

  const manager = open()
  const release = gate()
  const listing = manager.list(workspace)
  await waitFor(() => control.reads === 1, "list 读完了旧名、卡在交回之前")
  await manager.rename(session.id, "新名")
  release()
  const listed = await listing
  expect(listed.find((item) => item.id === session.id)?.title).toBe("新名")
  expect(manager.get(session.id).title).toBe("新名")
})
