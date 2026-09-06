/**
 * 自动安装这一层胶水(host/toolchain.ts 的 createInstallRegistry / installProgressEvent /
 * toolchainInstall)的验证。
 *
 * 下载 / 校验 / 解压 / 记账本身在 coding-agent 的 toolchain/install.ts,这里一律注入假
 * installer —— 这一层要证明的只有四件事:一个 id 同时只装一次(第二次 reject)、取消能
 * 真的把 signal abort 掉、跑完注销;进度回调按序翻译成 `toolchain.install` 事件;
 * 失败与取消都补一条终态事件(UI 的进度行靠它收尾,不然停在最后一个百分比上);
 * 装完 onInstalled 被 await 过再返回带机器级核账的结果。
 *
 * probe 全程注入(platform "linux" + 空 PATH):statusAfterInstall 会真的跑一遍机器级
 * 核账,不注入的话开发机上真装了什么会悄悄决定断言(toolchain.test.ts 同一条纪律)。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { InstalledToolchain, installToolchain } from "@yoma/coding-agent"

import type { KernelEvent } from "../protocol.ts"
import { createKernelHost } from "./index.ts"
import { createInstallRegistry, toolchainInstall } from "./toolchain.ts"

const roots: string[] = []
let configDir: string

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

beforeEach(() => {
  configDir = tempDir("yoma-tc-install-config-")
})

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function baseOpts() {
  return {
    configDir,
    side: "mother" as const,
    probe: {
      platform: "linux",
      env: { PATH: "", PATHEXT: ".EXE;.CMD;.BAT;.COM" },
    },
  }
}

function fakeInstalled(over: Partial<InstalledToolchain> = {}): InstalledToolchain {
  const dir = path.join(configDir, "toolchains", "arm-gnu-toolchain", "15.2.rel1")
  return {
    packageId: "arm-gnu-toolchain",
    version: "15.2.rel1",
    dir,
    binDir: path.join(dir, "bin"),
    reused: false,
    recorded: [],
    ...over,
  }
}

/** 收集器:只留 toolchain.install 事件(其余类型在这条路上不该出现)。 */
function installEvents(events: KernelEvent[]) {
  return events.flatMap((event) => (event.type === "toolchain.install" ? [event] : []))
}

