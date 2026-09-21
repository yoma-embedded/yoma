/**
 * toolchain 工具的厨房那一半:四个动作 → domain/toolchain 的调用 → 人话。
 *
 * 与别的工具不同,这里**不 spawn engines/ 下的任何东西**:七档探测、版本探针、账本、下载解压全在
 * host/domain/toolchain 子系统里,而那套实现同时被设置页的 RPC(host/toolchain.ts)用着。两个入口共用
 * 同一份动作实现是有意的 —— UI 里填的路径和 agent 问出来记的路径必须落成同一种账本条目、被同一套
 * 规则拒绝,否则同一台机器上"设置页说好了、agent 说没有"这种自相矛盾没人查得清。
 *
 * 【为什么没有 log 那样的串行队列】发动机的 AgentHarness 不读工具上的 `executionMode`,同一批调用是
 * 并行的,所以有状态的工具得自己排队(log 就排了)。这里不用:
 * - 账本的读—改—写已经在 domain/toolchain/ledger.ts 自己身上排了队 —— 必须在那儿排,因为设置页那条
 *   调用路径根本不经过这个文件,工具自己排队拦不住它。
 * - 同一个包同时只装一路由安装注册表挡着(第二次 reject),而那把锁同样是两个入口共用的。
 * - check / resolve 是只读探测,并行跑至多是多花几次 `--version` 子进程。
 *   而 install 要几分钟:真串起来的话,装 arm-gcc 期间一句 check 都要等几分钟才回,那才是坏体验。
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"
import { executionEnvSnapshot } from "../../domain/execution-env.ts"

import {
  catalogPackageFor,
  declaredToolSpec,
  directoryDetail,
  installKey,
  installToolchain,
  isSettled,
  presetToolIds,
  recordToolchainPath,
  rememberFreshResults,
  resolveToolchain,
  satisfies,
  surveyManifestText,
  type InstallProgress,
  type InstallRegistry,
  type ResolvedTool,
  type ToolchainResolution,
} from "../../domain/toolchain/index.ts"
import {
  MANIFEST_FORMAT_HELP,
  MANIFEST_PATH,
  TOOLCHAIN_CONTRACT,
  type ToolchainAction,
  type ToolchainDetails,
  type ToolchainInput,
} from "./contract.ts"

export interface ToolchainToolOptions {
  /** 账本目录,默认 ~/.yoma(domain/toolchain/ledger.ts 的默认)。测试必须注入。 */
  configDir?: string
  /** 清单按哪一侧筛。默认 "mother";信箱工位端注入 "runner"。 */
  side?: "mother" | "runner"
  /**
   * 清单原文,绕开"从 cwd 读 .yoma/toolchain.json"。**工位端必须注入**:它没有项目检出,清单是经信箱
   * 送来的 —— 不注入的话系统提示词里是 runner 筛过的清单,而 agent 自己跑 check 却报"没有清单",
   * 两边自相矛盾(2026-08 实测踩过)。
   */
  manifestText?: string
  /** 默认 process.platform / process.env;测试用它隔离开发机真实的 PATH 与平台分支。 */
  platform?: string
  env?: NodeJS.ProcessEnv
  /** install 的进度旁路:宿主翻成 `toolchain.install` 事件,于是 agent 装的和用户点着装的在 UI 上长得一样。 */
  onInstallProgress?: (progress: InstallProgress) => void
  /**
   * install 成功后的钩子:宿主(SessionManager)在这里把新目录灌进在飞会话的 PATH 与内核进程自己的
   * PATH。**不传的宿主拿不到"装完立刻可用"** —— 结果文案会如实说,让模型改用绝对路径。
   */
  onInstalled?: () => Promise<void> | void
  /**
   * 与设置页共用的安装注册表:同一个包同时只许装一路。不传就退化成"谁都能同时装"——
   * 两路往同一棵目录树里解压,失败长得像下载损坏。
   */
  installRegistry?: InstallRegistry
  /** 测试注入:替代真实的 installToolchain(它会真的联网下载几百 MB)。 */
  installer?: typeof installToolchain
  /**
   * 测试注入:项目没有清单时拿来普查机器的那份虚拟清单,缺省是全部预设工具(families.ts 的
   * surveyManifestText)。真的那份会去碰开发机的已知安装位置与注册表,断言就看跑测试的机器的脸色了。
   */
  surveyManifestText?: string
}

// ─── 渲染:ResolvedTool → 人话一行 ────────────────────────────────────────────

