/**
 * 设置页"工具链"标签的后端:项目核账 `toolchain.status` / `toolchain.set` 两个 RPC,
 * 加上机器级(按芯片平台)的 `toolchain.families` / `familyStatus` / `familySet` 三个。
 *
 * 全部逻辑(七档探测、验证、写账本)都在 coding-agent 的 toolchain 子系统里,这里
 * 只是"参数 → 调用 → 折叠成浏览器安全的视图"这一层胶水 —— 与 agent 工具
 * (coding-agent 的 tools/toolchain.ts)共用同一组动作实现(resolveToolchain /
 * rememberFreshResults / recordToolchainPath),UI 和 agent 两个入口的行为因此不可能
 * 分叉:同一套探测顺序、同一套拒绝理由、同一份账本形态。
 *
 * 错误处理与会话开启(session-manager 的 resolveToolchainSafe)刻意不同:那边"清单
 * 坏了"必须吞掉继续开会话(会话开不起来比工具链没配好严重得多),这里把解析错误放进
 * 结果的 error 字段 —— 设置页正是排查清单的地方,错误就是用户要看的答案本身。
 * set 的路径验证失败则直接 reject:那是用户刚敲进输入框的东西,拒绝理由要原地报。
 */
import {
  catalogPackageFor,
  declaredToolBins,
  familyManifestText,
  findToolchainFamily,
  installToolchain,
  readLedger,
  recordToolchainPath,
  rememberFreshResults,
  resolveToolchain,
  TOOLCHAIN_FAMILIES,
  type InstallProgress,
} from "@yoma/coding-agent"

import type { KernelEvent } from "../protocol.ts"
import type { ToolchainFamiliesView, ToolchainInstallResultView, ToolchainStatusView } from "../types.ts"

export interface ToolchainRpcOptions {
  directory: string
  configDir: string
  side: "mother" | "runner"
  /** 测试注入:隔离这台机器真实的 PATH / 平台(不注入的话断言看开发机脸色)。生产不传。 */
  probe?: { platform?: string; env?: NodeJS.ProcessEnv }
}

export async function toolchainStatus(opts: ToolchainRpcOptions & { fresh?: boolean }): Promise<ToolchainStatusView> {
  try {
    const resolution = await resolveToolchain({
      projectDir: opts.directory,
      configDir: opts.configDir,
      side: opts.side,
      // fresh 的语义与 agent 工具的 resolve 动作一致:不信账本重新探一遍,再把新答案记住。
      skipLedger: opts.fresh,
      platform: opts.probe?.platform,
      env: opts.probe?.env,
    })
    if (opts.fresh) await rememberFreshResults(resolution, opts.configDir)
    return {
      declared: resolution.manifest !== undefined,
      manifestPath: resolution.manifestPath,
      side: resolution.side,
      ok: resolution.ok,
      tools: resolution.tools,
    }
  } catch (error) {
    return { declared: false, side: opts.side, ok: false, tools: [], error: (error as Error)?.message ?? String(error) }
  }
}

export async function toolchainSet(opts: ToolchainRpcOptions & { id: string; path: string }): Promise<ToolchainStatusView> {
  // bins 让"贴整个安装目录"的输入直接可用(在目录及其 bin/ 里解析声明的可执行名);
  // 清单读不出来就退化为原样记录 —— 查询本身尽力而为,见 declaredToolBins。
  const bins = await declaredToolBins({ id: opts.id, projectDir: opts.directory })
  await recordToolchainPath({ id: opts.id, path: opts.path, configDir: opts.configDir, bins })
  // 记完再核一遍账:UI 拿到的是落账后的真实状态,而不是"大概成功了"。注意 local
  // 覆盖(toolchain.local.json)仍然压过刚写的账本条目 —— 那是解析顺序的既有语义,
  // 结果里的 source 字段会如实说明是谁赢了。
  return toolchainStatus(opts)
}

// ─── 机器级(按芯片平台)────────────────────────────────────────────────────────
//
// 与上面项目核账的差别只有清单从哪来:平台预设(coding-agent 的 families.ts)经
// manifestText 注入,不需要打开任何工程 —— 设置页「本机工具链」面板从主页也能用。
// 探测、验证、账本与项目路径完全同一套实现,预设的 pathKind 决定手填的验证档。

export interface ToolchainFamilyRpcOptions {
  configDir: string
  side: "mother" | "runner"
  /** 同 ToolchainRpcOptions.probe:测试注入,生产不传。 */
  probe?: { platform?: string; env?: NodeJS.ProcessEnv }
}

