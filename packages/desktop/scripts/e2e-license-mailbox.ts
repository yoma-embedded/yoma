/**
 * 授权 e2e 的腿 3:**真守护进程 + 真 turn 子进程 + 假模型**。
 *
 * 跑的是打包产物 `out/main/mailbox-host.mjs` / `mailbox-turn-entry.mjs`,运行时是
 * Electron + `ELECTRON_RUN_AS_NODE`(桌面端 main 起守护的同一条路,与 mailbox-smoke.ts 同款)。
 * 模型是 pi-ai 自带的 fauxProvider —— 除了模型,harness、工具、会话落盘、git 全是真的。
 *
 * 这条腿要证的是 mailbox-smoke 与单测都证不到的三件事:
 *
 * 1. **没授权时守护拒绝启动**:退出码 4,信箱克隆一个字节都没碰,远端零提交。
 * 2. **到期那一刻正在跑的那一轮照常跑完并回填**,之后才在轮次边界停住(`license-paused`);
 *    暂停期间远端不再动、两个守护都活着、不进退避。到期时刻是现场按"刚看到第 2 轮开跑"
 *    这个事件签出来的 —— 真时钟,不注入。
 * 3. **续费之后**:一直活着的那个守护自己恢复(不重启),被停掉的那个重新起来接着跑,
 *    轮次编号连续,闭环跑到 verdict。
 *
 * ## 隔离
 *
 * 一切都在 `os.tmpdir()` 下:工程仓、本地裸仓、两个克隆、会话、**configDir**。授权文件就在
 * `<configDir>/license.json`,所以开发机真实的 `~/.yoma` 一个字节都不会被碰(守护的 configDir
 * 是配置字段,不靠 HOME)。turn 子进程经 `TurnInput.configDir` 拿到同一个目录。
 *
 * ## 授权文件怎么"导入"
 *
 * - 正常导入走**真的那条规则**:`LicenseService.importText`(同一份验签、同一份"导入不能让现状变差")。
 * - 只有把有效授权**换成更短的**那一步用 `writeStoredLicenseAtomic` 直接原子写 —— `importText` 会
 *   (正确地)拒绝一份到期更早的文件,那条规则本身在这里被单独断言了一次。直接写用的是 importText
 *   自己那个原语,所以盘上不会出现"文件短暂不存在"的窗口(那会让守护报 missing 而不是 expired)。
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { Leg, OFFLINE_ENV, sleep, until, type Issuer, type LicensePlan } from "./e2e-license-shared.ts"
// 相对路径:与 license-build.ts 同一条理由(见那个文件的文件头)。
import { LicenseImportError, LicenseService } from "../../kernel/src/host/licensing/service.ts"
import { normalizeLicensePolicy } from "../../kernel/src/host/licensing/policy.ts"
import { licenseFilePath, writeStoredLicenseAtomic } from "../../kernel/src/host/licensing/store.ts"
import { parseLicenseEnvelope } from "../../kernel/src/host/licensing/format.ts"

/** 轮询间隔(秒)。演练不必客气 —— 生产缺省是分钟级。 */
const POLL_SECONDS = 2
/** 第 2 轮里那个慢工具睡多久(秒)—— 到期时刻要落在它中间。 */
const SLOW_ROUND_SEC = 8
/** 看到第 2 轮开跑之后几秒到期。turn 子进程要 1–3 秒才起得来,所以不能太小。 */
const EXPIRE_AFTER_ROUND_START_SEC = 5
/**
 * 观察"真的停住了"那个窗口的下限与上限(毫秒)。
 *
 * 窗口必须长于"要是没停住,下一件事多久会在远端露头" —— 那件事是研发端对第 2 轮的分析(几秒)
 * 加一个轮询周期。第一版拿**第 2 轮自己的耗时**当尺子,结果那一轮被机器卡到 249 秒,窗口跟着变成
 * 255 秒,整条腿跑了 8 分半 —— 尺子量的是错的东西。现在按第 1 轮的耗时(与"下一轮会花多久"同量级)
 * 算,并且封顶。
 */
const FREEZE_WINDOW_FLOOR_MS = 15_000
const FREEZE_WINDOW_CAP_MS = 45_000

// ---------------------------------------------------------------------------

interface HostEvent {
  type: string
  role?: string
  pid?: number
  message?: string
  exitCode?: number
  detail?: string
  outcome?: { kind?: string; round?: number; state?: string; detail?: string; error?: string }
  verdict?: { outcome?: string; reason?: string; decidedBy?: string }
  license?: { _tag?: string; state?: string; execution?: string; expiresAt?: string }
}

interface Stamped {
  at: number
  event: HostEvent
}

/** 一个真守护进程。@@event 行升格成结构化事件,进度行原样留着(断言"没进退避"要看它)。 */
class Daemon {
  readonly events: Stamped[] = []
  readonly progress: string[] = []
  readonly child: ChildProcess
  readonly pid: number
  exit?: { code: number | null; signal: NodeJS.Signals | null; at: number }
  private buffer = ""
  private readonly decoder = new TextDecoder()