/**
 * 目录里有这台机器能装的包时,在 MISSING / VERSION MISMATCH 行尾告诉模型可以自助安装 ——
 * 钉的版本满足不了清单要求时反过来明说"装了也不够",免得模型在装 → 核 → 再装里空转。
 */
function installableNote(tool: ResolvedTool): string {
  const pkg = tool.installable
  if (!pkg) return ""
  if (tool.wanted !== undefined && !satisfies(pkg.version, tool.wanted)) {
    return `; Yoma could install ${pkg.title} ${pkg.version} but it does NOT satisfy ${tool.wanted} — don't install it, tell the user`
  }
  // 一个包可能满足好几个工具(Arm 那个包同时给 arm-gcc 和 arm-gdb)。两条 MISSING 行各喊各的 id,
  // 模型就会在同一批里发两次 install,而注册表按**包**去重 —— 第二次必然收到 already installing,
  // 而这正是最常见的那条路。所以两行都指向同一个 id,并把"这一次装覆盖了谁"说清楚。
  const provides = catalogPackageFor(tool.id)?.provides ?? [tool.id]
  const id = provides[0] ?? tool.id
  const covers = provides.length > 1 ? ` — one install covers ${provides.join(", ")}` : ""
  return `; installable: ${pkg.title} ${pkg.version} (~${Math.round(pkg.bytes / 1e6)} MB)${covers}; run toolchain install id="${id}"`
}

export function renderToolLine(tool: ResolvedTool): string {
  const label = tool.optional ? `${tool.id} (optional)` : tool.id
  const need = tool.wanted ? ` (needs ${tool.wanted})` : ""
  switch (tool.status) {
    case "configured":
      // 终态:目录资源不跑 --version,到不了 OK。话要说成"就是它、照着用",不是"还差一步"。
      return `- ${label}: CONFIGURED — ${directoryDetail(tool)}; a directory, not a program — not on PATH, nothing was executed to check it`
    case "recorded": {
      const where = (tool.candidates ?? Object.values(tool.bin)).join(", ")
      // dir 型 + 声明了标志文件:点名缺哪个文件,模型才知道该换哪个目录,而不是原地重试。
      if (tool.checks?.execution === "not-applicable" && tool.missingBins?.length) {
        return `- ${label}: RECORDED — ${where}; that directory does not contain ${tool.missingBins.join(", ")}, so it is not this tool's install directory — set the directory that does`
      }
      return `- ${label}: RECORDED — ${where}; no declared executable entry located`
    }
    case "unverified":
      return `- ${label}: UNVERIFIED${need} — ${Object.values(tool.bin).join(", ")}; ${tool.missingBins?.length ? `missing required entries: ${tool.missingBins.join(", ")}` : "execution/version probe did not pass; the explicit entry remains available, readiness is not confirmed"}`
    case "ok": {
      const primary = Object.values(tool.bin)[0] ?? "(unknown path)"
      return `- ${label}: OK${need} — ${primary}, version ${tool.version ?? "unknown"}, via ${tool.source ?? "unknown"}`
    }
    case "missing": {
      const advice = tool.hint
        ? `install hint: ${tool.hint}`
        : "no install hint for this platform — ask the user how it's normally installed here"
      return `- ${label}: MISSING${need} — ${advice}${installableNote(tool)}`
    }
    case "version-mismatch": {
      const at = tool.candidates?.[0]
      const found = tool.version ? `found ${tool.version}${at ? ` at ${at}` : ""}` : "found an unrecognized version"
      const advice = tool.hint ? `; upgrade hint: ${tool.hint}` : ""
      return `- ${label}: VERSION MISMATCH${need} — ${found}${advice}${installableNote(tool)}`
    }
    case "ambiguous": {
      const list = (tool.candidates ?? []).join(", ") || "(no candidates recorded)"
      return `- ${label}: AMBIGUOUS${need} — multiple installs with inconsistent versions: ${list}. Ask the user which one to use, don't guess.`
    }
  }
}

function toolSummaries(resolution: ToolchainResolution): ToolchainDetails["tools"] {
  return resolution.tools.map((tool) => ({ id: tool.id, status: tool.status, optional: tool.optional }))
}