/** 轻调用:预设目录 + 账本里已记录的 id。不探测 —— 首跑提醒每次启动都要问它。 */
export async function toolchainFamilies(opts: { configDir: string }): Promise<ToolchainFamiliesView> {
  const ledger = await readLedger(opts.configDir)
  return {
    families: TOOLCHAIN_FAMILIES.map((family) => ({
      id: family.id,
      name: family.name,
      tools: family.tools.map((tool) => ({
        id: tool.id,
        title: tool.title,
        optional: tool.optional ?? false,
        pathKind: tool.pathKind,
      })),
    })),
    recordedIds: Object.keys(ledger.entries),
  }
}

export async function toolchainFamilyStatus(
  opts: ToolchainFamilyRpcOptions & { family: string; fresh?: boolean },
): Promise<ToolchainStatusView> {
  const family = findToolchainFamily(opts.family)
  // 未知平台是调用方代码写错(UI 只会传目录里有的 id),直接 reject 而不是折叠成
  // error 视图 —— 折叠是留给"用户的清单坏了"这种用户能修的事的。
  if (!family) throw new Error(`未知芯片平台 "${opts.family}"`)
  try {
    const resolution = await resolveToolchain({
      // projectDir 指到 configDir:机器级核账刻意不掺任何项目的 toolchain.local.json
      // 覆盖(configDir 下不会有 .yoma/ 子目录的项目布局),结果只由账本/环境/已知
      // 安装位置决定 —— 同一台机器在哪个工程里打开设置页,这一栏都说同一句话。
      projectDir: opts.configDir,
      configDir: opts.configDir,
      side: opts.side,
      skipLedger: opts.fresh,
      platform: opts.probe?.platform,
      env: opts.probe?.env,
      manifestText: familyManifestText(family),
    })
    if (opts.fresh) await rememberFreshResults(resolution, opts.configDir)
    return { declared: true, manifestPath: undefined, side: resolution.side, ok: resolution.ok, tools: resolution.tools }
  } catch (error) {
    // 预设清单坏了理论上被 coding-agent 的 families 测试拦在合并前;真到这儿就如实
    // 摆出来,和项目清单坏了同一个排查面。
    return { declared: true, side: opts.side, ok: false, tools: [], error: (error as Error)?.message ?? String(error) }
  }
}

export async function toolchainFamilySet(
  opts: ToolchainFamilyRpcOptions & { family: string; id: string; path: string },
): Promise<ToolchainStatusView> {
  const family = findToolchainFamily(opts.family)
  if (!family) throw new Error(`未知芯片平台 "${opts.family}"`)
  const tool = family.tools.find((entry) => entry.id === opts.id)
  if (!tool) throw new Error(`平台 ${family.name} 的预设里没有工具 "${opts.id}"`)
  // dir 型(STM32CubeMX 安装目录 / ESP-IDF 根目录 / Zephyr SDK)只验存在、原样记录
  // 目录本身,不传 bins —— 它们的可执行文件(如果有)埋在更深的子目录里,解析注定
  // 落空,而"根目录在哪"正是要记的答案。exe 型传预设声明的可执行名,贴目录时在
  // 里面解析;版本探得到就记,探不到留空(不再是闸门)。
  await recordToolchainPath({
    id: opts.id,
    path: opts.path,
    configDir: opts.configDir,
    probe: tool.pathKind === "dir" ? "exists" : "version",
    bins: tool.pathKind === "dir" ? undefined : tool.bin,
  })
  return toolchainFamilyStatus(opts)
}

// ─── 自动安装 ────────────────────────────────────────────────────────────────
//
// 下载 / 校验 / 解压 / 记账全在 coding-agent 的 toolchain/install.ts(与 agent 工具的
// install 动作同一份实现);这里只做三件事:一个 id 同时只允许一个安装(注册表 +
// AbortController)、把进度回调翻译成 `toolchain.install` 事件、装完把机器级核账一并
// 回给 UI。

export interface InstallRegistry {
  /**
   * 同一个 key 已在装 ⇒ reject(message 含 "already");否则登记并跑到结束(成功失败都注销)。
   * key 是包 id(arm-gcc 与 arm-gdb 同一个包,不该一个在装另一个还能点);label 是给 UI 看的
   * 工具 id,active() 返回的是它。
   */
  start<T>(key: string, run: (signal: AbortSignal) => Promise<T>, label?: string): Promise<T>
  /** 有在装的就 abort 并返回 true;没有返回 false。 */
  cancel(key: string): boolean
  /** 在装的工具 id(label)。 */
  active(): string[]
}