  constructor(
    readonly label: string,
    electron: string,
    hostBundle: string,
    configFile: string,
    private readonly log: (message: string) => void,
  ) {
    this.child = spawn(electron, [hostBundle, configFile], {
      // OFFLINE_ENV 也传给守护 —— turn 子进程从它继承(见 shared 里那段注释:少了它踩过一次 249 秒的轮)。
      env: { ...process.env, ...OFFLINE_ENV, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    this.pid = this.child.pid ?? -1
    // 逐 chunk toString 会劈断多字节 UTF-8(done 事件那一行可以带整份终报)。
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.decode(chunk, { stream: true })
      const lines = this.buffer.split("\n")
      this.buffer = lines.pop() ?? ""
      for (const line of lines) this.onLine(line)
    })
    this.child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd()
      if (text) this.log(`[${label} stderr] ${text}`)
    })
    this.child.on("close", (code, signal) => {
      this.exit = { code, signal, at: Date.now() }
    })
  }

  private onLine(line: string): void {
    if (!line.startsWith("@@event ")) {
      if (line.trim()) this.progress.push(line)
      return
    }
    try {
      const event = JSON.parse(line.slice("@@event ".length)) as HostEvent
      this.events.push({ at: Date.now(), event })
      if (event.type === "progress" && event.message) {
        this.progress.push(event.message)
        // 空闲那条每一拍都来,别把它刷到屏幕上淹掉别的。
        if (!event.message.startsWith("(空闲)")) this.log(`[${this.label}] ${event.message}`)
      }
      // idle 每一拍都来(暂停期间是另一侧在等),打出来只会把转折点冲掉。
      if (event.type === "step" && event.outcome?.kind !== "idle") this.log(`[${this.label}] step ${JSON.stringify(event.outcome).slice(0, 150)}`)
      if (event.type === "done") this.log(`[${this.label}] done exit=${event.exitCode} ${(event.detail ?? "").slice(0, 110)}`)
    } catch {
      // 非 JSON 行忽略。
    }
  }

  get alive(): boolean {
    return this.exit === undefined
  }

  find(predicate: (event: HostEvent) => boolean): Stamped | undefined {
    return this.events.find((stamped) => predicate(stamped.event))
  }

  all(predicate: (event: HostEvent) => boolean): Stamped[] {
    return this.events.filter((stamped) => predicate(stamped.event))
  }

  /** 停守护。POSIX 用 SIGTERM(守护据此转杀 turn 孙进程);Windows 用 taskkill 杀树。 */
  stop(): void {
    if (!this.alive) return
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(this.pid), "/T", "/F"], { stdio: "ignore" })
      } catch {
        this.child.kill()
      }
      return
    }
    this.child.kill("SIGTERM")
  }

  /** 等它退出;超时补 SIGKILL 并如实返回 false。 */
  async waitExit(timeoutMs: number): Promise<boolean> {
    if (await until(() => this.exit, { timeoutMs, everyMs: 100 })) return true
    this.child.kill("SIGKILL")
    await until(() => this.exit, { timeoutMs: 3_000, everyMs: 100 })
    return false
  }
}

// ---------------------------------------------------------------------------
// 远端(本地裸仓)的只读探针:"暂停期间什么都没动"全靠它们
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
}

/** 同上,但把 stderr 咽掉 —— 空裸仓上问 `main` 时 git 会喊"有歧义的参数",那不是错。 */
function gitQuiet(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

function commitCount(bare: string): number {
  try {
    return Number.parseInt(gitQuiet(bare, "rev-list", "--count", "main"), 10)
  } catch {
    return 0
  }
}

function remoteRounds(bare: string): string[] {
  try {
    return gitQuiet(bare, "ls-tree", "-d", "--name-only", "main:rounds")
      .split("\n")
      .map((line) => line.trim().replace(/\/$/, ""))
      .filter(Boolean)
      .sort()
  } catch {
    return []
  }
}

function remoteHas(bare: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", bare, "cat-file", "-e", `main:${path}`], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function remoteJson(bare: string, path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(gitQuiet(bare, "show", `main:${path}`)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 把一份授权文本原子写进 configDir。**只给"要把现状变差"那几步用**(importText 会正确地拒绝它们)。 */
function forceStore(text: string, configDir: string): void {
  const parsed = parseLicenseEnvelope(text)
  if (!parsed.ok) throw new Error(`要写进去的授权自己就不合法:${parsed.code}`)
  writeStoredLicenseAtomic(`${JSON.stringify(parsed.envelope, null, 2)}\n`, configDir)
}

/** 锁文件的实情:不存在、或者里面那个 pid 已经死了,都算"没人占着"。 */
function lockHolder(clone: string, role: string): { text?: string; living: boolean } {
  const file = join(clone, ".yoma-lock", `${role}.pid`)
  if (!existsSync(file)) return { living: false }
  const text = readFileSync(file, "utf8").trim()
  const pid = Number.parseInt(text, 10)
  let living = false
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0)
      living = true
    } catch {
      living = false
    }
  }
  return { text, living }
}

