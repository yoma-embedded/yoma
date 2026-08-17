/**
 * 信箱调试台的 main 侧接线:把控制器接上真进程、真路径、真广播。
 *
 * 守护是 `child_process.spawn(process.execPath, [mailbox-host.mjs, config])` +
 * ELECTRON_RUN_AS_NODE —— 不用 utilityProcess.fork,理由是**停止语义**:
 * utilityProcess.kill() 没有信号可选,而 POSIX 上优雅停机依赖 SIGTERM 链
 * (守护转杀 turn 孙进程再退,bench/runner.ts 的 activeTurnChildren);
 * Windows 上两者都没有优雅可言,统一走 taskkill /T /F 杀整棵树。
 *
 * 守护配置文件、信箱克隆、演练布景全落在 **`<configDir>/mailbox/`** 下(2026-08-11
 * 之前是 userData/mailbox/)。搬家的理由是单实例锁:锁文件住在克隆目录里面,锁的是
 * "这个物理目录"而不是"这个信箱",而命令行那侧的克隆从来不在 userData 里 —— 两边
 * 落在不同目录时两把锁互不知情,同一个信箱同一个角色能被跑起来两个守护,同时推同一个
 * 远端、同时抢同一块板子。位置的唯一实现在 bench 的 mailbox/paths.ts。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, join } from "node:path"

import type { MailboxHostConfig } from "@yoma-desktop/bench"
// 深引用叶子模块,**不要**改成从 `@yoma-desktop/bench` 主入口取:bench 在 desktop 的
// devDependencies 里,electron-vite 会把它 inline,走主入口等于把整个内核拖进
// out/main/index.js。理由写在 paths.ts 顶部。
import { cloneDirFor } from "@yoma-desktop/bench/mailbox/paths"
import {
  MailboxController,
  type MailboxLaunchHandle,
  type MailboxPublicEvent,
  type MailboxSettings,
  type MailboxTaskRequest,
} from "./mailbox-controller.ts"

export interface MailboxMainOptions {
  /**
   * 这台机器上 yoma agent 的全局目录(默认 `~/.yoma`)—— 凭据、技能、上下文文件
   * 住在这里,信箱克隆落在它下面的 `mailbox/`。**不是 userData**:命令行那侧也要
   * 落在同一个目录,克隆目录一致才是单实例锁生效的前提。测试传临时目录隔离。
   */
  configDir: string
  /** 会话根 —— 与交互内核同一个目录,跑完直接在桌面端回放观战。 */
  sessionsRoot: string
  enginesDir?: string
  /** 打包产物目录(out/main),mailbox-host.mjs / mailbox-turn-entry.mjs 住这里。 */
  bundleDir: string
  broadcast(event: MailboxPublicEvent): void
  persistence: { get(): MailboxSettings | undefined; set(settings: MailboxSettings): void }
  /** 系统通知(闭环挂起等人时喊一声)。接线层给,测试不给 —— 这里不 import electron。 */
  notify?(payload: { title: string; body: string }): void
  log?(line: string): void
}

export interface MailboxMain {
  controller: MailboxController
  /**
   * 退出/重启 app 时把守护树带走。**必须调** —— 任务在飞时用户 Cmd+Q,
   * 守护与 turn 孙进程会变成无人监督地继续烧录/gdb 的孤儿(自动更新的 relaunch
   * 同理)。先 SIGTERM 让守护自己转杀孙进程,宽限内没走干净再硬杀。
   */
  stopAll(graceMs?: number): Promise<void>
  /** 配置页的连通自检:git ls-remote,报错原样给人看。凭据走系统 git,这里不代管。 */
  probe(remote: string): Promise<{ ok: boolean; message: string }>
  /**
   * 人对一次 `await-human` 的回执:写 `rounds/NNN/human-ack.json` 并推上去。
   *
   * **自己一个克隆**(角色名 `human`),绝不碰守护那两个:守护每步都
   * `reset --hard + clean -fd`,往它的克隆里写一个还没提交的文件会被原地清掉,
   * 两个进程同时动一个 `.git` 还要抢 index.lock。
   */
  ackHuman(input: MailboxAckInput): Promise<{ ok: boolean; message: string }>
  /**
   * 任务页:项目模板 + 描述 + 预算档 → 生成任务书文件。硬件事实与安全约束永远来自模板。
   *
   * `projectDir` 是**本机**的工程根(从模板位置推导),不进任务书 —— 它只是这台
   * 机器上"工程目录"没配时的兜底(出题的机器天然就是工程所在的机器)。
   */
  composeJob(
    input: MailboxComposeInput,
  ): Promise<{ ok: boolean; jobFile?: string; projectDir?: string; message?: string }>
}