/**
 * 项目没有清单时的回复:**这台机器上有什么** + 清单怎么写。
 *
 * 从前这里只有一句"没有清单",关于机器一个字不说 —— 而绝大多数项目没有清单,空工程刚开局尤其。
 * 2026-09-18 的会话:模型照守则先跑 check,得到那一句,只好 `command -v idf.py`,而 IDF 不在 PATH 上,
 * 于是断言"这台机器上没有任何 ESP32 工具链"并开始 pip 装 esptool;IDF 就装在 D 盘。工具链是电脑的
 * 属性(families.ts 的文件头),设置页按电脑查、查得到,agent 这个入口却被项目文件挡在门外。
 *
 * 只列找到的,没找到的折成一行:二十个 MISSING 连同各自的安装提示会把真正有用的那几行淹掉。
 * 普查里的工具一律 optional(没有"必须有"),渲染时把这个标记摘掉,否则每行都拖着 "(optional)"。
 */
function renderSurvey(
  survey: ToolchainResolution,
  action: ToolchainAction,
): { text: string; details: ToolchainDetails } {
  const found = survey.tools.filter((tool) => tool.status !== "missing")
  const missing = survey.tools.filter((tool) => tool.status === "missing")
  const installable = missing.filter((tool) => tool.installable).map((tool) => tool.id)
  const freshNote = action === "resolve" ? " — freshly probed, saved for later sessions on this machine" : ""
  const machine = [
    `Tools Yoma knows about, as found on this machine${freshNote} (ledger, environment variables, vendor installer records, PATH, usual install locations):`,
    found.length > 0
      ? found.map((tool) => renderToolLine({ ...tool, optional: false })).join("\n")
      : "(none of the known tools were found)",
  ]
  if (missing.length > 0) machine.push(`Not found here: ${missing.map((tool) => tool.id).join(", ")}.`)
  if (installable.length > 0) {
    machine.push(`Yoma can install these itself when one is needed (toolchain install): ${installable.join(", ")}.`)
  }
  machine.push(
    "If something the user says is installed is not listed, ask where it is and record it with set — do not go searching the disks.",
  )
  const text = [
    `No toolchain manifest found (expected ${MANIFEST_PATH}) — this project hasn't declared its host tools yet.`,
    "",
    ...machine,
    "",
    "Want a manifest so every later session (and any other machine) checks the same list? Offer to draft one from the build files — ask the user first, never generate it unprompted.",
    MANIFEST_FORMAT_HELP,
    `Known ids: ${presetToolIds().join(", ")}.`,
  ].join("\n")
  return {
    text,
    details: { action, ok: true, declared: false, side: survey.side, tools: toolSummaries({ ...survey, tools: found }) },
  }
}

function renderResolution(
  resolution: ToolchainResolution,
  action: ToolchainAction,
): { text: string; details: ToolchainDetails } {
  const freshNote = action === "resolve" ? " — freshly probed, saved for later sessions on this machine" : ""
  const header = `Toolchain requirements from ${resolution.manifestPath ?? MANIFEST_PATH} (side: ${resolution.side})${freshNote}:`
  const body =
    resolution.tools.length > 0
      ? resolution.tools.map(renderToolLine).join("\n")
      : `(no tools declared for side "${resolution.side}")`
  const attention = resolution.needsAttention.filter((tool) => !tool.optional)
  const summary =
    attention.length > 0
      ? `Required tools needing attention: ${attention.map((tool) => tool.id).join(", ")}.`
      : "All required tools resolved."
  return {
    text: [header, body, summary].join("\n"),
    details: { action, ok: resolution.ok, declared: true, side: resolution.side, tools: toolSummaries(resolution) },
  }
}

/** 下载进度那一行(卡片上边跑边变的活行)。纯函数,测试直接喂进度对象。 */
export function installProgressLine(progress: InstallProgress): string {
  const head = `${progress.toolId}: ${progress.phase}`
  if (progress.phase === "download" && progress.total && progress.total > 0) {
    const pct = Math.min(100, Math.round(((progress.bytes ?? 0) / progress.total) * 100))
    const mb = (bytes: number) => (bytes / 1e6).toFixed(1)
    return `${head} ${pct}% (${mb(progress.bytes ?? 0)}/${mb(progress.total)} MB)`
  }
  return progress.message ? `${head} — ${progress.message}` : head
}

// ─── 工厂 ────────────────────────────────────────────────────────────────────

