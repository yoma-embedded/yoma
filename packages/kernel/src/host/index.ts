/**
 * 内核宿主(Node 侧)。跑在 Electron 的 utilityProcess 里,不在 main、也不在 renderer。
 *
 * 进程模型是刻意的单例:my-pi 的 probe 租约(claimProbe/releaseProbe)、gdb session 表、
 * log capture 都是 **模块级全局**(coding-agent/src/core/tools/engines.ts:63-113),
 * 所以整个 app 只能有一个内核进程 —— 绝不按窗口或按目录分片 fork。
 */

import path from "node:path"

import { AgentHarness } from "@yoma/my-pi"
import { NodeExecutionEnv } from "@yoma/my-pi/node"
import { createCodingToolDefinitions } from "@yoma/my-pi-coding-agent"

import type { KernelEvent, KernelHandlers, KernelMethod, KernelParams, KernelResult } from "../protocol.ts"
import { createEmbeddedTools, SessionManager, type SessionManagerOptions } from "./session-manager.ts"
import { ProjectStore, listFiles, readFile, searchFiles, vcsDiff, vcsInfo } from "./services.ts"
import { StreamSink } from "./stream.ts"

// 纯类型模块,无运行时产物。re-export 只为把工具 details 的漂移闸门拉进编译单元。
export type * from "./details-check.ts"

export { SessionProjection } from "./projector.ts"
export { SessionManager } from "./session-manager.ts"
export { StreamSink } from "./stream.ts"
// 全局配置目录的真源(凭据/技能/上下文)。导出它是为了让 bench 的 paths.ts 副本
// 有个可断言的对手 —— 那份副本必须是叶子模块,不能反过来 import 这里。
export { myPiConfigDir } from "./auth.ts"

export interface KernelHostOptions {
  /** engines/bin + engines/data 的所在目录。生产环境是 process.resourcesPath/engines。 */
  enginesDir?: string
  /** session JSONL 的根目录,通常是 Electron 的 userData/sessions。 */
  sessionsRoot: string
  /** 存放 projects.json 的目录。 */
  stateDir: string
  version?: string
  /** 技能与上下文文件的全局目录,默认 `~/.my-pi`(与 my-pi 的 ACP 适配器同一份)。 */
  configDir?: string
  /** 模型目录的来源。默认复用 my-pi 的 resolveModel();测试注入 faux provider。 */
  resolveModels?: SessionManagerOptions["resolveModels"]
  /** 成批推事件出去。host 已经做过合并,这里拿到的就是最终批次。 */
  onEvents(events: KernelEvent[]): void
}

export interface KernelHost {
  handle<M extends KernelMethod>(method: M, params: KernelParams<M>): Promise<KernelResult<M>>
  /** renderer 重连:重推未决权限请求,否则关掉窗口再开就是一个永久卡住的会话。 */
  resync(): void
  dispose(): Promise<void>
}

export function createKernelHost(options: KernelHostOptions): KernelHost {
  const sink = new StreamSink({ flush: options.onEvents })
  const sessions = new SessionManager({
    sessionsRoot: options.sessionsRoot,
    enginesDir: options.enginesDir,
    configDir: options.configDir,
    resolveModels: options.resolveModels,
    emit: (events) => sink.push(events),
  })
  const projects = new ProjectStore(path.join(options.stateDir, "projects.json"))
  void projects.load()

  const handlers = {
    "app.info": async () => ({
      version: options.version ?? "0.0.0",
      enginesDir: options.enginesDir ?? null,
      sessionsRoot: options.sessionsRoot,
      node: process.versions.node,
    }),

    "session.list": ({ directory }) => sessions.list(directory),
    "session.get": ({ sessionID }) => sessions.get(sessionID),
    "session.create": ({ directory, title }) => sessions.create(directory, title),
    "session.delete": ({ sessionID }) => sessions.delete(sessionID),
    "session.rename": ({ sessionID, title }) => sessions.rename(sessionID, title),
    "session.status": ({ sessionID }) => sessions.status(sessionID),
    "session.messages": async ({ sessionID }) => sessions.messages(sessionID),
    "session.prompt": ({ sessionID, input }) => sessions.prompt(sessionID, input),
    "session.abort": ({ sessionID }) => sessions.abort(sessionID),
    "session.compact": ({ sessionID }) => sessions.compact(sessionID),
    "session.navigate": ({ sessionID, messageID }) => sessions.navigate(sessionID, messageID),
    "session.setModel": ({ sessionID, providerID, modelID, thinking }) =>
      sessions.setModel(sessionID, providerID, modelID, thinking),


    "model.list": () => sessions.providers(),
    // 凭据落在 my-pi 读的那份 ~/.pi/agent/auth.json —— 应用内配的 key 和命令行配 pi /
    // 配 Zed 的是同一份,互相可见。见 host/auth.ts。
    "auth.set": ({ providerID, apiKey }) => sessions.setAuth(providerID, apiKey),
    "auth.remove": ({ providerID }) => sessions.removeAuth(providerID),

    "file.list": ({ directory, path: relative }) => listFiles(directory, relative),
    "file.read": ({ path: file }) => readFile(file),
    "file.search": ({ directory, query, limit }) => searchFiles(directory, query, limit),

    "vcs.info": ({ directory }) => vcsInfo(directory),
    "vcs.diff": ({ directory }) => vcsDiff(directory),

    "project.list": async () => projects.list(),
    "project.add": ({ directory }) => projects.add(directory),
    "project.remove": ({ directory }) => projects.remove(directory),
    // `satisfies` 是这里的重点:协议加了方法而 host 没实现,是编译错误,不是运行时 404。
  } satisfies KernelHandlers

  return {
    async handle(method, params) {
      const handler = handlers[method] as (p: unknown) => Promise<unknown>
      if (!handler) throw new Error(`未知方法 ${method}`)
      return (await handler(params)) as never
    },
    // 窗口 reload 与"start 晚于 attach"两条路都靠它重新宣告一次 connected ——
    // 不重发的表现不是报错,是"点什么都没反应"。
    resync() {
      sink.push([{ type: "kernel.connected", version: options.version ?? "0.0.0" }])
      sink.flushNow()
    },
    async dispose() {
      sink.close()
      await sessions.disposeAll()
    },
  }
}

/** 冒烟自检:确认整个 my-pi 依赖图在当前 runtime 下真的加载得起来。 */
export function kernelSelfCheck(options: { enginesDir?: string } = {}) {
  const env = new NodeExecutionEnv({ cwd: process.cwd() })
  const coding = createCodingToolDefinitions(env)
  const embedded = createEmbeddedTools(env, options.enginesDir)
  return {
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    harness: typeof AgentHarness,
    tools: [...coding, ...embedded].map((t) => t.name),
  }
}
