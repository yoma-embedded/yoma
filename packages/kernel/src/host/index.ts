/**
 * 内核宿主(Node 侧)。跑在 Electron 的 utilityProcess 里,不在 main、也不在 renderer。
 *
 * 进程模型是刻意的单例:会话的 JSONL 由**一个进程独占**(JsonlSessionRepo 对同一个
 * 会话开两次直接抛),所以整个 app 只能有一个内核进程 —— 绝不按窗口或按目录分片 fork。
 */

import path from "node:path"

import { AgentHarness } from "@earendil-works/pi-agent-core"

import type { KernelEvent, KernelHandlers, KernelMethod, KernelParams, KernelResult } from "../protocol.ts"
import { createAgentTools, SessionManager, type SessionManagerOptions } from "./session-manager.ts"
import { runPreflight, inspectEngines } from "./preflight.ts"
import { yomaConfigDir } from "./auth.ts"
import { laCaptures, laView } from "./la-view.ts"
import { ProjectStore, listFiles, readFile, searchFiles, vcsDiff, vcsInfo, vcsInit } from "./services.ts"
import { StreamSink } from "./stream.ts"
import {
  createInstallRegistry,
  installKey,
  toolchainFamilies,
  toolchainFamilySet,
  toolchainFamilyStatus,
  toolchainInstall,
  toolchainSet,
  toolchainStatus,
} from "./toolchain.ts"
import { VcsWatchers } from "./vcs-watch.ts"

export { SessionProjection } from "./projector.ts"
export { SessionManager } from "./session-manager.ts"
export { StreamSink } from "./stream.ts"
// 全局配置目录的真源(凭据/技能/上下文)。导出它是为了让 bench 的 paths.ts 副本
// 有个可断言的对手 —— 那份副本必须是叶子模块,不能反过来 import 这里。
export { yomaConfigDir } from "./auth.ts"
export { inspectEngines, runPreflight } from "./preflight.ts"

