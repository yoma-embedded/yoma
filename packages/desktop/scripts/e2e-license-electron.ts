/**
 * 授权 e2e 的腿 1 与腿 2:**真 Electron** 里跑。由 `e2e-license.ts` esbuild 打包后用 Electron 启动。
 *
 *   腿 1  真 utilityProcess + 真 MessageChannelMain + 真协议帧(不开窗口)
 *   腿 2  真窗口 + 真 preload + 真 contextBridge —— 结构化错误必须活着穿过那道序列化边界
 *
 * 两条腿放在一个 Electron 实例里跑,各自 fork **各自的**内核进程、各自一个临时 HOME。
 * 一个 Electron 而不是两个:CDP / 单实例这类东西全机只有一份,而且省 3 秒启动。
 *
 * ## 隔离
 *
 * 内核的 configDir 默认是 `~/.yoma`,授权文件就在那儿。所以 fork 内核时把 **HOME / USERPROFILE**
 * 指到临时目录 —— 开发机上真实的 `~/.yoma/license.json` 一个字节都不会被碰。main 自己**不换** HOME:
 * macOS 的钥匙串查找跟着 `$HOME` 走,给它假 HOME 会弹系统级对话框然后安静退出(根 CLAUDE.md)。
 *
 * ## 不联网
 *
 * `YOMA_MODEL_CATALOG_URL=off` + `YOMA_DATASHEET_SERVER=off`,临时 HOME 里也没有 auth.json,
 * 于是一个 provider 都解析不出来。"授权检查全程不碰网络"这条本身由单测
 * (`packages/kernel/src/host/licensing/licensing.test.ts`「验签、导入、检查全程不碰网络」,spy 住 fetch)
 * 钉着 —— 进程外证不了这件事,这里不吹。
 */

import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from "electron"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { Leg, OFFLINE_ENV, badLicenses, loadPlan, makeIssuer, sleep, until, type Issuer, type LicensePlan } from "./e2e-license-shared.ts"

// ---------------------------------------------------------------------------
// 一个内核进程 + 一条真 MessagePort 的客户端(与 main/kernel.ts 的 attach() 同形)
// ---------------------------------------------------------------------------

interface Frame {
  kind: "response" | "push"
  id?: number
  result?: unknown
  error?: { message: string; stack?: string; data?: Record<string, unknown> }
  events?: Array<{ type: string; [key: string]: unknown }>
}

type Rejection = { message: string; data?: Record<string, unknown> }

class KernelClient {
  private nextId = 1
  private readonly pending = new Map<number, (frame: Frame) => void>()
  readonly pushes: Array<{ type: string; [key: string]: unknown }> = []
  private readonly child: Electron.UtilityProcess
  private port?: Electron.MessagePortMain
  readonly stderr: string[] = []