export interface MailboxComposeInput {
  /** 项目模板(<项目>/.yoma/bench/mailbox.template.json)—— 本身就是一份少了 task 的任务书。 */
  templatePath: string
  description: string
  title?: string
}

/** 停机宽限:SIGTERM 之后守护要转杀孙进程,给它这么久,超时补硬杀。 */
const STOP_GRACE_MS = 10_000

export function createMailboxMain(options: MailboxMainOptions): MailboxMain {
  const mailboxDir = join(options.configDir, "mailbox")
  const children = new Map<MailboxLaunchHandle, ChildProcess>()

  /**
   * composeJob 推导出的项目根 —— 本机"工程目录"没配时的兜底。
   *
   * 出题的那台机器天然就是工程所在的机器(模板住在 `<项目>/.yoma/bench/` 里),所以
   * "写描述 → 入箱并开跑"这条主路不该逼用户先去配置页填一遍路径。工位机没有这条
   * 兜底,它必须自己配 —— 那正是机器无关任务书的代价,也是它该付的。
   */
  let composedProjectDir: string | undefined
  /** 本机工程目录的唯一解析口径:已保存的配置优先,其次 composeJob 的推导。 */
  const resolveProjectDir = (settings: MailboxSettings): string | undefined =>
    settings.projectDir?.trim() || composedProjectDir

  const controller = new MailboxController({
    persistence: options.persistence,
    broadcast: options.broadcast,
    projectDir: resolveProjectDir,
    notify: options.notify,

    launch(config, io) {
      mkdirSync(mailboxDir, { recursive: true })
      const configFile = join(mailboxDir, `host-${config.role}.json`)
      writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n")

      const child = spawn(process.execPath, [join(options.bundleDir, "mailbox-host.mjs"), configFile], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: mailboxDir,
      })
      const handle: MailboxLaunchHandle = { pid: child.pid }
      children.set(handle, child)

      // 增量解码,**不能**逐 chunk `Buffer.toString()`:一条 @@event 行可以远超一个
      // pipe chunk(≤64KiB)—— 终局快照带着几万字的终报,中文 3 字节/字,一行轻松
      // 十几万字节。chunk 边界大概率落在多字节字符中间,各自解码就是两个 U+FFFD,
      // 而 JSON 的结构字符全是 ASCII,parse 照样成功 —— 乱码静默进终报。
      const stdoutDecoder = new TextDecoder()
      const stderrDecoder = new TextDecoder()
      let pending = ""
      child.stdout!.on("data", (chunk: Buffer) => {
        pending += stdoutDecoder.decode(chunk, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) if (line.trim()) io.onLine(line)
      })
      child.stderr!.on("data", (chunk: Buffer) => {
        for (const line of stderrDecoder.decode(chunk, { stream: true }).split("\n")) {
          if (line.trim()) options.log?.(`[mailbox:${config.role}] ${line.trimEnd()}`)
        }
      })
      // spawn 失败(产物缺失)时 error 与 close **都会**来;不去重的话 onExit 跑两次,
      // 控制器就攒出两个重启定时器,恢复时起出两个守护,其中一个失控没人管。
      let exited = false
      const settle = (code: number | null) => {
        if (exited) return
        exited = true
        children.delete(handle)
        io.onExit(code)
      }
      child.on("close", settle)
      child.on("error", () => settle(null))
      return handle
    },

    stopProcess(handle, force) {
      const child = children.get(handle)
      if (!child || child.pid === undefined) return
      if (process.platform === "win32") {
        // Windows 没有优雅信号:child.kill() 只杀得死守护本体,正在跑的 agent 轮
        // 会变成孤儿继续驱动硬件(施工指南硬约束 5)。taskkill /T 杀整棵树。
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore" })
        return
      }
      child.kill(force ? "SIGKILL" : "SIGTERM")
      if (!force) {
        // 宽限后补硬杀。守护的 SIGTERM 处置会先转杀孙进程 —— 通常远用不到这一刀。
        const timer = setTimeout(() => {
          if (children.get(handle) === child && child.exitCode === null) child.kill("SIGKILL")
        }, STOP_GRACE_MS)
        timer.unref?.()
      }
    },

    buildConfig(settings, task) {
      return buildHostConfig(settings, task, options, mailboxDir, resolveProjectDir(settings))
    },
  })

  return {
    controller,
    probe: probeRemote,
    async ackHuman(input) {
      const settings = options.persistence.get()
      if (!settings) return { ok: false, message: "还没配信箱(远端/角色)" }
      const branch = settings.branch?.trim() || "main"
      // 角色名 human:与两个守护的克隆各占各的目录,谁也别去 reset 谁的工作树。
      const clone = cloneDirFor(mailboxDir, settings.remote, "human", settings.branch)
      return ackHumanIn(clone, settings.remote, branch, input)
    },
    async composeJob(input) {
      const composed = await composeJob(input, mailboxDir)
      // 记下推导出的工程根:这台机器还没配"工程目录"时,守护就用它。
      if (composed.ok && composed.projectDir) composedProjectDir = composed.projectDir
      return composed
    },
    async stopAll(graceMs = 5_000) {
      // 先无条件 stop:任务可能正处在重启退避的间隙(没有子进程,但有一个定时器
      // 等着再起一个)。先返回就等于退出路径上又生一个守护出来。
      controller.stop()
      if (!children.size) return
      const deadline = Date.now() + graceMs
      while (children.size && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      // 宽限用完还在的:直接硬杀整棵树。退出路径上宁可粗暴,也不能留下还在
      // 动板子的孤儿 —— 那是这个产品最不该有的失败模式。
      for (const [handle] of [...children]) killHandle(children, handle)
    },
  }
}