export interface KernelHostOptions {
  /** engines/bin + engines/data 的所在目录。生产环境是 process.resourcesPath/engines。 */
  enginesDir?: string
  /** session JSONL 的根目录,通常是 Electron 的 userData/sessions。 */
  sessionsRoot: string
  /** 存放 projects.json 的目录。 */
  stateDir: string
  version?: string
  /** 技能与上下文文件的全局目录,默认 `~/.yoma`(与 yoma 的 ACP 适配器同一份)。 */
  configDir?: string
  /** 模型目录的来源。默认复用 yoma 的 resolveModel();测试注入 faux provider。 */
  resolveModels?: SessionManagerOptions["resolveModels"]
  /** 凭据解析看哪个环境。测试接缝(传 NO_AMBIENT_AUTH 挡住开发机的真实 key);生产不传。 */
  authContext?: SessionManagerOptions["authContext"]
  /** 没人选档时的思考档位。不传则 `"off"`。桌面端和 bench 都传 `max`。 */
  defaultThinkingLevel?: SessionManagerOptions["defaultThinkingLevel"]
  /**
   * 工具链清单按哪一侧筛。不传即 `"mother"`(桌面端与信箱研发端)。
   * 信箱工位端传 `"runner"`。详见 SessionManagerOptions。
   */
  toolchainSide?: SessionManagerOptions["toolchainSide"]
  /**
   * 工具链清单原文。**只有工位端需要** —— 它没有项目检出,清单读不到,
   * 得经信箱送过来。详见 SessionManagerOptions。
   */
  toolchainManifestText?: SessionManagerOptions["toolchainManifestText"]
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
    authContext: options.authContext,
    defaultThinkingLevel: options.defaultThinkingLevel,
    toolchainSide: options.toolchainSide,
    toolchainManifestText: options.toolchainManifestText,
    emit: (events) => sink.push(events),
  })
  const projects = new ProjectStore(path.join(options.stateDir, "projects.json"))
  void projects.load()
  // 项目目录一有变化就推 vcs.updated,审查页据此重拉 —— VS Code 源代码管理视图"改完立刻刷新"的那半机制。
  const vcsWatchers = new VcsWatchers({
    emit: (directory, info) => sink.push([{ type: "vcs.updated", directory, info }]),
  })

  // 一个 id 同时只装一次;取消走这里的 AbortController。
  const installs = createInstallRegistry()

  const handlers = {
    "app.info": async () => ({
      version: options.version ?? "0.0.0",
      enginesDir: options.enginesDir ?? null,
      sessionsRoot: options.sessionsRoot,
      node: process.versions.node,
    }),
    "app.preflight": () =>
      runPreflight({
        sessions,
        configDir: options.configDir ?? yomaConfigDir(),
        enginesDir: options.enginesDir,
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
    // 凭据落在 yoma 读的那份 ~/.pi/agent/auth.json —— 应用内配的 key 和命令行配 pi /
    // 配 Zed 的是同一份,互相可见。见 host/auth.ts。
    "auth.set": ({ providerID, apiKey }) => sessions.setAuth(providerID, apiKey),
    "auth.remove": ({ providerID }) => sessions.removeAuth(providerID),

    "file.list": ({ directory, path: relative }) => listFiles(directory, relative),
    "file.read": ({ directory, path: file }) => readFile(directory, file),
    "la.view": (params) => laView(params),
    "la.captures": ({ directory }) => laCaptures(directory),
    "file.search": ({ directory, query, limit, directories }) => searchFiles(directory, query, limit, directories),

    // app 打开每个项目都会先问一次 vcs.info,是仓库就从这一刻起盯住它的目录。
    "vcs.info": async ({ directory }) => {
      const info = await vcsInfo(directory)
      if (info.root) vcsWatchers.ensure(directory)
      return info
    },
    // 审查页拿着自己那份目录字符串来拉 diff:在这里也登记一次,保证它这种写法一定收得到事件
    // (bootstrap 那次 vcs.info 可能是别的组件用另一种写法调的)。不是仓库的目录,监视器会自己退场。
    "vcs.diff": ({ directory }) => {
      vcsWatchers.ensure(directory)
      return vcsDiff(directory)
    },
    "vcs.init": async ({ directory }) => {
      const info = await vcsInit(directory)
      if (info.root) vcsWatchers.ensure(directory)
      return info
    },

    // side 与会话同源(桌面端不传即 mother):设置页核的账必须和系统提示词里那份
    // 一致,两边一边 mother 一边 runner 的话,UI 打的勾对不上 agent 看到的 MISSING。
    "toolchain.status": ({ directory, fresh }) =>
      toolchainStatus({
        directory,
        fresh,
        configDir: options.configDir ?? yomaConfigDir(),
        side: options.toolchainSide ?? "mother",
      }),
    "toolchain.set": ({ directory, id, path: binPath }) =>
      toolchainSet({
        directory,
        id,
        path: binPath,
        configDir: options.configDir ?? yomaConfigDir(),
        side: options.toolchainSide ?? "mother",
      }),
    "toolchain.families": () => toolchainFamilies({ configDir: options.configDir ?? yomaConfigDir() }),
    "toolchain.familyStatus": ({ family, fresh }) =>
      toolchainFamilyStatus({
        family,
        fresh,
        configDir: options.configDir ?? yomaConfigDir(),
        side: options.toolchainSide ?? "mother",
      }),
    "toolchain.familySet": ({ family, id, path: binPath }) =>
      toolchainFamilySet({
        family,
        id,
        path: binPath,
        configDir: options.configDir ?? yomaConfigDir(),
        side: options.toolchainSide ?? "mother",
      }),
    "toolchain.install": ({ id }) =>
      toolchainInstall({
        id,
        configDir: options.configDir ?? yomaConfigDir(),
        side: options.toolchainSide ?? "mother",
        emit: (events) => sink.push(events),
        registry: installs,
        // 装完立刻让在飞会话的 bash 与内核进程自己的 PATH 都看见新目录。
        onInstalled: () => sessions.refreshMachineEnv(),
      }),
    "toolchain.installCancel": ({ id }) => {
      installs.cancel(installKey(id))
    },
    "toolchain.installsActive": async () => installs.active(),

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
      vcsWatchers.dispose()
      // 先关 sink:disposeAll 会中断在飞轮次,那一串收尾事件是故意丢掉的 ——
      // 进程正在退,renderer 的通道也在拆,推过去没人收。
      sink.close()
      await sessions.disposeAll()
    },
  }
}

/** 冒烟自检:依赖图能加载,工具装配得出来,engines 二进制真的在。 */
export function kernelSelfCheck(options: { enginesDir?: string } = {}) {
  const engines = inspectEngines(options.enginesDir)
  return {
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    // 整个内核依赖图真的加载起来了才有这个 "function"(AgentHarness 本身只是个对象)。
    harness: typeof AgentHarness.create,
    tools: createAgentTools().map((tool) => tool.name),
    engines,
  }
}