  constructor(
    readonly label: string,
    kernelJs: string,
    env: Record<string, string>,
  ) {
    this.child = utilityProcess.fork(kernelJs, [], { serviceName: `yoma-license-e2e-${label}`, stdio: "pipe", env })
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd()
      this.stderr.push(text)
      console.error(`   [${label} kernel] ${text}`)
    })
  }

  ready(timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`内核进程 ${timeoutMs / 1000} 秒内没有 ready`)), timeoutMs)
      this.child.on("message", (message: { type?: string }) => {
        if (message?.type === "ready") {
          clearTimeout(timer)
          resolve()
        }
      })
    })
  }

  start(command: { sessionsRoot: string; stateDir: string; enginesDir?: string; version: string }): void {
    this.child.postMessage({ type: "start", ...command })
  }

  /** 与 main 的 attach() 逐字一致:一条 MessageChannel,一端给内核,一端本来给 renderer。 */
  attach(): void {
    const channel = new MessageChannelMain()
    this.child.postMessage({ type: "attach" }, [channel.port1])
    this.port = channel.port2
    this.port.start()
    this.port.on("message", (event) => {
      const frame = event.data as Frame
      if (frame?.kind === "push") {
        for (const e of frame.events ?? []) this.pushes.push(e)
        return
      }
      if (frame?.kind === "response" && frame.id !== undefined) this.pending.get(frame.id)?.(frame)
    })
  }

  /** 给 renderer 的那一端:直接把 port 交给窗口(腿 2)。 */
  attachToWindow(win: BrowserWindow): void {
    const channel = new MessageChannelMain()
    this.child.postMessage({ type: "attach" }, [channel.port1])
    win.webContents.postMessage("kernel-port", null, [channel.port2])
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`${method} 超过 ${timeoutMs / 1000}s 没有响应`), { timedOut: true }))
      }, timeoutMs)
      this.pending.set(id, (frame) => {
        clearTimeout(timer)
        this.pending.delete(id)
        if (frame.error) reject(Object.assign(new Error(frame.error.message), { data: frame.error.data }))
        else resolve(frame.result)
      })
      this.port!.postMessage({ kind: "request", id, method, params })
    })
  }

  /** 要么拿到结果,要么拿到一个**带 data 的**拒绝。两种都要能断言,所以不让它抛。 */
  async settle(method: string, params: unknown, timeoutMs = 20_000): Promise<{ ok: true; result: unknown } | { ok: false; rejection: Rejection & { timedOut?: boolean } }> {
    try {
      return { ok: true, result: await this.request(method, params, timeoutMs) }
    } catch (error) {
      const e = error as Error & { data?: Record<string, unknown>; timedOut?: boolean }
      return { ok: false, rejection: { message: e.message, data: e.data, timedOut: e.timedOut } }
    }
  }

  kill(): void {
    this.child.kill()
  }
}

interface Status {
  edition?: string
  enforced?: boolean
  state?: string
  license?: { licenseId?: string; expiresAt?: string; notBefore?: string }
  error?: { code?: string; message?: string }
  file?: string
  trustedKeyIds?: string[]
}

function kernelEnv(home: string, plan: LicensePlan): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  // 内核的 configDir = `<HOME>/.yoma`。这一行就是"绝不碰开发机真实 ~/.yoma"的全部机制。
  env.HOME = home
  env.USERPROFILE = home
  Object.assign(env, OFFLINE_ENV)
  if (plan.enginesDir) env.YOMA_ENGINES_DIR = plan.enginesDir
  return env
}

// ---------------------------------------------------------------------------
// 腿 1:真 utilityProcess + 真 MessagePort + 真协议帧
// ---------------------------------------------------------------------------

/** 到期用的真实秒数。8–12 之间 —— 短到 e2e 等得起,长到导入之后还来得及跑几条断言。 */
const SHORT_LIFETIME_SEC = 10