/** 硬杀:POSIX 上 SIGKILL 守护本体,Windows 上 taskkill /T 整棵树。 */
function killHandle(children: Map<MailboxLaunchHandle, ChildProcess>, handle: MailboxLaunchHandle): void {
  const child = children.get(handle)
  if (!child || child.pid === undefined) return
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore" })
  else child.kill("SIGKILL")
  children.delete(handle)
}

export interface MailboxAckInput {
  round: number
  answer: "done" | "cannot"
  note?: string
}

/** 跑一条 git,拿到退出码与两股输出。凭据缺失要立刻失败,别在后台等一个不存在的终端。 */
function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
    })
    let stdout = ""
    let stderr = ""
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("error", (error) => resolve({ ok: false, stdout, stderr: error.message }))
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }))
  })
}

/**
 * 写回执并推上去。
 *
 * 这条路径**不经守护**:它是"人"这个第三方写者。协议上安全的前提是路径不相交 ——
 * `human-ack.json` 只有这里写,守护只读它(见 bench 的 store.ts:scanMailbox)。
 */
async function ackHumanIn(
  clone: string,
  remote: string,
  branch: string,
  input: MailboxAckInput,
): Promise<{ ok: boolean; message: string }> {
  if (!remote.trim()) return { ok: false, message: "还没配信箱远端" }
  if (!(input.round > 0)) return { ok: false, message: `轮次不对:${input.round}` }

  if (!existsSync(join(clone, ".git"))) {
    mkdirSync(dirname(clone), { recursive: true })
    const cloned = await git(["clone", "-q", "--branch", branch, remote, clone], dirname(clone))
    if (!cloned.ok) return { ok: false, message: `克隆信箱失败:${cloned.stderr.trim()}` }
  }
  const fetched = await git(["fetch", "-q", "origin", branch], clone)
  if (!fetched.ok) return { ok: false, message: `拉信箱失败:${fetched.stderr.trim()}` }
  // 先对齐远端再写:这个克隆平时没人管,可能停在很旧的位置。
  await git(["reset", "--hard", `origin/${branch}`], clone)
  await git(["clean", "-fd"], clone)

  const roundDir = join(clone, "rounds", String(input.round).padStart(3, "0"))
  if (!existsSync(roundDir)) return { ok: false, message: `信箱里没有第 ${input.round} 轮 —— 先看一眼进度页` }
  const ack = {
    answer: input.answer,
    note: input.note?.trim() || undefined,
    by: userInfo().username,
    at: new Date().toISOString(),
  }
  writeFileSync(join(roundDir, "human-ack.json"), `${JSON.stringify(ack, null, 2)}\n`)

  const added = await git(["add", "-A"], clone)
  if (!added.ok) return { ok: false, message: `git add 失败:${added.stderr.trim()}` }
  const committed = await git(
    [
      "-c",
      "user.name=yoma-mailbox-human",
      "-c",
      "user.email=bench@yoma.local",
      "commit",
      "-q",
      "-m",
      `round ${input.round}: 人工回执(${input.answer})`,
    ],
    clone,
  )
  if (!committed.ok) return { ok: false, message: `提交回执失败:${committed.stderr.trim()}` }

  let pushed = await git(["push", "-q", "origin", `HEAD:${branch}`], clone)
  if (!pushed.ok) {
    // 守护刚推过别的路径就会撞上这一下。路径不相交,rebase 一次必定干净。
    const rebased = await git(["pull", "--rebase", "-q", "origin", branch], clone)
    if (!rebased.ok) return { ok: false, message: `回执推不上去:${rebased.stderr.trim()}` }
    pushed = await git(["push", "-q", "origin", `HEAD:${branch}`], clone)
  }
  if (!pushed.ok) return { ok: false, message: `回执推不上去:${pushed.stderr.trim()}` }
  return {
    ok: true,
    message: input.answer === "done" ? "回执已推送 —— 研发端下一次轮询就接着走" : "已告诉研发端这件事做不了",
  }
}