export function createToolchainTool(
  options: ToolchainToolOptions = {},
): AgentHarnessTool<ExecutionToolContext, typeof TOOLCHAIN_CONTRACT.parameters, ToolchainDetails> {
  return {
    name: TOOLCHAIN_CONTRACT.name,
    label: TOOLCHAIN_CONTRACT.label,
    description: TOOLCHAIN_CONTRACT.description,
    parameters: TOOLCHAIN_CONTRACT.parameters,
    // replay 不声明(默认 never):install 有副作用(下载、解压、改 PATH),崩溃恢复不该自动重跑。
    execute: async (_toolCallId, params, onUpdate, toolContext, _invocation, context) => {
      const cwd = toolContext.env.cwd
      const invocationOptions = { ...options, env: options.env ?? executionEnvSnapshot(toolContext.env) }
      const action = params.action
      if (action === "set") return runSet(params, cwd, invocationOptions)
      if (action === "install") return runInstall(params, invocationOptions, onUpdate, context.abortSignal)

      const resolution = await resolveToolchain({
        projectDir: cwd,
        configDir: options.configDir,
        // resolve 的语义:不信旧记录重新探一遍(写回仍由 rememberFreshResults 做)。
        skipLedger: action === "resolve",
        side: options.side,
        platform: options.platform,
        env: invocationOptions.env,
        manifestText: options.manifestText,
      })
      // 没有清单:拿全部预设工具普查这台机器(见 renderSurvey)。只在工具调用里做,不进会话开启那条
      // 关键路径 —— 注册表那一档是同步的,装了很多软件的机器上要几百毫秒到一两秒。
      const survey = resolution.manifest
        ? undefined
        : await resolveToolchain({
            projectDir: cwd,
            configDir: options.configDir,
            skipLedger: action === "resolve",
            side: options.side,
            platform: options.platform,
            env: invocationOptions.env,
            manifestText: options.surveyManifestText ?? surveyManifestText(),
          })
      if (action === "resolve") {
        await rememberFreshResults(survey ?? resolution, options.configDir)
        await options.onInstalled?.()
      }
      const rendered = survey ? renderSurvey(survey, action) : renderResolution(resolution, action)
      return { content: [{ type: "text", text: rendered.text }], details: rendered.details }
    },
  }
}

/**
 * 参数校验留在工具层(缺参是模型没按 schema 来,话术要教它怎么补);路径验证与写账本在
 * domain/toolchain 的 recordToolchainPath —— 与设置页 RPC 同一套实现,两个入口的拒绝理由、账本形态
 * 因此不可能分叉。bins 从清单里查,让"用户报了个安装目录"这种最常见的回答直接可用,不逼模型先去
 * 目录里翻出 exe 再来调一次。
 */
async function runSet(
  params: ToolchainInput,
  cwd: string,
  options: ToolchainToolOptions,
): Promise<{ content: [{ type: "text"; text: string }]; details: ToolchainDetails }> {
  const id = params.id?.trim()
  if (!id) throw new Error('toolchain set requires "id" (the tool id from the manifest, e.g. "arm-gcc")')
  const given = params.path?.trim()
  if (!given) throw new Error('toolchain set requires "path" (the absolute path the user gave you)')

  // 清单条目并上预设;清单里没有这个 id(或压根没有清单)时就是预设本身 —— 模型常常先 set 后写清单。
  const spec = await declaredToolSpec({ id, projectDir: cwd, manifestText: options.manifestText })
  const recorded = await recordToolchainPath({ id, path: given, configDir: options.configDir, env: options.env, spec })
  await options.onInstalled?.()

  // 记完当场核这一个工具,把状态写进回复。从前只说"Recorded … finds it automatically",而那条路径
  // 核出来可能是 RECORDED(没落定)—— 模型拿到一句成功的话,要再跑一次 check 才发现没成,然后原地重试。
  // 单工具的临时清单:from 摘掉(它指向的 provider 不在这份清单里,过不了 parseManifest;预设会补回来),
  // side 钉 both(别被这一侧的筛选滤掉)。local 覆盖仍然压过账本,结果里的来源会如实说。
  const status = await resolveToolchain({
    projectDir: cwd,
    configDir: options.configDir,
    side: options.side,
    platform: options.platform,
    env: options.env,
    manifestText: JSON.stringify({ schema: "yoma/toolchain@1", tools: [{ ...spec, id, from: undefined, side: "both" }] }),
  }).then(
    (resolution) => resolution.tools[0],
    () => undefined,
  )
  const versionNote = recorded.version ? ` (version ${recorded.version})` : ""
  const head = `Recorded ${recorded.id} -> ${recorded.binPath}${versionNote}.`
  const text =
    status === undefined
      ? `${head} Every later session on this machine finds it automatically — no need to ask again.`
      : isSettled(status.status)
        ? `${head} Every later session on this machine finds it automatically — no need to ask again.\nStatus now:\n${renderToolLine(status)}`
        : `${head} The path is saved, but the tool is NOT ready yet:\n${renderToolLine(status)}`
  return { content: [{ type: "text", text }], details: { action: "set", ok: true, id } }
}