async function leg1(plan: LicensePlan, issuer: Issuer): Promise<Leg> {
  const leg = new Leg("腿 1 · 内核 IPC(真 utilityProcess + 真 MessageChannelMain + 真协议帧)")
  const home = join(plan.tmpRoot, "leg1-home")
  const licenseFile = join(home, ".yoma", "license.json")
  const sessionsRoot = join(plan.tmpRoot, "leg1-sessions")
  const stateDir = join(plan.tmpRoot, "leg1-state")
  const workspace = join(plan.tmpRoot, "leg1-ws")
  for (const dir of [home, sessionsRoot, stateDir, workspace]) mkdirSync(dir, { recursive: true })

  const kernel = new KernelClient("leg1", join(plan.desktopDir, "out", "main", "kernel.js"), kernelEnv(home, plan))
  try {
    kernel.start({ sessionsRoot, stateDir, enginesDir: plan.enginesDir, version: "e2e-license" })
    await kernel.ready()
    kernel.attach()
    leg.note(`内核已就绪;隔离 HOME=${home}`)

    // ---- 1. 未激活:看得见、进得去,但开不了工 --------------------------------
    const status0 = (await kernel.request("license.status", undefined)) as Status
    leg.check("license.status 是商业构建且强制检查", status0.edition === "commercial" && status0.enforced === true, `edition=${status0.edition} enforced=${status0.enforced}`)
    leg.check("无授权时 state = missing", status0.state === "missing", String(status0.state))
    leg.check("信任的公钥编号正是产物里烧进去的那把", status0.trustedKeyIds?.length === 1 && status0.trustedKeyIds[0] === plan.keyId, (status0.trustedKeyIds ?? []).join(","))
    leg.check("授权文件位置落在隔离 HOME 里", status0.file === licenseFile, String(status0.file))

    const session = (await kernel.request("session.create", { directory: workspace })) as { id?: string }
    leg.check("未激活也能建会话(查看 / 建会话不受限)", typeof session.id === "string" && session.id.length > 0, String(session.id))
    const sessionID = session.id!

    const blockedPrompt = await kernel.settle("session.prompt", { sessionID, input: { text: "开始烧录" } })
    leg.check(
      "session.prompt 被拒,data._tag = LicenseRequiredError",
      !blockedPrompt.ok && blockedPrompt.rejection.data?._tag === "LicenseRequiredError",
      JSON.stringify(blockedPrompt.ok ? blockedPrompt.result : blockedPrompt.rejection.data),
    )
    leg.check(
      "拒绝理由里 state = missing、execution = session.prompt",
      !blockedPrompt.ok && blockedPrompt.rejection.data?.state === "missing" && blockedPrompt.rejection.data?.execution === "session.prompt",
      !blockedPrompt.ok ? JSON.stringify(blockedPrompt.rejection.data) : "",
    )
    if (!blockedPrompt.ok) leg.note(`模型看不到这句,用户看得到:${blockedPrompt.rejection.message}`)

    const blockedCompact = await kernel.settle("session.compact", { sessionID })
    leg.check(
      "session.compact 同样被拒(state=missing,execution=session.compact)",
      !blockedCompact.ok &&
        blockedCompact.rejection.data?._tag === "LicenseRequiredError" &&
        blockedCompact.rejection.data?.execution === "session.compact",
      JSON.stringify(blockedCompact.ok ? blockedCompact.result : blockedCompact.rejection.data),
    )

    const page = (await kernel.request("session.messages", { sessionID })) as { items?: Array<{ info?: { role?: string } }> }
    const users = (page.items ?? []).filter((item) => item.info?.role === "user")
    leg.check("被拒的 prompt 一个字都没写进 transcript", users.length === 0, `items=${(page.items ?? []).length} user=${users.length}`)

    // 停止、读列表、模型目录、诊断 —— 产品规矩是"始终可用"。
    const abort = await kernel.settle("session.abort", { sessionID })
    leg.check("session.abort 不经授权检查,照常返回", abort.ok, abort.ok ? "" : abort.rejection.message)
    const list = await kernel.settle("session.list", { directory: workspace })
    leg.check("session.list 照常返回", list.ok && Array.isArray(list.result), list.ok ? `${(list.result as unknown[]).length} 条` : list.rejection.message)
    const models = await kernel.settle("model.list", undefined)
    leg.check("model.list 照常返回(未激活也要能进设置页配凭据)", models.ok && Array.isArray(models.result), models.ok ? `${(models.result as unknown[]).length} 个 provider` : models.rejection.message)
    const diag = await kernel.settle("license.diagnostics", undefined)
    const diagText = diag.ok ? ((diag.result as { text?: string }).text ?? "") : ""
    leg.check(
      "license.diagnostics 照常返回,且说的是 missing",
      diag.ok && diagText.includes("授权状态: missing"),
      diag.ok ? (diagText.split("\n").find((l) => l.startsWith("授权状态")) ?? "") : diag.rejection.message,
    )

    // ---- 2. 坏文件一律拒,盘上什么都不留 -------------------------------------
    const sample = issuer.issue({ licenseId: "e2e-leg1", expiresInSec: 3600 })
    for (const bad of badLicenses(sample, plan.keyId)) {
      const rejected = await kernel.settle("license.import", { text: bad.text })
      leg.check(
        `导入被拒:${bad.what} → ${bad.code}`,
        !rejected.ok && rejected.rejection.data?._tag === "LicenseImportError" && rejected.rejection.data?.code === bad.code,
        JSON.stringify(rejected.ok ? rejected.result : rejected.rejection.data),
      )
    }
    // 过期的那份要现签:notBefore **与 issuedAt** 都得在过去,否则连签发自检都过不去(bad-dates)。
    const alreadyExpired = issuer.issue({ licenseId: "e2e-leg1-old", issuedAtSec: -7200, notBeforeSec: -7200, expiresInSec: -3600 })
    const expiredImport = await kernel.settle("license.import", { text: alreadyExpired.text })
    leg.check(
      "导入被拒:签发时就已过期 → expired",
      !expiredImport.ok && expiredImport.rejection.data?.code === "expired",
      JSON.stringify(expiredImport.ok ? expiredImport.result : expiredImport.rejection.data),
    )

    const afterBad = (await kernel.request("license.status", undefined)) as Status
    leg.check("一连串坏文件之后 state 仍是 missing", afterBad.state === "missing", String(afterBad.state))
    leg.check("授权文件没有被创建出来", !existsSync(licenseFile), licenseFile)

    // ---- 3. 真的短有效期:导入 → 门开了 --------------------------------------
    const short = issuer.issue({ licenseId: "e2e-leg1-live", customerLabel: "腿1的购买人称呼", expiresInSec: SHORT_LIFETIME_SEC })
    leg.note(`签一份 ${SHORT_LIFETIME_SEC} 秒有效期的授权(到期 ${new Date(short.expiresAtMs).toISOString()}),真时钟,不注入`)
    const imported = (await kernel.request("license.import", { text: short.text })) as Status
    leg.check("导入短有效期授权 → state = active", imported.state === "active", `${imported.state} exp=${imported.license?.expiresAt}`)
    leg.check("授权文件落在隔离 HOME 里", existsSync(licenseFile), licenseFile)

    // 激活之后再查一次诊断:它是要交给开发者排查的,所以既要有事实,也不许带走秘密。
    const diag2 = (await kernel.request("license.diagnostics", undefined)) as { text?: string }
    const diagActive = diag2.text ?? ""
    const envelope = JSON.parse(short.text) as { payload: string; signature: string }
    leg.check("激活后的诊断说的是 active 且带授权编号", diagActive.includes("授权状态: active") && diagActive.includes("e2e-leg1-live"), diagActive.split("\n").find((l) => l.startsWith("授权状态")) ?? "")
    leg.check(
      "诊断信息里没有购买人称呼、没有 payload / signature 原文",
      !diagActive.includes("腿1的购买人称呼") && !diagActive.includes(envelope.payload.slice(0, 32)) && !diagActive.includes(envelope.signature.slice(0, 32)),
      "",
    )

    const opened = await kernel.settle("session.prompt", { sessionID, input: { text: "现在可以开工了吗" } }, 12_000)
    const openedTag = opened.ok ? undefined : opened.rejection.data?._tag
    leg.check(
      "授权有效时 session.prompt 通过了授权那道门(不是 LicenseRequiredError)",
      openedTag !== "LicenseRequiredError",
      opened.ok ? `resolved ${JSON.stringify(opened.result)}` : `${opened.rejection.timedOut ? "超时" : "另一种失败"}:${opened.rejection.message}`,
    )
    leg.note(
      opened.ok
        ? "门开了之后 prompt 直接 resolve —— 失败会以别的形式出现在事件流里(隔离 HOME 没有凭据)"
        : `门开了之后 prompt 以别的理由失败(这正是预期):${opened.rejection.message.slice(0, 160)}`,
    )
    await kernel.settle("session.abort", { sessionID })

    // ---- 4. 等真的到期 -------------------------------------------------------
    const pushesBefore = kernel.pushes.length
    leg.note(`轮询 license.status 等真实到期(还有 ${((short.expiresAtMs - Date.now()) / 1000).toFixed(1)}s)`)
    const expired = await until(
      async () => {
        const s = (await kernel.request("license.status", undefined)) as Status
        return s.state === "expired" ? s : undefined
      },
      { timeoutMs: SHORT_LIFETIME_SEC * 1000 + 20_000, everyMs: 500 },
    )
    leg.check("真的到点了之后 state = expired(没有注入时钟)", expired?.state === "expired", `${expired?.state ?? "轮询超时"}`)
    if (expired) leg.note(`到期时刻 ${expired.license?.expiresAt};实际观测到 expired 的时刻 ${new Date().toISOString()}`)

    // 事件是**批推**的(StreamSink 攒一帧 ~16ms),所以不能在 status 回来的那一刻就断言 ——
    // 第一版这么写,拿到的是"0 条",而事件其实在十几毫秒后才到。轮询等它。
    const updates = await until(
      () => {
        const seen = kernel.pushes.slice(pushesBefore).filter((e) => e.type === "license.updated")
        return seen.length > 0 ? seen : undefined
      },
      { timeoutMs: 3_000, everyMs: 50 },
    )
    leg.check(
      "状态一变内核就推 license.updated",
      (updates?.length ?? 0) > 0,
      `${updates?.length ?? 0} 条;新状态 ${JSON.stringify((updates?.at(-1)?.status as Status | undefined)?.state ?? null)}`,
    )
    leg.check(
      "推过去的 status 里 state 就是 expired(前端据此出「去激活」)",
      (updates?.at(-1)?.status as Status | undefined)?.state === "expired",
      String((updates?.at(-1)?.status as Status | undefined)?.state),
    )
    leg.note(
      "口径:`license.updated` 由 `LicenseService.status()` 的指纹变化触发 —— 也就是**有人查(或有人尝试执行)的时候**才发;" +
        "内核里没有定时器在自己轮询授权。所以这条事件是这次轮询的副产物,不是一个独立的到期通知。",
    )

    const blockedAgain = await kernel.settle("session.prompt", { sessionID, input: { text: "到期之后还能开工吗" } })
    leg.check(
      "到期后 session.prompt 再次被拒,state = expired",
      !blockedAgain.ok && blockedAgain.rejection.data?._tag === "LicenseRequiredError" && blockedAgain.rejection.data?.state === "expired",
      JSON.stringify(blockedAgain.ok ? blockedAgain.result : blockedAgain.rejection.data),
    )
    leg.check(
      "拒绝理由带上了到期时刻(界面好说清是哪一天)",
      !blockedAgain.ok && blockedAgain.rejection.data?.expiresAt === short.payload.expiresAt,
      !blockedAgain.ok ? String(blockedAgain.rejection.data?.expiresAt) : "",
    )

    // ---- 5. 续费:同一个内核进程,不重启 -------------------------------------
    const renewal = issuer.issue({ licenseId: "e2e-leg1-live", expiresInSec: 3600 })
    const renewed = (await kernel.request("license.import", { text: renewal.text })) as Status
    leg.check("导入续费授权(同 licenseId、更晚的到期)→ 立刻 active", renewed.state === "active", `${renewed.state} exp=${renewed.license?.expiresAt}`)
    leg.check("授权编号沿用(续费不是换一份授权)", renewed.license?.licenseId === "e2e-leg1-live", String(renewed.license?.licenseId))
    const reopened = await kernel.settle("session.prompt", { sessionID, input: { text: "续费之后呢" } }, 12_000)
    leg.check(
      "同一个内核进程没重启,session.prompt 又过了那道门",
      (reopened.ok ? undefined : reopened.rejection.data?._tag) !== "LicenseRequiredError",
      reopened.ok ? "resolved" : reopened.rejection.message.slice(0, 120),
    )
    await kernel.settle("session.abort", { sessionID })
  } catch (error) {
    leg.crashed(error)
  } finally {
    kernel.kill()
  }
  return leg
}