/**
 * 连通自检。GIT_TERMINAL_PROMPT=0:凭据缺失要**立刻报错**,不能让 git 在后台
 * 等一个永远不会出现的终端输入 —— 那在 UI 上就是一个永远转圈的按钮。
 */
async function probeRemote(remote: string): Promise<{ ok: boolean; message: string }> {
  if (!remote.trim()) return { ok: false, message: "远端地址是空的" }
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-remote", remote.trim(), "HEAD"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
    })
    let stdout = ""
    let stderr = ""
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ ok: false, message: "15 秒没有响应 —— 远端不可达,或 SSH 在等一个不存在的交互确认" })
    }, 15_000)
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ ok: false, message: `git 起不来:${error.message}` })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0)
        resolve({ ok: true, message: stdout.trim() ? "已连通" : "已连通(远端还是空仓,init 时会建出分支)" })
      else resolve({ ok: false, message: stderr.trim() || `git ls-remote 退出码 ${code}` })
    })
  })
}

/**
 * 模板 + 描述 + 预算档 → 任务书。深校验不在这里做 —— init 时 parseMailboxJob 会
 * 完整校验并把问题原样回给 UI(同一套报错,两处不重复实现)。
 *
 * 产出的任务书**不带绝对路径**:它要被推进信箱、在另一台机器上读。推导出的本机
 * 工程根单独回给调用方(见 MailboxMain.composeJob 的注释)。
 */