// ---------------------------------------------------------------------------

export async function leg3(plan: LicensePlan, issuer: Issuer, electron: string): Promise<Leg> {
  const leg = new Leg("腿 3 · 调试台(真守护进程 + 真 turn 子进程 + 假模型)")
  const root = join(plan.tmpRoot, "leg3")
  const target = join(root, "target")
  const bare = join(root, "origin.git")
  const configDir = join(root, "yoma-config")
  const sessionsRoot = join(root, "sessions")
  const motherClone = join(root, "mother-clone")
  const runnerClone = join(root, "runner-clone")
  // RUN_AS_NODE 的 ESM 入口不能从 asar 加载,与正式 main 的启动路径一致。
  const bundleRoot = plan.desktopDir.endsWith(".asar") ? `${plan.desktopDir}.unpacked` : plan.desktopDir
  const hostBundle = join(bundleRoot, "out", "main", "mailbox-host.mjs")
  const turnBundle = join(bundleRoot, "out", "main", "mailbox-turn-entry.mjs")
  const licenseFile = licenseFilePath(configDir)
  const daemons: Daemon[] = []

  // 与被测产物同一把公钥的策略:导入这一侧必须和产物口径一致,否则"导进去了内核却不认"。
  const policy = normalizeLicensePolicy({
    trustedKeys: [{ id: plan.keyId, publicKey: issuer.publicKeySpkiB64 }],
  })
  const service = () => new LicenseService({ configDir, policy })

  try {
    for (const bundle of [hostBundle, turnBundle]) {
      if (!existsSync(bundle)) {
        leg.check(`产物在:${bundle}`, false, "先 npm run build -w packages/desktop")
        return leg
      }
    }
    mkdirSync(configDir, { recursive: true })
    mkdirSync(sessionsRoot, { recursive: true })

    // --- 布景:工程仓 + 本地裸仓当远端 ------------------------------------------
    execFileSync("git", ["init", "-q", "-b", "main", target])
    git(target, "config", "user.email", "license-e2e@yoma.local")
    git(target, "config", "user.name", "yoma-license-e2e")
    writeFileSync(join(target, "main.c"), "int main(void){return 0;}\n")
    git(target, "add", "-A")
    git(target, "commit", "-q", "-m", "init")
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare])
    leg.note(`工程仓 ${target}`)
    leg.note(`本地裸仓(当远端)${bare}`)
    leg.note(`configDir ${configDir} —— 授权文件将落在 ${licenseFile}`)

    const jobFile = join(root, "job.json")
    writeFileSync(
      jobFile,
      `${JSON.stringify(
        {
          id: "license-e2e",
          title: "授权 e2e:轮次边界暂停与恢复",
          task: "演练:让闭环跨过到期时刻",
          repo: { directory: target },
          mailbox: { mother: { maxTokensPerAnalysis: 50_000 } },
        },
        null,
        2,
      )}\n`,
    )

    /** 写一份守护配置。**授权相关的字段一个都没有** —— 那是产品纪律,这里当然也不许有。 */
    const configFile = (name: string, config: Record<string, unknown>): string => {
      const file = join(root, `host-${name}.json`)
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            branch: "main",
            remote: bare,
            pollSeconds: POLL_SECONDS,
            sessionsRoot,
            configDir,
            turnEntry: turnBundle,
            hostEntry: hostBundle,
            jobFile,
            ...(plan.enginesDir ? { enginesDir: plan.enginesDir } : {}),
            ...config,
          },
          null,
          2,
        )}\n`,
      )
      return file
    }

    const startDaemon = (label: string, file: string): Daemon => {
      const daemon = new Daemon(label, electron, hostBundle, file, (message) => leg.note(message))
      daemons.push(daemon)
      return daemon
    }

    const runOnce = async (label: string, file: string, timeoutMs = 60_000): Promise<Daemon> => {
      const daemon = startDaemon(label, file)
      if (!(await daemon.waitExit(timeoutMs))) leg.check(`${label} 在 ${timeoutMs / 1000}s 内自己退出`, false, "只能 SIGKILL")
      return daemon
    }

    // =========================================================================
    // 1. 无授权:四个干活的角色一律拒绝启动
    // =========================================================================
    leg.check("开跑前 configDir 里没有授权文件", !existsSync(licenseFile), licenseFile)
    const gated = [
      { name: "init-nolicense", role: "init", clone: motherClone },
      { name: "runner-nolicense", role: "runner", clone: runnerClone },
      { name: "mother-nolicense", role: "mother", clone: motherClone, projectDir: target },
      { name: "sim-nolicense", role: "sim", projectDir: target, root: join(root, "sim"), timeoutMin: 2 },
    ]
    for (const { name, ...config } of gated) {
      const daemon = await runOnce(`${config.role}(无授权)`, configFile(name, config), 45_000)
      const done = daemon.find((e) => e.type === "done")?.event
      leg.check(`${config.role} 无授权时退出码 4`, daemon.exit?.code === 4, `code=${daemon.exit?.code} signal=${daemon.exit?.signal}`)
      leg.check(
        `${config.role} 的 done 带 license = {_tag:LicenseRequiredError, state:missing, execution:mailbox.start}`,
        done?.license?._tag === "LicenseRequiredError" && done?.license?.state === "missing" && done?.license?.execution === "mailbox.start",
        JSON.stringify(done?.license),
      )
      leg.check(`${config.role} 的 done 说明了"一个字都没碰"`, (done?.detail ?? "").includes("一个字都没碰"), (done?.detail ?? "").slice(0, 130))
    }
    leg.check("被拒的启动没有建出任何信箱克隆", !existsSync(motherClone) && !existsSync(runnerClone), `mother=${existsSync(motherClone)} runner=${existsSync(runnerClone)}`)
    leg.check("远端零提交(信箱一个字节都没被写)", commitCount(bare) === 0, `${commitCount(bare)} 个提交`)

    // status 不经授权检查 —— 查看进度、读终报、看挂起请求始终可用。
    const statusDaemon = await runOnce("status(无授权)", configFile("status-nolicense", { role: "status", clone: join(root, "status-clone") }), 45_000)
    leg.check("status 角色无授权也退 0", statusDaemon.exit?.code === 0, `code=${statusDaemon.exit?.code}`)
    leg.check("status 发了 snapshot", statusDaemon.find((e) => e.type === "snapshot") !== undefined)

    // =========================================================================
    // 2. 导入有效授权 → init 入箱
    // =========================================================================
    const long = issuer.issue({ licenseId: "e2e-leg3", customerLabel: "授权 e2e 腿 3", expiresInSec: 20 * 60 })
    const importedStatus = service().importText(long.text)
    leg.check("经真的 importText 导入 20 分钟授权 → active", importedStatus.state === "active", `${importedStatus.state} exp=${importedStatus.license?.expiresAt}`)
    leg.check("授权文件落在临时 configDir 里", existsSync(licenseFile), licenseFile)

    const initDaemon = await runOnce("init(有授权)", configFile("init", { role: "init", clone: motherClone }), 60_000)
    leg.check("init 入箱成功(退出码 0)", initDaemon.exit?.code === 0, `code=${initDaemon.exit?.code} ${initDaemon.find((e) => e.type === "done")?.event.detail ?? ""}`)
    leg.check("远端有了提交", commitCount(bare) > 0, `${commitCount(bare)} 个提交`)
    leg.check("远端有 job.json", remoteHas(bare, "job.json"))

    // =========================================================================
    // 3. 两个守护一起跑;第 2 轮一开跑就把授权换成"几秒后到期"
    // =========================================================================
    const motherFile = configFile("mother", { role: "mother", clone: motherClone, projectDir: target, faux: { mother: motherScript() } })
    const runnerFile = configFile("runner", { role: "runner", clone: runnerClone, workRoot: join(root, "runner-work"), faux: { turns: runnerScript() } })
    leg.note(`起 mother 与 runner 两个守护(各自的克隆、同一个裸仓,轮询 ${POLL_SECONDS}s)`)
    const mother = startDaemon("mother", motherFile)
    let runner = startDaemon("runner", runnerFile)
    leg.note(`mother pid ${mother.pid};runner pid ${runner.pid}`)

    const round1Started = Date.now()
    const round1 = await until(() => runner.find((e) => e.type === "step" && e.outcome?.kind === "ran" && e.outcome?.round === 1), {
      timeoutMs: 120_000,
      everyMs: 200,
    })
    leg.check("第 1 轮跑完并回填(闭环真的动起来了)", round1 !== undefined, round1 ? JSON.stringify(round1.event.outcome) : "120s 内没看到")
    if (!round1) return leg
    // 一轮在这台机器上实际要多久 —— 下面算"真的停住了"那个窗口时拿它当尺子。
    const roundCostMs = round1.at - round1Started

    // 第 2 轮的那条进度行由 runner 在**起 turn 子进程之前**打出来,正是"这一轮开跑"的信号。
    const round2Started = await until(() => (runner.progress.some((line) => line.includes("信箱轮 2")) ? Date.now() : undefined), {
      timeoutMs: 90_000,
      everyMs: 100,
    })
    leg.check("第 2 轮开跑了", round2Started !== undefined, round2Started ? "" : "90s 内没看到「信箱轮 2」")
    if (!round2Started) return leg

    // 先证明"导入不能让现状变差"这条规则真的在:一份到期更早的文件必须被 importText 拒掉。
    const short = issuer.issue({ licenseId: "e2e-leg3", expiresInSec: EXPIRE_AFTER_ROUND_START_SEC })
    let refusal: string | undefined
    try {
      service().importText(short.text)
      refusal = "居然收下了"
    } catch (error) {
      refusal = error instanceof LicenseImportError ? error.code : `非 LicenseImportError:${(error as Error).message}`
    }
    leg.check("importText 拒绝到期更早的文件 → older-than-current", refusal === "older-than-current", String(refusal))

    // 所以换短的这一步用 importText 自己那个原语直接原子写:盘上不会出现"文件短暂不存在"的窗口
    // (那会让守护报 missing 而不是 expired,把断言变成另一件事)。
    forceStore(short.text, configDir)
    const expiresAtMs = short.expiresAtMs
    leg.note(`第 2 轮开跑后原子换上"${EXPIRE_AFTER_ROUND_START_SEC}s 后到期"的授权,到期时刻 ${new Date(expiresAtMs).toISOString()}`)
    leg.check("换上的短授权此刻仍是 active(到期还没到)", service().status().state === "active", service().status().state)

    // =========================================================================
    // 4. 到期之后:在飞的那一轮照常完成;之后在轮次边界停住
    // =========================================================================
    // 期限给得阔:这一轮里那个慢工具要睡 8 秒,而机器一忙(另一个会话在同一台机上跑全量单测这类)
    // 真的会把它拖到分钟级 —— 实测见过 249 秒。拖慢不影响判据(到期时刻是按这一轮开跑那一刻签的,
    // 只会更深地落在这一轮里面),所以这里宁可等。
    const round2 = await until(() => runner.find((e) => e.type === "step" && e.outcome?.round === 2), {
      timeoutMs: 300_000,
      everyMs: 200,
    })
    leg.check("到期那一刻在飞的第 2 轮跑完了(kind=ran)", round2?.event.outcome?.kind === "ran", JSON.stringify(round2?.event.outcome))
    leg.check("第 2 轮没有报错(turn 子进程产出了结果,没被杀)", round2?.event.outcome?.error === undefined, String(round2?.event.outcome?.error))
    leg.check(
      "到期时刻确实落在第 2 轮之内(不是跑完之后才到期)",
      expiresAtMs > round2Started && expiresAtMs < (round2?.at ?? 0),
      `开跑 ${iso(round2Started)} < 到期 ${iso(expiresAtMs)} < 回填 ${iso(round2?.at ?? 0)}`,
    )
    leg.check("第 2 轮的结果真的进了远端", remoteHas(bare, "rounds/002/result.json"))
    const result2 = remoteJson(bare, "rounds/002/result.json")
    leg.check(
      "回填的 result.json 是完整的一轮(round=2、有 turn 摘要、没有轮级错误)",
      result2?.round === 2 && result2?.turn !== undefined && result2?.error === undefined,
      JSON.stringify({ round: result2?.round, hasTurn: result2?.turn !== undefined, error: result2?.error }),
    )
    leg.check("此刻授权已过期", service().status().state === "expired", service().status().state)

    const paused = await until(
      () => {
        for (const daemon of [mother, runner]) {
          const hit = daemon.find((e) => e.type === "step" && e.outcome?.kind === "license-paused")
          if (hit) return { daemon, hit }
        }
        return undefined
      },
      { timeoutMs: 60_000, everyMs: 200 },
    )
    leg.check("有一侧发出了 license-paused 的 step", paused !== undefined, paused ? `${paused.daemon.label} ${JSON.stringify(paused.hit.event.outcome)}` : "60s 内没看到")
    if (paused) {
      leg.check("暂停的 state = expired", paused.hit.event.outcome?.state === "expired", String(paused.hit.event.outcome?.state))
      const detail = paused.hit.event.outcome?.detail ?? ""
      leg.check(
        "暂停的话术说全了为什么 / 停在哪 / 怎么恢复",
        detail.includes("到期") && detail.includes("边界暂停") && detail.includes("自动继续"),
        detail.slice(0, 170),
      )
      leg.check("进度里有那条 ⏸ 行", paused.daemon.progress.some((line) => line.startsWith("⏸")), paused.daemon.progress.find((l) => l.startsWith("⏸")) ?? "")
    }

    // --- 真的停住了:窗口要长于"没停住的话下一件事多久会露头",否则"停住"和"还没跑完"长得一样 ---
    const windowMs = Math.min(FREEZE_WINDOW_CAP_MS, Math.max(FREEZE_WINDOW_FLOOR_MS, roundCostMs + 3 * POLL_SECONDS * 1000))
    const before = { commits: commitCount(bare), rounds: remoteRounds(bare), paused: countPaused([mother, runner]) }
    leg.note(
      `观察 ${(windowMs / 1000).toFixed(0)}s(一轮在这台机器上要 ${(roundCostMs / 1000).toFixed(1)}s,` +
        `再加 3 个轮询周期):没停住的话这段时间里远端一定会动`,
    )
    await sleep(windowMs)
    const after = { commits: commitCount(bare), rounds: remoteRounds(bare), paused: countPaused([mother, runner]) }
    leg.check("暂停期间远端提交数不再增长", after.commits === before.commits, `${before.commits} → ${after.commits}`)
    leg.check("暂停期间轮次数不再增长", after.rounds.join(",") === before.rounds.join(","), `${before.rounds.join(",")} → ${after.rounds.join(",")}`)
    leg.check("没有 verdict.json", !remoteHas(bare, "verdict.json"))
    leg.check("暂停这一步被反复走过(3 个以上轮询周期)", after.paused >= before.paused + 3, `${before.paused} → ${after.paused}`)
    leg.check("两个守护都还活着(不是崩了)", mother.alive && runner.alive, `mother=${mother.alive} runner=${runner.alive}`)
    const retries = [...mother.progress, ...runner.progress].filter((line) => line.includes("后重试"))
    leg.check("没有进入 blocked 退避(进度里没有「后重试」)", retries.length === 0, retries.join(" | "))
    for (const daemon of [mother, runner]) {
      const pauses = daemon.progress.filter((line) => line.startsWith("⏸")).length
      leg.check(`${daemon.label} 的 ⏸ 行最多一条(挂一夜不会把环形日志挤掉)`, pauses <= 1, String(pauses))
    }

    // =========================================================================
    // 5. 暂停期间"停止"始终可用;过期时重新起它必须被拒
    // =========================================================================
    const runnerPidBefore = runner.pid
    leg.note(`对 runner(pid ${runnerPidBefore})${process.platform === "win32" ? " taskkill /T /F" : "发 SIGTERM"}`)
    runner.stop()
    const stopped = await runner.waitExit(15_000)
    leg.check("暂停期间也能干净停下(没用上 SIGKILL)", stopped, `code=${runner.exit?.code} signal=${runner.exit?.signal}`)
    leg.check(
      "退出码是它自己 SIGTERM 处置那条路(143),不是被信号硬杀",
      process.platform === "win32" ? !runner.alive : runner.exit?.code === 143,
      `code=${runner.exit?.code} signal=${runner.exit?.signal}`,
    )
    leg.check("mother 没被连累,还活着", mother.alive)
    const lockAfterStop = lockHolder(runnerClone, "runner")
    leg.check("runner 的单实例锁已经没有活着的持有者", !lockAfterStop.living, `锁文件 ${lockAfterStop.text ?? "(不存在)"}`)

    const refusedRestart = await runOnce("runner(过期后重启)", runnerFile, 45_000)
    leg.check("过期时重新起 runner → 退出码 4", refusedRestart.exit?.code === 4, `code=${refusedRestart.exit?.code}`)
    const refusedDone = refusedRestart.find((e) => e.type === "done")?.event
    leg.check("拒绝启动的 done 带 license.state = expired", refusedDone?.license?.state === "expired", JSON.stringify(refusedDone?.license))
    leg.check("被拒的启动没有去抢锁(锁文件没被它改写)", lockHolder(runnerClone, "runner").text === lockAfterStop.text, `${lockAfterStop.text ?? "(不存在)"} → ${lockHolder(runnerClone, "runner").text ?? "(不存在)"}`)
    leg.check("被拒的启动也没有往远端推东西", commitCount(bare) === after.commits, `${after.commits} → ${commitCount(bare)}`)

    // =========================================================================
    // 6. 续费 → 一个自己恢复、一个重新起来,闭环跑到 verdict
    // =========================================================================
    const renewal = issuer.issue({ licenseId: "e2e-leg3", expiresInSec: 3600 })
    const renewed = service().importText(renewal.text)
    leg.check("经真的 importText 导入续费授权 → active", renewed.state === "active", `${renewed.state} exp=${renewed.license?.expiresAt}`)
    leg.check("授权编号沿用(续费不是换一份授权)", renewed.license?.licenseId === "e2e-leg3", String(renewed.license?.licenseId))

    const resumed = await until(() => mother.progress.find((line) => line.startsWith("▶")), { timeoutMs: 40_000, everyMs: 200 })
    leg.check("一直活着的 mother **没重启**就自己解除了暂停", resumed !== undefined, resumed ?? "40s 内没看到 ▶ 行")
    leg.check("mother 还是原来那个进程(pid 没变、没崩)", mother.alive, `pid ${mother.pid}`)

    leg.note("重新起被停掉的 runner")
    runner = startDaemon("runner-2", runnerFile)
    leg.note(`runner 新 pid ${runner.pid}(旧的是 ${runnerPidBefore})`)

    // =========================================================================
    // 7. 竞态兜底 + 工位端这一侧的暂停
    //
    // 上面那次到期是"轮次之间"过期(mother 在边界上停住)。工位端那一侧还有一条更难碰到的路:
    // 守护的边界闸门**刚刚放行**、turn 子进程**还没起来**的那一两秒里过期。那时子进程的内核会在
    // `session.prompt` 第一行拒掉,结果里带 `licenseBlocked`,守护按同一条暂停处理 —— 不回填失败结果。
    // "─── 信箱轮 3 ───"这条进度行正好打在闸门之后、起子进程之前,是这个窗口的信号。
    // =========================================================================
    const round3Entered = await until(() => (runner.progress.some((line) => line.includes("信箱轮 3")) ? Date.now() : undefined), {
      timeoutMs: 60_000,
      everyMs: 50,
    })
    leg.check("第 3 轮进了 runRound(边界闸门已放行)", round3Entered !== undefined, round3Entered ? "" : "60s 内没看到「信箱轮 3」")
    if (!round3Entered) return leg
    // 这时 rounds/003/instruction.json 已经在远端了(mother 刚下发),所以"轮次数没变"证明不了什么 ——
    // 要看的是**提交数**:被拒的这一轮一个提交都不该产生。
    const commitsBeforeRace = commitCount(bare)
    forceStore(issuer.issue({ licenseId: "e2e-leg3", issuedAtSec: -7200, notBeforeSec: -7200, expiresInSec: -1 }).text, configDir)
    leg.note("闸门刚放行、turn 子进程还没起来的那一两秒里把授权换成已过期 —— 这正是竞态兜底那条路")

    const raced = await until(() => runner.find((e) => e.type === "step" && e.outcome?.kind === "license-paused"), { timeoutMs: 60_000, everyMs: 100 })
    leg.check("工位端这一侧也发出了 license-paused", raced !== undefined, raced ? JSON.stringify(raced.event.outcome) : "60s 内没看到")
    leg.check("它停在第 3 轮、state = expired", raced?.event.outcome?.round === 3 && raced?.event.outcome?.state === "expired", JSON.stringify(raced?.event.outcome))
    leg.check(
      "turn 子进程真的起来了、真的被内核拒了、干净退了(它自己打的「0 次工具调用」)",
      runner.progress.some((line) => line.includes("轮次结束:0 次工具调用")),
      runner.progress.filter((line) => line.includes("轮次结束")).join(" | "),
    )
    leg.check("被拒的这一轮没有回填任何结果", !remoteHas(bare, "rounds/003/result.json"))
    leg.check("被拒的这一轮一个提交都没产生", commitCount(bare) === commitsBeforeRace, `${commitsBeforeRace} → ${commitCount(bare)}`)
    leg.check("mother 没被这件事连累(它这会儿在等工位端)", mother.alive)

    // 再等一拍:这一次轮到工位端**自己那道边界闸门**拦(它排在 runRound 之前,所以不会再打
    // "─── 信箱轮 3 ───")。两条路的 outcome 形状一样,靠"进了几次 runRound"把它们分开 ——
    // 不这么钉的话,"边界闸门"与"竞态兜底"任何一条坏掉都看不出来。
    const enteredBefore = runner.progress.filter((line) => line.includes("信箱轮 3")).length
    const secondPause = await until(
      () => {
        const pauses = runner.all((e) => e.type === "step" && e.outcome?.kind === "license-paused")
        return pauses.length >= 2 ? pauses : undefined
      },
      { timeoutMs: 20_000, everyMs: 100 },
    )
    leg.check("下一拍轮到工位端自己那道边界闸门拦(第 2 条 license-paused)", secondPause !== undefined, `${secondPause?.length ?? runner.all((e) => e.type === "step" && e.outcome?.kind === "license-paused").length} 条`)
    leg.check(
      "那一拍没有再进 runRound(证明拦在闸门、不是又起了一次 turn 子进程)",
      runner.progress.filter((line) => line.includes("信箱轮 3")).length === enteredBefore,
      `进 runRound 次数 ${enteredBefore} → ${runner.progress.filter((line) => line.includes("信箱轮 3")).length}`,
    )

    // 再续一次 → 工位端自己接着跑第 3 轮(同一个进程,不重启)。
    const renewal2 = issuer.issue({ licenseId: "e2e-leg3", expiresInSec: 3600 })
    leg.check("再导入一次续费授权 → active", service().importText(renewal2.text).state === "active", service().status().state)

    const finalDone = await until(() => mother.find((e) => e.type === "done" && e.verdict !== undefined), { timeoutMs: 120_000, everyMs: 300 })
    leg.check("闭环跑到终局(mother 发了带 verdict 的 done)", finalDone !== undefined, finalDone ? JSON.stringify(finalDone.event.verdict) : "120s 内没有终局")
    leg.check(
      "终局是 passed 且由研发端裁的",
      finalDone?.event.verdict?.outcome === "passed" && finalDone?.event.verdict?.decidedBy === "mother",
      JSON.stringify(finalDone?.event.verdict),
    )
    leg.check("远端有 verdict.json", remoteHas(bare, "verdict.json"))

    const rounds = remoteRounds(bare)
    leg.check("轮次编号连续、没有重复轮 / 丢轮", rounds.join(",") === "001,002,003", rounds.join(",") || "(空)")
    const ran = daemons
      .filter((daemon) => daemon.label.startsWith("runner"))
      .flatMap((daemon) => daemon.all((e) => e.type === "step" && e.outcome?.kind === "ran").map((s) => s.event.outcome!.round!))
    leg.check("runner 的每一轮只跑了一次(没有重跑)", new Set(ran).size === ran.length, ran.join(","))
    leg.check("三轮都跑到了", ran.slice().sort().join(",") === "1,2,3", ran.join(","))
    leg.note("第 1、2 轮在旧 runner 进程里跑;第 3 轮被竞态兜底挡了一次,续费后在同一个新进程里跑成了")

    await mother.waitExit(30_000)
    await runner.waitExit(30_000)
    leg.check("两个守护都自己收场了", !mother.alive && !runner.alive, `mother code=${mother.exit?.code} runner code=${runner.exit?.code}`)

    leg.note("── 时间线 ──")
    for (const line of timelineOf(daemons, expiresAtMs)) leg.note(line)
  } catch (error) {
    leg.crashed(error)
  } finally {
    for (const daemon of daemons) {
      if (daemon.alive) {
        daemon.stop()
        await daemon.waitExit(8_000)
      }
    }
  }
  return leg
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23)
}

function countPaused(daemons: Daemon[]): number {
  return daemons.reduce((sum, daemon) => sum + daemon.all((e) => e.type === "step" && e.outcome?.kind === "license-paused").length, 0)
}

/**
 * 交给用户的那份证据。**每个守护各自把连续同样的 step 折成一行 ×N**:暂停期间两侧各自
 * 每 2 秒一拍,不折的话一段一分钟的暂停就是几十行 `license-paused` 把真正的转折点冲掉
 * (与守护自己"⏸ 只打一次"同一条理由)。
 */
function timelineOf(daemons: Daemon[], expiresAtMs: number): string[] {
  const rows: Array<{ at: number; until?: number; count: number; text: string }> = [
    { at: expiresAtMs, count: 1, text: "◆◆◆ 授权到期时刻 ◆◆◆" },
  ]
  for (const daemon of daemons) {
    const own: typeof rows = []
    const push = (at: number, text: string) => {
      const tail = own[own.length - 1]
      if (tail && tail.text === text) {
        tail.count += 1
        tail.until = at
        return
      }
      own.push({ at, count: 1, text })
    }
    for (const stamped of daemon.events) {
      const { event } = stamped
      if (event.type === "hello") push(stamped.at, `${daemon.label} 起来了(pid ${event.pid})`)
      if (event.type === "step") {
        push(stamped.at, `${daemon.label} step ${event.outcome?.kind}${event.outcome?.round !== undefined ? ` 轮 ${event.outcome.round}` : ""}`)
      }
      if (event.type === "done") push(stamped.at, `${daemon.label} done exit=${event.exitCode}`)
    }
    if (daemon.exit) own.push({ at: daemon.exit.at, count: 1, text: `${daemon.label} 进程退出 code=${daemon.exit.code} signal=${daemon.exit.signal}` })
    rows.push(...own)
  }
  rows.sort((a, b) => a.at - b.at)
  return rows.map((row) => `${iso(row.at)}  ${row.text}${row.count > 1 ? `  ×${row.count}(到 ${iso(row.until!)})` : ""}`)
}

// ---------------------------------------------------------------------------
// 假模型剧本:研发端连续 continue,工位端每轮跑一个要几秒的工具
// ---------------------------------------------------------------------------

type FauxPart = { text: string } | { tool: string; input: Record<string, unknown> }

function decision(fields: Record<string, unknown>): string {
  return `\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``
}