// ---------------------------------------------------------------------------
// 腿 2:真窗口 + 真 preload + 真 contextBridge
// ---------------------------------------------------------------------------

async function leg2(plan: LicensePlan, issuer: Issuer): Promise<Leg> {
  const leg = new Leg("腿 2 · renderer(真窗口 + 真 preload + 真 contextBridge)")
  const home = join(plan.tmpRoot, "leg2-home")
  const licenseFile = join(home, ".yoma", "license.json")
  const sessionsRoot = join(plan.tmpRoot, "leg2-sessions")
  const stateDir = join(plan.tmpRoot, "leg2-state")
  const workspace = join(plan.tmpRoot, "leg2-ws")
  for (const dir of [home, sessionsRoot, stateDir, workspace]) mkdirSync(dir, { recursive: true })

  const kernel = new KernelClient("leg2", join(plan.desktopDir, "out", "main", "kernel.js"), kernelEnv(home, plan))
  let win: BrowserWindow | undefined
  try {
    kernel.start({ sessionsRoot, stateDir, enginesDir: plan.enginesDir, version: "e2e-license-r" })
    await kernel.ready()

    // webPreferences 必须和 windows.ts 里的真窗口逐字一致 —— sandbox / contextIsolation
    // 正是决定 Error 会不会被剥壳的开关(与 e2e-renderer-kernel.ts 同一条纪律)。
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(plan.desktopDir, "out", "preload", "index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    ipcMain.handle("kernel-attach", () => kernel.attachToWindow(win!))
    await win.loadURL("about:blank")
    leg.check("preload 注入了 window.api.kernel", await win.webContents.executeJavaScript(`!!window.api?.kernel?.request`))
    kernel.attachToWindow(win)
    leg.note(`窗口已起(不显示);隔离 HOME=${home}`)

    const status = await win.webContents.executeJavaScript(`
      window.api.kernel.request("license.status", undefined).then((s) => ({ ok: true, s }), (e) => ({ ok: false, message: e && e.message }))
    `)
    leg.check(
      "renderer 里读到 commercial / enforced / missing",
      status?.ok === true && status.s?.edition === "commercial" && status.s?.enforced === true && status.s?.state === "missing",
      JSON.stringify(status),
    )

    const created = await win.webContents.executeJavaScript(`
      window.api.kernel.request("session.create", ${JSON.stringify({ directory: workspace })})
        .then((s) => ({ id: s && s.id }), (e) => ({ error: e && e.message }))
    `)
    leg.check("窗口里能建会话", typeof created?.id === "string", JSON.stringify(created))
    const sessionID = created?.id as string

    // 这一条就是这条腿存在的理由:Electron 在 world 之间重建 Error 时只留 message 和 stack,
    // 自定义属性与 cause 全丢。preload 因此 reject 的是**普通对象**,`data` 才活得下来。
    const refused = await win.webContents.executeJavaScript(`
      window.api.kernel.request("session.prompt", ${JSON.stringify({ sessionID, input: { text: "开工" } })}).then(
        (r) => ({ resolved: JSON.stringify(r ?? null) }),
        (e) => ({
          message: e && e.message,
          tag: e && e.data && e.data._tag,
          state: e && e.data && e.data.state,
          execution: e && e.data && e.data.execution,
          keys: e && e.data ? Object.keys(e.data) : null,
        }),
      )
    `)
    leg.check("session.prompt 的 data._tag 活着穿过 contextBridge", refused?.tag === "LicenseRequiredError", JSON.stringify(refused))
    leg.check("data.state = missing 也没丢", refused?.state === "missing", String(refused?.state))
    leg.check("data.execution = session.prompt 也没丢", refused?.execution === "session.prompt", String(refused?.execution))
    leg.check("错误消息本身还在(界面要直接显示它)", typeof refused?.message === "string" && refused.message.length > 0, String(refused?.message).slice(0, 80))

    const badText = badLicenses(issuer.issue({ licenseId: "e2e-leg2", expiresInSec: 3600 }), plan.keyId)[0]!
    const importRefused = await win.webContents.executeJavaScript(`
      window.api.kernel.request("license.import", ${JSON.stringify({ text: badText.text })}).then(
        (r) => ({ resolved: JSON.stringify(r ?? null) }),
        (e) => ({ message: e && e.message, tag: e && e.data && e.data._tag, code: e && e.data && e.data.code }),
      )
    `)
    leg.check(
      `license.import 被拒时 data.code 活着穿过 contextBridge(${badText.what} → ${badText.code})`,
      importRefused?.tag === "LicenseImportError" && importRefused?.code === badText.code,
      JSON.stringify(importRefused),
    )
    leg.check("被拒的导入没有创建授权文件", !existsSync(licenseFile), licenseFile)

    const good = issuer.issue({ licenseId: "e2e-leg2", expiresInSec: 3600 })
    const importedInRenderer = await win.webContents.executeJavaScript(`
      window.api.kernel.request("license.import", ${JSON.stringify({ text: good.text })})
        .then((s) => ({ state: s && s.state, licenseId: s && s.license && s.license.licenseId }), (e) => ({ error: e && e.message }))
    `)
    leg.check("renderer 里导入有效授权 → active", importedInRenderer?.state === "active", JSON.stringify(importedInRenderer))
    const reread = await win.webContents.executeJavaScript(`
      window.api.kernel.request("license.status", undefined).then((s) => ({ state: s && s.state, exp: s && s.license && s.license.expiresAt }))
    `)
    leg.check("renderer 里再读 license.status 是 active", reread?.state === "active", JSON.stringify(reread))
    leg.check("导入之后授权文件真的落在隔离 HOME 里", existsSync(licenseFile), licenseFile)

    const afterImport = await win.webContents.executeJavaScript(`
      window.api.kernel.request("session.prompt", ${JSON.stringify({ sessionID, input: { text: "现在开工" } })}).then(
        () => ({ tag: null, resolved: true }),
        (e) => ({ tag: e && e.data && e.data._tag, message: e && e.message }),
      )
    `)
    leg.check("导入之后 renderer 发的 prompt 也过了那道门", afterImport?.tag !== "LicenseRequiredError", JSON.stringify(afterImport).slice(0, 180))
    await win.webContents
      .executeJavaScript(`window.api.kernel.request("session.abort", ${JSON.stringify({ sessionID })}).catch(() => {})`)
      .catch(() => {})
  } catch (error) {
    leg.crashed(error)
  } finally {
    ipcMain.removeHandler("kernel-attach")
    win?.destroy()
    kernel.kill()
  }
  return leg
}

// ---------------------------------------------------------------------------

app.disableHardwareAcceleration()

/**
 * **必须压掉 `window-all-closed` 的缺省行为。**
 *
 * Electron 缺省在最后一个窗口关掉时 `app.quit()`(各平台都是,macOS 也不例外 —— 官方示例里那句
 * `if (process.platform !== "darwin") app.quit()` 就是在**覆盖**它)。腿 2 收尾时 `win.destroy()`,
 * 于是进程在打汇总行之前就走了:实测汇总行整段消失,**而且退出码被 quit 抹成 0** —— 腿 2 真挂了
 * 也会被编排器读成通过。这比丢几行输出严重得多,所以这一行是承重的。
 */
app.on("window-all-closed", () => {})

app.whenReady().then(async () => {
  const plan = loadPlan()
  const issuer = makeIssuer(plan.keyPemFile, plan.keyId)
  const legs: Leg[] = []
  try {
    if (plan.legs.includes(1)) legs.push(await leg1(plan, issuer))
    if (plan.legs.includes(2)) legs.push(await leg2(plan, issuer))
  } catch (error) {
    console.error(error)
    app.exit(1)
    return
  }
  // 内核子进程刚被 kill,给它一拍收尾(它自己会在退出时 dispose)。
  await sleep(300)
  // 临时 HOME 里的东西留给编排器统一清 —— 它还要在报告里核对文件位置。
  console.log("")
  for (const leg of legs) console.log(`  ${leg.summary()}`)
  const failed = legs.reduce((sum, leg) => sum + leg.failed, 0)
  rmSync(join(plan.tmpRoot, "leg1-ws"), { recursive: true, force: true })
  rmSync(join(plan.tmpRoot, "leg2-ws"), { recursive: true, force: true })
  // **`app.exit()` 不等 stdout 冲出去。** stdout 是 TTY 时写是同步的,所以手跑看不出问题;
  // 一旦被管道接走(CI、`> log`),最后那几行统计就静静地消失 —— 实测踩过,两条腿全绿却看不到
  // 汇总行。write 的回调正是"已经交给操作系统"的那一刻。
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve())
  })
  await sleep(100)
  app.exit(failed === 0 ? 0 : 1)
})