async function composeJob(
  input: MailboxComposeInput,
  mailboxDir: string,
): Promise<{ ok: boolean; jobFile?: string; projectDir?: string; message?: string }> {
  if (!input.description.trim()) return { ok: false, message: "任务描述是空的 —— agent 不该猜要修什么" }

  let template: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await readFile(input.templatePath, "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("模板必须是一个 JSON 对象")
    template = parsed as Record<string, unknown>
  } catch (error) {
    return { ok: false, message: `模板读不出来:${(error as Error).message}` }
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
  // id 会变成文件名:模板里写成 "foc/v2" 就会指进一个不存在的子目录,写入抛 ENOENT。
  // 那个异常原路 reject 到 renderer,而 UI 的 busy 标志没人复位 —— 整页按钮死掉。
  const rawId = typeof template.id === "string" && template.id.trim() ? template.id.trim() : "job"
  const baseId = rawId.replace(/[^A-Za-z0-9._-]/g, "-")
  const id = `${baseId}-${stamp}`
  const templateMailbox =
    typeof template.mailbox === "object" && template.mailbox !== null
      ? (template.mailbox as Record<string, unknown>)
      : {}
  const templateRepo =
    typeof template.repo === "object" && template.repo !== null ? (template.repo as Record<string, unknown>) : {}
  // repo.directory 被**摘掉**:任务书要在两台机器上被读,而绝对路径是本机事实
  // (出题机的 /Users/… 在工位机上不存在)。模板真写了它,就当本机工程目录的
  // 建议值用;没写就从模板路径反推。
  const { directory: templateDirectory, ...repoRest } = templateRepo as { directory?: unknown } & Record<
    string,
    unknown
  >
  const projectDir =
    typeof templateDirectory === "string" && templateDirectory.trim()
      ? templateDirectory.trim()
      : inferProjectDir(input.templatePath)
  // 模板的 task 字段是**项目级前置约束**(安全红线、目录禁区、已知现象),每个任务
  // 都带上 —— 不能指望每次描述都记得重写"电机绝不能转"这种事。
  const preamble = typeof template.task === "string" && template.task.trim() ? template.task.trim() : undefined
  const description = input.description.trim()
  const job = {
    ...template,
    id,
    title: input.title?.trim() || (typeof template.title === "string" ? template.title : "调试任务"),
    task: preamble ? `${preamble}\n\n## 本次要修的问题\n\n${description}` : description,
    // 工程名默认取**模板的 id**(不是加了时间戳的任务 id):它要在两台机器上对号
    // 入座,而"哪个工程"这件事不随每次出题变化。
    repo: { name: baseId, ...repoRest },
    mailbox: templateMailbox,
  }

  const jobsDir = join(mailboxDir, "jobs")
  const jobFile = join(jobsDir, `${id}.json`)
  try {
    mkdirSync(jobsDir, { recursive: true })
    await writeFile(jobFile, JSON.stringify(job, null, 2) + "\n")
  } catch (error) {
    // 本函数的契约是"永远返回普通对象,不抛" —— 调用方(IPC → renderer)按这个
    // 契约写的,抛出去就是一个没人接的 rejection。
    return { ok: false, message: `任务书写不下去:${(error as Error).message}` }
  }
  return { ok: true, jobFile, projectDir }
}

/**
 * 从模板路径反推工程根 —— **往上找 `.git`**,不数目录层数。
 *
 * 从前是 `dirname(dirname(模板路径))`,写死了"模板在工程根下面一层"。
 * 2026-08-11 把 `.bench/` 并进 `.yoma/bench/` 之后模板深了一层,那个写法会推出
 * `<工程>/.yoma` —— 而且**不报错**:研发端会在一个只有忽略文件的目录里开分支、
 * 找源码,症状是"agent 说它看不到代码",完全指不到真凶。
 *
 * 找 `.git` 才是真正想要的东西:研发端本来就要求工程是 git 仓(prepareBranch 第一句
 * 就是 isRepo),于是这个判据和下游的硬要求是同一个。层数从此不再是承重信息,
 * 以后再挪模板也不用回来改这里。
 *
 * 找不到就退回老写法 —— 那种情况下研发端随后会以"不是 git 仓库"如实拒掉,
 * 比在这里猜一个更早、更清楚。
 */
export function inferProjectDir(templatePath: string): string {
  let dir = dirname(templatePath)
  for (let depth = 0; depth < 8; depth += 1) {
    // `.git` 可能是目录,也可能是 worktree 里的一个文件 —— existsSync 两者都认。
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(dirname(templatePath))
}

function buildHostConfig(
  settings: MailboxSettings,
  task: MailboxTaskRequest,
  options: MailboxMainOptions,
  mailboxDir: string,
  projectDir?: string,
): MailboxHostConfig {
  const shared = {
    branch: settings.branch,
    sessionsRoot: options.sessionsRoot,
    enginesDir: options.enginesDir,
    turnEntry: join(options.bundleDir, "mailbox-turn-entry.mjs"),
    hostEntry: join(options.bundleDir, "mailbox-host.mjs"),
  }
  if (task.kind === "sim") {
    const jobFile = task.jobFile ?? makeRehearsalJob(mailboxDir)
    return {
      role: "sim",
      jobFile,
      root: join(mailboxDir, "rehearsal", "sim"),
      fresh: task.fresh,
      pollSeconds: 2,
      // 演练台的看门狗:剧本是假模型两轮,10 分钟跑不完就是卡住了。生产闭环没有
      // 时间上限,但内置演练必须能自己收场 —— 它跑在用户的 app 里。
      timeoutMin: 10,
      // 内置演练是假模型:脚本与任务书一起生成(见 makeRehearsalJob)。
      faux: task.jobFile ? undefined : REHEARSAL_FAUX,
      // **故意不传 projectDir**:演练的工作树是自己生成的一次性目标仓(任务书里
      // 自带 directory)。把本机工程目录递进去,一旦 sim 哪天开始转发它,演练就会
      // 在用户真实的工程里建分支、写文件 —— 演练必须是"不碰真东西"的。
      ...shared,
    }
  }
  const role = task.kind === "init" ? "init" : task.kind
  return {
    role,
    remote: settings.remote,
    // 克隆按远端×分支×角色分目录:同机双角色(演练/联调)绝不共享工作树 ——
    // 两个守护对同一克隆 reset/clean 会互相清掉写了一半的回填。
    clone: cloneDirFor(mailboxDir, settings.remote, task.kind === "init" ? settings.role : task.kind, settings.branch),
    jobFile: task.jobFile,
    pollSeconds: settings.pollSeconds ?? 15,
    // 本机工程目录:任务书不带绝对路径,两侧各自从这里拿。init/status 也传 ——
    // 快照里的 job.directory 是"打开会话观战"的跳转目标,那必须是本机路径。
    projectDir,
    ...shared,
  }
}

/**
 * 内置演练的假模型脚本 —— 两轮,分工与生产一致:**代码归研发端,工位端只观察**,
 * 而且工位端没有项目检出,东西全靠附件过去。
 *
 * 研发端开局下指令 → 工位端报"没有" → 研发端 write 修复并把产物**当附件**下发
 * (改动由 issueInstruction 提交到项目仓 agent 分支)→ 工位端在自己的一次性工作目录
 * 里读到它 → 研发端读自述判定 `done`。与打包冒烟同一个剧本。
 */
const REHEARSAL_FAUX: MailboxHostConfig["faux"] = {
  turns: [
    [[{ text: "上板看了一圈:工作目录里没有 proof.txt,现象复现" }]],
    [[{ text: "收到附件了,读出来是 bench-ok" }]],
  ],
  mother: [
    [
      {
        text: '开局先确认现状。\n```json\n{"decision":"continue","analysis":"还没有任何观测","instruction":"上板复现一次,报告你看到了什么"}\n```',
      },
    ],
    // 研发端读完第 1 轮结果:先在项目仓里改代码……
    [{ tool: "write", input: { path: "proof.txt", content: "bench-ok\n" } }],
    // ……再把产物当附件下发(改动与附件在同一次 issueInstruction 里提交)。
    [
      {
        text: '缺的东西补上了,产物随这一轮附过去。\n```json\n{"decision":"continue","analysis":"第 1 轮确认了缺失,已补上","instruction":"附件里有 proof.txt,确认它到了你的工作目录并把内容报回来","artifacts":["proof.txt"]}\n```',
      },
    ],
    // 第 2 轮回填之后:研发端自己判断做完了 —— 没有独立判据,done 是模型说的。
    [
      {
        text: '证据够了。\n```json\n{"decision":"done","analysis":"工位端确认收到并读出了 bench-ok","reason":"proof.txt 已送达工位端并被读出,内容正确"}\n```',
      },
    ],
  ],
}

/**
 * 生成内置演练的布景:一个一次性 git 目标仓 + 任务书。与打包冒烟同一个剧本 ——
 * 用户第一次点"本机演练"跑的就是 CI 验过的那条路。
 */
function makeRehearsalJob(mailboxDir: string): string {
  const root = join(mailboxDir, "rehearsal")
  const target = join(root, "target")
  mkdirSync(target, { recursive: true })
  const git = (...args: string[]) => spawnSync("git", ["-C", target, ...args], { stdio: "ignore" })
  if (git("rev-parse", "--verify", "-q", "HEAD").status !== 0) {
    git("init", "-q", "-b", "main")
    git("config", "user.email", "rehearsal@yoma.local")
    git("config", "user.name", "yoma-rehearsal")
    writeFileSync(join(target, "main.c"), "int main(void){return 0;}\n")
    git("add", "-A")
    git("commit", "-q", "-m", "init")
  }
  const jobFile = join(root, "job.json")
  writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "rehearsal",
        title: "本机演练:假模型闭环",
        task: "演练:创建 proof.txt(假模型,不联网不碰硬件)",
        repo: { directory: target },
        mailbox: { mother: { maxTokensPerAnalysis: 50_000 } },
      },
      null,
      2,
    ) + "\n",
  )
  return jobFile
}