/** mother 侧是**一条队列**,跨轮连续消费(同一个守护进程里 resolveModels 的闭包缓存着它)。 */
function motherScript(): FauxPart[][] {
  return [
    [{ text: `开局先确认现状。\n${decision({ decision: "continue", analysis: "还没有任何观测", instruction: "上板复现一次,报告你看到了什么" })}` }],
    [{ text: `第 1 轮的现象收到了。\n${decision({ decision: "continue", analysis: "第 1 轮给了基线", instruction: "再跑一次同样的观测,确认可重复" })}` }],
    [{ text: `第 2 轮也一致,收个尾。\n${decision({ decision: "continue", analysis: "两轮一致,再确认一次就收工", instruction: "最后确认一次" })}` }],
    [{ text: `证据够了。\n${decision({ decision: "done", analysis: "三轮观测一致", reason: "现象可重复且与预期一致" })}` }],
  ]
}

/**
 * runner 侧**一轮一个脚本**(`faux.turns[round-1]`),一轮一个子进程,天然隔离。
 * 每轮先调一次 bash(真起子进程、真睡),再给一句自述 —— 第 2 轮睡得久,到期时刻要落在它中间。
 * `sleep` 三平台都有(Windows 上 bash 工具走的是 Git Bash)。
 */
function runnerScript(): FauxPart[][][] {
  const round = (seconds: number, say: string): FauxPart[][] => [
    [{ tool: "bash", input: { command: `sleep ${seconds}; echo observed` } }],
    [{ text: say }],
  ]
  return [round(2, "第 1 轮:观测跑完了,输出 observed"), round(SLOW_ROUND_SEC, "第 2 轮:同样的观测,同样是 observed"), round(2, "第 3 轮:再确认一次,还是 observed")]
}