/**
 * 下载 / 校验 / 解压 / 记账全在 domain/toolchain/install.ts。失败原样抛(ToolchainInstallError 的 message
 * 已经是人话且带 phase),让 harness 摆给模型;不吞成"看起来成功了"。
 *
 * 两个信号都要听:用户在会话里按"停止"(context.abortSignal),以及用户在设置页点这个包的"取消"
 * (注册表的 AbortController)。少听一个的代价是几百 MB 接着下,而按钮已经没反应了。
 */
async function runInstall(
  params: ToolchainInput,
  options: ToolchainToolOptions,
  onUpdate: (update: { content: [{ type: "text"; text: string }]; details: ToolchainDetails }) => void,
  abortSignal: AbortSignal | undefined,
): Promise<{ content: [{ type: "text"; text: string }]; details: ToolchainDetails }> {
  const id = params.id?.trim()
  if (!id) throw new Error('toolchain install requires "id" (the tool id from toolchain check, e.g. "arm-gcc")')
  const install = options.installer ?? installToolchain
  const pending: ToolchainDetails = { action: "install", ok: false, id }

  let refreshed = false
  const run = async (signal: AbortSignal | undefined) => {
    let last: InstallProgress | undefined
    try {
      const result = await install({
        toolId: id,
        configDir: options.configDir,
        env: options.env,
        signal,
        onProgress: (progress) => {
          last = progress
          options.onInstallProgress?.(progress)
          onUpdate({ content: [{ type: "text", text: installProgressLine(progress) }], details: pending })
        },
      })
      // 刷 PATH 要在注册表**还攥着这个包**的时候做完(与设置页 RPC 同一条不变量,理由写在
      // host/toolchain.ts):它要为每个开着的会话重解析一遍清单、起一堆 --version 子进程,那几秒
      // 里若把锁放了,第二次装同一个包就能开跑。
      //
      // 而它失败**不能**把一次已经装好的安装变成工具错误:包解压好了、账本也记了,报错只会让模型
      // 再装一次。降级成"用绝对路径调"的说法 —— 那句话在任何情况下都是真的。
      if (options.onInstalled) {
        // try/catch 而不是 .then(…, …):钩子可能**同步**抛(Promise.resolve 包不住它,
        // 那一抛会直接窜到外层的 catch,于是一次装好的安装被报成失败)。
        try {
          await options.onInstalled()
          refreshed = true
        } catch {
          refreshed = false
        }
      }
      return result
    } catch (error) {
      // 失败 / 取消也要有一条终态进度:UI 的进度行靠它收尾,不然停在最后一个百分比上。
      // 取消的判定优先听错误自己的 phase(ToolchainInstallError),其次看信号。
      const info = error as { phase?: string; packageId?: string; version?: string }
      options.onInstallProgress?.({
        toolId: id,
        packageId: info?.packageId ?? last?.packageId ?? "",
        version: info?.version ?? last?.version ?? "",
        phase: info?.phase === "cancelled" || signal?.aborted ? "cancelled" : "error",
        message: (error as Error)?.message ?? String(error),
      })
      throw error
    }
  }

  const registry = options.installRegistry
  const installed = registry
    ? await registry.start(installKey(id), (registrySignal) => run(mergeSignals(abortSignal, registrySignal)), id)
    : await run(abortSignal)

  const recorded = installed.recorded.map(
    (entry) => `${entry.id} -> ${entry.binPath}${entry.version ? ` (version ${entry.version})` : ""}`,
  )
  const pathNote = refreshed
    ? "this directory is on PATH for your later commands in this session and for every later session on this machine."
    : "this directory is on PATH for every later session on this machine; in this session call the executables by the absolute paths above."
  const text = [
    `${installed.reused ? "Already installed" : "Installed"} ${installed.packageId} ${installed.version} at ${installed.dir}.`,
    `Executables: ${installed.binDir} — ${pathNote}`,
    recorded.length > 0 ? `Recorded: ${recorded.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n")
  return {
    content: [{ type: "text", text }],
    details: {
      action: "install",
      ok: true,
      id,
      installed: {
        packageId: installed.packageId,
        version: installed.version,
        dir: installed.dir,
        binDir: installed.binDir,
        reused: installed.reused,
      },
    },
  }
}

/** 两个中止信号合一;只有一个就原样用(AbortSignal.any 会新建一个,没必要多一层)。 */
function mergeSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a) return b
  if (!b) return a
  return AbortSignal.any([a, b])
}