export function createInstallRegistry(): InstallRegistry {
  const inflight = new Map<string, { controller: AbortController; label: string }>()
  return {
    async start(key, run, label = key) {
      const current = inflight.get(key)
      if (current) throw new Error(`${current.label} is already installing — wait for it or cancel it first`)
      const controller = new AbortController()
      const record = { controller, label }
      inflight.set(key, record)
      try {
        return await run(controller.signal)
      } finally {
        if (inflight.get(key) === record) inflight.delete(key)
      }
    },
    cancel(keyOrLabel) {
      // 键(包 id)或标签(工具 id)都认:UI 手里只有工具 id。
      const record =
        inflight.get(keyOrLabel) ?? [...inflight.values()].find((candidate) => candidate.label === keyOrLabel)
      if (!record) return false
      record.controller.abort()
      return true
    },
    active() {
      return [...inflight.values()].map((record) => record.label)
    },
  }
}

/** 注册表的键:工具所属的包 id(目录里没有的工具就用它自己的 id)。 */
export function installKey(toolId: string): string {
  return catalogPackageFor(toolId)?.id ?? toolId
}

export function installProgressEvent(progress: InstallProgress): KernelEvent {
  return {
    type: "toolchain.install",
    id: progress.toolId,
    packageId: progress.packageId,
    version: progress.version,
    phase: progress.phase,
    bytes: progress.bytes,
    total: progress.total,
    message: progress.message,
  }
}

/** 工具 id 所在的第一个预设平台的机器级核账;不在任何预设里(只在项目清单里)时给一份空的 declared:true。 */
async function statusAfterInstall(opts: ToolchainFamilyRpcOptions & { id: string }): Promise<ToolchainStatusView> {
  const family = TOOLCHAIN_FAMILIES.find((entry) => entry.tools.some((tool) => tool.id === opts.id))
  if (!family) return { declared: true, side: opts.side, ok: true, tools: [] }
  return toolchainFamilyStatus({ ...opts, family: family.id })
}

export async function toolchainInstall(
  opts: ToolchainFamilyRpcOptions & {
    id: string
    emit: (events: KernelEvent[]) => void
    registry: InstallRegistry
    /** 测试注入:替代真实的 installToolchain。 */
    installer?: typeof installToolchain
    /** 装成功后的钩子(session-manager 刷新在飞会话的 PATH)。 */
    onInstalled?: () => Promise<void> | void
  },
): Promise<ToolchainInstallResultView> {
  const installer = opts.installer ?? installToolchain
  // onInstalled(刷新在飞会话的 PATH)与装完的核账都在注册表持有这个包期间做完:
  // 否则第二次 install 同一个包可以在 refreshMachineEnv 还没跑完时就开跑。
  return opts.registry.start(
    installKey(opts.id),
    async (signal) => {
      let installed: Awaited<ReturnType<typeof installer>>
      try {
        installed = await installer({
          toolId: opts.id,
          configDir: opts.configDir,
          signal,
          env: opts.probe?.env,
          onProgress: (progress) => opts.emit([installProgressEvent(progress)]),
        })
      } catch (error) {
        // 失败 / 取消也要有一条终态事件:UI 的进度行靠它收尾,不然停在最后一个百分比上。
        // installToolchain 自己在拿到包之后已经报过一条,这里的这条会把它折叠掉(同 id
        // 相邻),所以 packageId / version 从错误里带,别让最后存活的那条是空串。
        // 取消的判定优先听错误自己的 phase(ToolchainInstallError),其次看 signal。
        const info = error as { phase?: string; packageId?: string; version?: string }
        const cancelled = info?.phase === "cancelled" || signal.aborted
        const message = (error as Error)?.message ?? String(error)
        opts.emit([
          {
            type: "toolchain.install",
            id: opts.id,
            packageId: info?.packageId ?? "",
            version: info?.version ?? "",
            phase: cancelled ? "cancelled" : "error",
            message,
          },
        ])
        throw error
      }
      await opts.onInstalled?.()
      const status = await statusAfterInstall(opts)
      return {
        id: opts.id,
        packageId: installed.packageId,
        version: installed.version,
        dir: installed.dir,
        binDir: installed.binDir,
        reused: installed.reused,
        status,
      }
    },
    opts.id,
  )
}