describe("createInstallRegistry", () => {
  it("同一个 id 第二次开装直接 reject(message 含 already),第一个不受影响", async () => {
    const registry = createInstallRegistry()
    const gate = deferred<string>()
    const first = registry.start("arm-gcc", () => gate.promise)

    await expect(registry.start("arm-gcc", async () => "second")).rejects.toThrow(/already/i)

    gate.resolve("first")
    expect(await first).toBe("first")
  })

  it("不同 id 各跑各的,active() 反映在飞的那些,跑完注销", async () => {
    const registry = createInstallRegistry()
    const a = deferred<string>()
    const b = deferred<string>()
    const first = registry.start("arm-gcc", () => a.promise)
    const second = registry.start("cmake", () => b.promise)

    expect(registry.active().sort()).toEqual(["arm-gcc", "cmake"])

    a.resolve("a")
    await first
    expect(registry.active()).toEqual(["cmake"])

    b.resolve("b")
    await second
    expect(registry.active()).toEqual([])
  })

  it("cancel 把在装的那个 signal abort 掉并返回 true;没在装的返回 false", async () => {
    const registry = createInstallRegistry()
    let seen: AbortSignal | undefined
    const gate = deferred<string>()
    const running = registry.start("arm-gcc", (signal) => {
      seen = signal
      return gate.promise
    })

    expect(registry.cancel("nope")).toBe(false)
    expect(registry.cancel("arm-gcc")).toBe(true)
    expect(seen?.aborted).toBe(true)

    gate.resolve("done")
    await running
    // 注销之后再取消就没有对象了。
    expect(registry.cancel("arm-gcc")).toBe(false)
  })

  it("run 抛出时也注销(finally),同一个 id 可以立刻重试", async () => {
    const registry = createInstallRegistry()
    await expect(registry.start("arm-gcc", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(registry.active()).toEqual([])
    expect(await registry.start("arm-gcc", async () => "retry")).toBe("retry")
  })
})

describe("toolchainInstall", () => {
  it("进度回调按序翻译成 toolchain.install 事件(id / packageId / version / bytes 原样带上)", async () => {
    const received: KernelEvent[] = []
    const installer = (async (opts) => {
      const base = { toolId: opts.toolId, packageId: "arm-gnu-toolchain", version: "15.2.rel1" }
      opts.onProgress?.({ ...base, phase: "resolve" })
      opts.onProgress?.({ ...base, phase: "download", bytes: 10, total: 100 })
      opts.onProgress?.({ ...base, phase: "download", bytes: 100, total: 100 })
      opts.onProgress?.({ ...base, phase: "verify" })
      opts.onProgress?.({ ...base, phase: "extract" })
      opts.onProgress?.({ ...base, phase: "record" })
      opts.onProgress?.({ ...base, phase: "done" })
      return fakeInstalled()
    }) satisfies typeof installToolchain

    await toolchainInstall({
      ...baseOpts(),
      id: "arm-gcc",
      emit: (events) => received.push(...events),
      registry: createInstallRegistry(),
      installer,
    })

    const events = installEvents(received)
    expect(events.map((event) => event.phase)).toEqual([
      "resolve",
      "download",
      "download",
      "verify",
      "extract",
      "record",
      "done",
    ])
    expect(events.every((event) => event.id === "arm-gcc")).toBe(true)
    expect(events[0]!.packageId).toBe("arm-gnu-toolchain")
    expect(events[0]!.version).toBe("15.2.rel1")
    expect(events[1]).toMatchObject({ bytes: 10, total: 100 })
  })

  it("结果带装到哪 + 装完的机器级核账(declared:true,含这个工具那一行)", async () => {
    const installer = (async () => fakeInstalled()) satisfies typeof installToolchain

    const result = await toolchainInstall({
      ...baseOpts(),
      id: "arm-gcc",
      emit: () => {},
      registry: createInstallRegistry(),
      installer,
    })

    expect(result.id).toBe("arm-gcc")
    expect(result.packageId).toBe("arm-gnu-toolchain")
    expect(result.version).toBe("15.2.rel1")
    expect(result.binDir).toBe(fakeInstalled().binDir)
    expect(result.reused).toBe(false)
    expect(result.status.declared).toBe(true)
    expect(result.status.tools.map((tool) => tool.id)).toContain("arm-gcc")
  })

  it("工具 id 不在任何预设平台里:status 仍是 declared:true,但 tools 为空", async () => {
    const installer = (async () => fakeInstalled({ packageId: "widgetpkg" })) satisfies typeof installToolchain

    const result = await toolchainInstall({
      ...baseOpts(),
      id: "yoma-test-not-a-family-tool",
      emit: () => {},
      registry: createInstallRegistry(),
      installer,
    })

    expect(result.status.declared).toBe(true)
    expect(result.status.tools).toEqual([])
  })

  it("installer 抛出:补一条 phase error 的终态事件(带 message)再原样重抛,onInstalled 不跑", async () => {
    const received: KernelEvent[] = []
    let installedHooks = 0
    const installer = (async (opts) => {
      opts.onProgress?.({
        toolId: opts.toolId,
        packageId: "arm-gnu-toolchain",
        version: "15.2.rel1",
        phase: "download",
        bytes: 1,
        total: 100,
      })
      throw new Error("下载失败:所有候选地址都连不上")
    }) satisfies typeof installToolchain

    await expect(
      toolchainInstall({
        ...baseOpts(),
        id: "arm-gcc",
        emit: (events) => received.push(...events),
        registry: createInstallRegistry(),
        installer,
        onInstalled: () => {
          installedHooks += 1
        },
      }),
    ).rejects.toThrow(/所有候选地址都连不上/)

    const events = installEvents(received)
    expect(events.map((event) => event.phase)).toEqual(["download", "error"])
    expect(events[1]!.id).toBe("arm-gcc")
    expect(events[1]!.message).toContain("所有候选地址都连不上")
    expect(installedHooks).toBe(0)
  })

  it("取消:installer 认 signal 时终态事件是 cancelled,不是 error", async () => {
    const received: KernelEvent[] = []
    const registry = createInstallRegistry()
    const started = deferred<void>()
    const installer = (async (opts) => {
      started.resolve()
      await new Promise<void>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("install cancelled")), { once: true })
      })
      return fakeInstalled()
    }) satisfies typeof installToolchain

    const running = toolchainInstall({
      ...baseOpts(),
      id: "arm-gcc",
      emit: (events) => received.push(...events),
      registry,
      installer,
    })
    await started.promise
    expect(registry.cancel("arm-gcc")).toBe(true)
    await expect(running).rejects.toThrow(/cancelled/)

    const events = installEvents(received)
    expect(events.at(-1)?.phase).toBe("cancelled")
    expect(events.some((event) => event.phase === "error")).toBe(false)
  })

  it("onInstalled 在返回之前被 await(装完的 PATH 刷新不能落在结果之后)", async () => {
    const order: string[] = []
    const installer = (async () => {
      order.push("install")
      return fakeInstalled()
    }) satisfies typeof installToolchain

    await toolchainInstall({
      ...baseOpts(),
      id: "arm-gcc",
      emit: () => {},
      registry: createInstallRegistry(),
      installer,
      onInstalled: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push("refresh")
      },
    })
    order.push("returned")

    expect(order).toEqual(["install", "refresh", "returned"])
  })
})

describe("host.handle(toolchain.installCancel)", () => {
  it("没有在装的 id 也照常 resolve —— UI 的取消按钮可能晚于安装自己结束", async () => {
    const events: KernelEvent[] = []
    const host = createKernelHost({
      sessionsRoot: tempDir("yoma-tc-install-sessions-"),
      stateDir: tempDir("yoma-tc-install-state-"),
      configDir,
      version: "test",
      onEvents: (batch) => events.push(...batch),
    })
    try {
      await expect(host.handle("toolchain.installCancel", { id: "nope" })).resolves.toBeUndefined()
    } finally {
      await host.dispose()
    }
  })
})
