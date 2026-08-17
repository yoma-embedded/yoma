// 调试台:信箱闭环(研发端 mother ↔ 工位端 runner)的产品面。四个分区:配置 / 任务 / 进度 / 终报。
// 两个角色同一套代码,角色只影响可见动作。Node 侧全部在 Electron main
// (packages/desktop/src/main/mailbox.ts),这里只消费 platform.mailbox;web 平台显示提示。
// 任务书由模板生成 —— 描述只进 task,硬件事实与安全约束永远来自模板。
// 任务书**不带绝对路径**:工程目录是本机事实,由配置页的"工程目录"提供。
import { For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { SelectV2 } from "@yoma-desktop/ui/v2/select-v2"
import { TextInputV2 } from "@yoma-desktop/ui/v2/text-input-v2"
import type {
  MailboxEventView,
  MailboxRoleView,
  MailboxRoundView,
  MailboxStatusView,
} from "@yoma-desktop/kernel"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { legacySessionHref } from "@/utils/session-route"

const LABEL = "text-[12px] text-v2-text-text-muted [font-weight:500]"
const CARD = "rounded-[8px] border border-v2-border-border-base"
const INPUT_ROW = "flex flex-col gap-1"
const LOG_LINE = "whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.6] text-v2-text-text-muted"

type Tab = "config" | "task" | "progress" | "report"

export default function BenchPage() {
  const platform = usePlatform()
  const language = useLanguage()
  const navigate = useNavigate()
  const mailbox = platform.mailbox

  const [state, setState] = createStore({
    tab: "config" as Tab,
    status: undefined as MailboxStatusView | undefined,
    log: [] as string[],
    busy: false,
    notice: undefined as { error: boolean; text: string } | undefined,
    form: { remote: "", role: "runner" as MailboxRoleView, branch: "", pollSeconds: "", projectDir: "" },
    task: { templatePath: "", description: "", title: "" },
    /** 回执时人补的一句话("电源已设 24V")—— 它会进研发端下一轮的提示词。 */
    ackNote: "",
  })

  const t = (key: string) => language.t(key as never)
  const say = (error: boolean, text: string) => setState("notice", { error, text })

  /**
   * 所有 IPC 调用都从这里过。
   *
   * main 侧的契约是"返回普通对象不抛",但 Electron 的 ipcMain handler 一旦真的抛
   * (磁盘满、路径非法),invoke 就是一个 rejected promise。没有兜底的话
   * `void doSomething()` 会变成无人处理的 rejection:busy 永远停在 true,
   * 整页按钮死掉,而屏幕上一个字都不说。
   */
  async function guard<T>(run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run()
    } catch (error) {
      say(true, (error as { message?: string })?.message ?? String(error))
      return undefined
    } finally {
      setState("busy", false)
    }
  }

  function applyStatus(status: MailboxStatusView) {
    setState("status", status)
    if (status.settings && !state.form.remote) {
      setState("form", {
        remote: status.settings.remote,
        role: status.settings.role,
        branch: status.settings.branch ?? "",
        pollSeconds: status.settings.pollSeconds ? String(status.settings.pollSeconds) : "",
        projectDir: status.settings.projectDir ?? "",
      })
    }
  }

  function pushLog(line: string) {
    setState("log", (log) => [...log.slice(-199), line])
  }

  function handleEvent(event: MailboxEventView) {
    if (event.type === "status") {
      applyStatus(event.status)
      return
    }
    const inner = event.event.type === "child" ? event.event.event : event.event
    if (inner.type === "progress") pushLog(inner.message)
    if (inner.type === "step" && inner.outcome.detail) pushLog(inner.outcome.detail)
    if (inner.type === "done") pushLog(inner.detail)
  }

  onMount(() => {
    if (!mailbox) return
    void mailbox.status().then(applyStatus)
    const unsubscribe = mailbox.subscribe(handleEvent)
    onCleanup(unsubscribe)
  })

  const status = () => state.status
  const snapshot = () => state.status?.snapshot
  const running = () => state.status?.phase === "running" || state.status?.phase === "stopping"
  /** 闭环挂起等人时的那条请求(没挂起就是 undefined —— 面板整个不出现)。 */
  const parked = () => {
    const current = snapshot()?.state
    return current?.kind === "awaiting-human" ? current : undefined
  }

  /**
   * 人回执。写信箱 + 推送都在 main 侧,这里只递一个普通对象。
   *
   * 回执落地后状态自己滑回"等研发端裁决",守护下一次轮询就接着走 —— 前端不需要
   * 再做任何事,也**不要**乐观地把面板收起来:没推成功时那会是一个假象。
   */
  async function ackHuman(round: number, answer: "done" | "cannot") {
    if (!mailbox) return
    setState("busy", true)
    const result = await guard(() => mailbox.ackHuman({ round, answer, note: state.ackNote.trim() || undefined }))
    setState("busy", false)
    if (!result) return
    if (result.ok) setState("ackNote", "")
    say(!result.ok, result.message)
  }

  async function saveSettings() {
    if (!mailbox) return
    const pollSeconds = Number.parseInt(state.form.pollSeconds, 10)
    const result = await guard(() =>
      mailbox.configure({
        remote: state.form.remote,
        role: state.form.role,
        branch: state.form.branch.trim() || undefined,
        pollSeconds: Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds : undefined,
        projectDir: state.form.projectDir.trim() || undefined,
      }),
    )
    if (!result) return
    say(!result.ok, result.ok ? t("bench.config.saved") : (result.message ?? t("bench.error.generic")))
  }

  async function probeRemote() {
    if (!mailbox) return
    setState("busy", true)
    const result = await guard(() => mailbox.probe(state.form.remote))
    if (result) say(!result.ok, result.message)
  }

  async function composeAndLaunch() {
    if (!mailbox) return
    setState("busy", true)
    const composed = await guard(() =>
      mailbox.composeJob({
        templatePath: state.task.templatePath.trim(),
        description: state.task.description,
        title: state.task.title.trim() || undefined,
      }),
    )
    if (!composed) return
    if (!composed.ok || !composed.jobFile) {
      say(true, composed.message ?? t("bench.error.generic"))
      return
    }
    // thenStart 的接力在 main 手里(角色取已保存的配置):这一页关掉、跳走、
    // 甚至 reload 窗口,守护照样会在入箱成功后自己起来。
    setState("busy", true)
    const started = await guard(() => mailbox.start({ kind: "init", jobFile: composed.jobFile, thenStart: true }))
    if (!started) return
    if (!started.ok) {
      say(true, started.message ?? t("bench.error.generic"))
    } else {
      say(false, t("bench.task.launched"))
      setState("tab", "progress")
    }
  }

  async function startDaemon() {
    if (!mailbox) return
    // 角色用**已保存的**配置,不用表单的中间状态 —— 改了没保存就开跑会起错角色。
    const role = state.status?.settings?.role
    if (!role) {
      say(true, t("bench.task.needConfig"))
      return
    }
    const result = await guard(() => mailbox.start({ kind: role }))
    if (!result) return
    say(!result.ok, result.ok ? t("bench.task.daemonStarted") : (result.message ?? t("bench.error.generic")))
    if (result.ok) setState("tab", "progress")
  }

  async function startRehearsal() {
    if (!mailbox) return
    const result = await guard(() => mailbox.start({ kind: "sim", fresh: true }))
    if (!result) return
    say(!result.ok, result.ok ? t("bench.task.rehearsalStarted") : (result.message ?? t("bench.error.generic")))
    if (result.ok) setState("tab", "progress")
  }

  async function stopTask() {
    if (!mailbox) return
    const result = await guard(() => mailbox.stop())
    if (result && !result.ok) say(true, result.message ?? t("bench.error.generic"))
  }

  function watchSession(sessionID: string) {
    const directory = snapshot()?.job?.directory
    if (directory) navigate(legacySessionHref(directory, sessionID))
  }

  const TabButton = (props: { tab: Tab; label: string }) => (
    <button
      type="button"
      data-slot="bench-tab"
      class={`rounded-[6px] px-3 py-1.5 text-[13px] ${
        state.tab === props.tab
          ? "bg-v2-background-bg-layer-01 text-v2-text-text-base [font-weight:600]"
          : "text-v2-text-text-muted hover:text-v2-text-text-base"
      }`}
      onClick={() => setState("tab", props.tab)}
    >
      {props.label}
    </button>
  )

  return (
    <div data-component="bench-page" class="mx-auto flex h-full w-full max-w-[920px] flex-col gap-4 overflow-y-auto px-6 py-6">
      <Show when={mailbox} fallback={<div class="text-[13px] text-v2-text-text-muted">{t("bench.web.only")}</div>}>
        <header class="flex items-center gap-3">
          <h1 class="text-[16px] text-v2-text-text-base [font-weight:600]">{t("bench.title")}</h1>
          <PhaseBadge status={status()} t={t} />
          <span class="flex-1" />
          <Show when={running()}>
            <ButtonV2 variant="neutral" onClick={() => void stopTask()}>
              {t("bench.task.stop")}
            </ButtonV2>
          </Show>
        </header>

        <Show when={status()?.message}>
          <div class={`${CARD} px-3 py-2 text-[12px] text-v2-text-text-muted`}>{status()!.message}</div>
        </Show>
        <Show when={state.notice}>
          <div class={`text-[12px] ${state.notice!.error ? "text-v2-state-fg-danger" : "text-v2-text-text-muted"}`}>
            {state.notice!.text}
          </div>
        </Show>

        <nav class="flex items-center gap-1">
          <TabButton tab="config" label={t("bench.tab.config")} />
          <TabButton tab="task" label={t("bench.tab.task")} />
          <TabButton tab="progress" label={t("bench.tab.progress")} />
          <TabButton tab="report" label={t("bench.tab.report")} />
        </nav>

        <Switch>
          <Match when={state.tab === "config"}>
            <section class="flex max-w-[560px] flex-col gap-3">
              <div class={INPUT_ROW}>
                <span class={LABEL}>{t("bench.config.remote")}</span>
                <TextInputV2
                  value={state.form.remote}
                  onInput={(event) => setState("form", "remote", event.currentTarget.value)}
                  placeholder="git@github.com:you/your-mailbox.git"
                />
                <span class="text-[11px] text-v2-text-text-muted">{t("bench.config.remote.hint")}</span>
              </div>
              <div class={INPUT_ROW}>
                <span class={LABEL}>{t("bench.config.role")}</span>
                <SelectV2
                  options={["runner", "mother"] as MailboxRoleView[]}
                  current={state.form.role}
                  value={(role) => role}
                  label={(role) => t(`bench.config.role.${role}`)}
                  onSelect={(role) => role && setState("form", "role", role)}
                />
              </div>
              <div class={INPUT_ROW}>
                <span class={LABEL}>{t("bench.config.projectDir")}</span>
                <TextInputV2
                  value={state.form.projectDir}
                  onInput={(event) => setState("form", "projectDir", event.currentTarget.value)}
                  placeholder="/path/to/project"
                />
                <span class="text-[11px] text-v2-text-text-muted">{t("bench.config.projectDir.hint")}</span>
              </div>
              <div class="flex gap-3">
                <div class={`${INPUT_ROW} flex-1`}>
                  <span class={LABEL}>{t("bench.config.branch")}</span>
                  <TextInputV2
                    value={state.form.branch}
                    onInput={(event) => setState("form", "branch", event.currentTarget.value)}
                    placeholder="main"
                  />
                </div>
                <div class={`${INPUT_ROW} flex-1`}>
                  <span class={LABEL}>{t("bench.config.poll")}</span>
                  <TextInputV2
                    value={state.form.pollSeconds}
                    onInput={(event) => setState("form", "pollSeconds", event.currentTarget.value)}
                    placeholder="15"
                  />
                </div>
              </div>
              <div class="flex gap-2">
                <ButtonV2 variant="contrast" onClick={() => void saveSettings()}>
                  {t("bench.config.save")}
                </ButtonV2>
                <ButtonV2 variant="neutral" disabled={state.busy} onClick={() => void probeRemote()}>
                  {state.busy ? t("bench.config.probing") : t("bench.config.probe")}
                </ButtonV2>
              </div>
            </section>
          </Match>

          <Match when={state.tab === "task"}>
            <section class="flex max-w-[640px] flex-col gap-4">
              <div class={`${CARD} flex flex-col gap-3 p-4`}>
                <h2 class="text-[13px] text-v2-text-text-base [font-weight:600]">{t("bench.task.compose")}</h2>
                <div class={INPUT_ROW}>
                  <span class={LABEL}>{t("bench.task.template")}</span>
                  <TextInputV2
                    value={state.task.templatePath}
                    onInput={(event) => setState("task", "templatePath", event.currentTarget.value)}
                    placeholder="/path/to/project/.yoma/bench/mailbox.template.json"
                  />
                  <span class="text-[11px] text-v2-text-text-muted">{t("bench.task.template.hint")}</span>
                </div>
                <div class={INPUT_ROW}>
                  <span class={LABEL}>{t("bench.task.description")}</span>
                  <textarea
                    class="min-h-[96px] rounded-[8px] border border-v2-border-border-base bg-transparent px-3 py-2 text-[13px] text-v2-text-text-base outline-none"
                    value={state.task.description}
                    onInput={(event) => setState("task", "description", event.currentTarget.value)}
                    placeholder={t("bench.task.description.placeholder")}
                  />
                </div>
                <div class="flex gap-3">
                  <div class={`${INPUT_ROW} flex-1`}>
                    <span class={LABEL}>{t("bench.task.title")}</span>
                    <TextInputV2
                      value={state.task.title}
                      onInput={(event) => setState("task", "title", event.currentTarget.value)}
                    />
                  </div>
                </div>
                <div>
                  <ButtonV2 variant="contrast" disabled={state.busy || running()} onClick={() => void composeAndLaunch()}>
                    {t("bench.task.launch")}
                  </ButtonV2>
                </div>
              </div>

              <div class={`${CARD} flex flex-col gap-2 p-4`}>
                <h2 class="text-[13px] text-v2-text-text-base [font-weight:600]">{t("bench.task.daemon")}</h2>
                <p class="text-[12px] text-v2-text-text-muted">{t("bench.task.daemon.hint")}</p>
                <div class="flex gap-2">
                  <ButtonV2 variant="neutral" disabled={running()} onClick={() => void startDaemon()}>
                    {t("bench.task.startDaemon")}
                  </ButtonV2>
                  <ButtonV2 variant="neutral" disabled={running()} onClick={() => void startRehearsal()}>
                    {t("bench.task.rehearsal")}
                  </ButtonV2>
                </div>
                <p class="text-[11px] text-v2-text-text-muted">{t("bench.task.rehearsal.hint")}</p>
              </div>
            </section>
          </Match>

          <Match when={state.tab === "progress"}>
            <section class="flex flex-col gap-3">
              <StateBanner status={status()} t={t} />
              {/* 挂起等人:闭环这时候一个 token 都不烧,唯一能推动它的是这两个按钮。 */}
              <Show when={parked()}>
                {(park) => (
                  <div class={`${CARD} flex flex-col gap-2 border-v2-state-fg-danger p-4`}>
                    <h2 class="text-[13px] text-v2-text-text-base [font-weight:600]">
                      {t("bench.human.title")}({t("bench.round")} {park().round})
                    </h2>
                    <pre class="whitespace-pre-wrap text-[12px] leading-[1.6] text-v2-text-text-base">{park().ask}</pre>
                    <div class={INPUT_ROW}>
                      <span class={LABEL}>{t("bench.human.note")}</span>
                      <TextInputV2
                        value={state.ackNote}
                        placeholder={t("bench.human.note.hint")}
                        onInput={(event) => setState("ackNote", event.currentTarget.value)}
                      />
                    </div>
                    <div class="flex gap-2">
                      <ButtonV2 variant="contrast" disabled={state.busy} onClick={() => void ackHuman(park().round, "done")}>
                        {t("bench.human.done")}
                      </ButtonV2>
                      <ButtonV2 variant="neutral" disabled={state.busy} onClick={() => void ackHuman(park().round, "cannot")}>
                        {t("bench.human.cannot")}
                      </ButtonV2>
                    </div>
                    <p class="text-[11px] text-v2-text-text-muted">{t("bench.human.hint")}</p>
                  </div>
                )}
              </Show>
              <For each={[...(snapshot()?.rounds ?? [])].reverse()}>
                {(round) => <RoundCard round={round} t={t} onWatch={watchSession} />}
              </For>
              <Show when={(snapshot()?.rounds ?? []).length === 0}>
                <div class="text-[12px] text-v2-text-text-muted">{t("bench.progress.empty")}</div>
              </Show>
              <Show when={state.log.length > 0}>
                <details class={`${CARD} px-3 py-2`}>
                  <summary class="cursor-pointer text-[12px] text-v2-text-text-muted">{t("bench.progress.log")}</summary>
                  <div class="max-h-[240px] overflow-y-auto pt-2">
                    <For each={state.log}>{(line) => <div class={LOG_LINE}>{line}</div>}</For>
                  </div>
                </details>
              </Show>
            </section>
          </Match>

          <Match when={state.tab === "report"}>
            <section class="flex flex-col gap-3">
              <Show
                when={snapshot()?.state.kind === "done" ? snapshot() : undefined}
                fallback={<div class="text-[12px] text-v2-text-text-muted">{t("bench.report.none")}</div>}
              >
                {(done) => {
                  const verdict = () => {
                    const state = done().state
                    return state.kind === "done" ? state.verdict : undefined
                  }
                  return (
                    <>
                      <div class={`${CARD} flex flex-col gap-1 p-4`}>
                        <div class="flex items-center gap-2">
                          <span
                            class={`text-[14px] [font-weight:600] ${
                              verdict()?.outcome === "passed" ? "text-v2-state-fg-success" : "text-v2-state-fg-danger"
                            }`}
                          >
                            {t(`bench.report.outcome.${verdict()?.outcome ?? "failed"}`)}
                          </span>
                          <span class="text-[12px] text-v2-text-text-muted">
                            {t("bench.report.by")}
                            {verdict()?.decidedBy === "mother" ? t("bench.decision.mother") : t("bench.decision.policy")}
                          </span>
                        </div>
                        <div class="text-[13px] text-v2-text-text-base">{verdict()?.reason}</div>
                        <div class="text-[12px] text-v2-text-text-muted">
                          {t("bench.report.rounds")} {verdict()?.rounds} · {t("bench.report.tokens")}{" "}
                          {(verdict()?.totalRunnerTokens ?? 0) + (verdict()?.totalMotherTokens ?? 0)}
                        </div>
                      </div>
                      <Show when={done().report}>
                        <pre class={`${CARD} overflow-x-auto p-4 text-[12px] leading-[1.7] text-v2-text-text-base`}>
                          {done().report}
                        </pre>
                      </Show>
                    </>
                  )
                }}
              </Show>
            </section>
          </Match>
        </Switch>
      </Show>
    </div>
  )
}

/** 附件大小:给人看的粗粒度就够(一件通常是 1–5MB 的固件)。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `git diff --stat` 的最后一行就是那句汇总("3 files changed, …");空 diff 时没有。 */
function diffSummary(diffStat: string): string | undefined {
  const lines = diffStat
    .trim()
    .split("\n")
    .filter((line) => line.trim())
  return lines.at(-1)?.trim()
}

function PhaseBadge(props: { status?: MailboxStatusView; t: (key: string) => string }) {
  const phase = () => props.status?.phase ?? "idle"
  return (
    <span
      data-slot="bench-phase"
      class={`rounded-full px-2 py-0.5 text-[11px] ${
        phase() === "running"
          ? "bg-v2-background-bg-layer-01 text-v2-text-text-base"
          : phase() === "error"
            ? "text-v2-state-fg-danger"
            : "text-v2-text-text-muted"
      }`}
    >
      {props.t(`bench.phase.${phase()}`)}
      <Show when={props.status?.task}> · {props.t(`bench.kind.${props.status!.task!.kind}`)}</Show>
    </span>
  )
}

function StateBanner(props: { status?: MailboxStatusView; t: (key: string) => string }) {
  const state = () => props.status?.snapshot?.state
  const text = () => {
    const current = state()
    if (!current) return props.t("bench.progress.state.none")
    switch (current.kind) {
      case "empty":
        return props.t("bench.progress.state.empty")
      case "corrupt":
        return `${props.t("bench.progress.state.corrupt")}:${current.detail}`
      // 任务书在信箱里,但一个轮次都还没有 —— 第一轮由研发端出(init 不再代劳)。
      case "kickoff":
        return props.t("bench.progress.state.kickoff")
      case "awaiting-runner":
        return `${props.t("bench.progress.state.awaitingRunner")}(${props.t("bench.round")} ${current.round})`
      case "awaiting-mother":
        return `${props.t("bench.progress.state.awaitingMother")}(${props.t("bench.round")} ${current.round})`
      case "awaiting-human":
        return `${props.t("bench.progress.state.awaitingHuman")}(${props.t("bench.round")} ${current.round})`
      case "done":
        return `${props.t("bench.progress.state.done")}:${current.verdict.reason}`
    }
  }
  return <div class={`${CARD} px-3 py-2 text-[12px] text-v2-text-text-base`}>{text()}</div>
}

function RoundCard(props: { round: MailboxRoundView; t: (key: string) => string; onWatch: (sessionID: string) => void }) {
  const t = props.t
  return (
    <article data-component="bench-round" class={`${CARD} flex flex-col gap-2 p-4`}>
      <header class="flex items-center gap-2">
        <span class="text-[13px] text-v2-text-text-base [font-weight:600]">
          {t("bench.round")} {props.round.round}
        </span>
        <Show when={props.round.instruction}>
          <span class="text-[11px] text-v2-text-text-muted">
            {props.round.instruction!.issuedBy === "mother" ? t("bench.from.mother") : t("bench.from.init")}
          </span>
        </Show>
        <span class="flex-1" />
        <Show when={props.round.result?.sessionID}>
          <ButtonV2 variant="neutral" onClick={() => props.onWatch(props.round.result!.sessionID!)}>
            {t("bench.progress.watch")}
          </ButtonV2>
        </Show>
      </header>

      <Show when={props.round.instruction}>
        <details>
          <summary class="cursor-pointer text-[12px] text-v2-text-text-muted">{t("bench.progress.instruction")}</summary>
          <pre class="mt-1 max-h-[200px] overflow-y-auto whitespace-pre-wrap text-[12px] leading-[1.6] text-v2-text-text-base">
            {props.round.instruction!.prompt}
          </pre>
        </details>
      </Show>

      {/* 本轮附件:研发端构建出的新产物,随指令一起穿过信箱。 */}
      <Show when={props.round.instruction?.artifacts?.length}>
        <div class="text-[11px] text-v2-text-text-muted">
          {t("bench.progress.artifacts")}
          {props.round.instruction!.artifacts!.map((item) => `${item.name}(${formatBytes(item.bytes)})`).join(" · ")}
        </div>
      </Show>

      <Show when={props.round.result}>
        {(result) => (
          <div class="flex flex-col gap-2">
            <Show when={result().error}>
              <div class="text-[12px] text-v2-state-fg-danger">{result().error}</div>
            </Show>
            <Show when={result().incoming?.length}>
              <div class="text-[11px] text-v2-text-text-muted">
                {t("bench.progress.incoming")}
                {result().incoming!.join(" · ")}
              </div>
            </Show>
            {/* 上行:工位端回传的原始数据(研发端那侧已落进 .yoma/back/<轮次>/)。 */}
            <Show when={result().back?.length}>
              <div class="text-[11px] text-v2-text-text-muted">
                {t("bench.progress.back")}
                {result().back!.map((item) => `${item.name}(${formatBytes(item.bytes)})`).join(" · ")}
              </div>
            </Show>
            {/* 没送成的必须现身:静默丢弃会让人以为"工位端什么都没给"。 */}
            <Show when={result().backSkipped?.length}>
              <div class="text-[11px] text-v2-state-fg-danger">
                {t("bench.progress.backSkipped")}
                {result().backSkipped!.map((item) => `${item.name}:${item.reason}`).join(" · ")}
              </div>
            </Show>
            <Show when={result().needsHuman}>
              <div class="text-[12px] text-v2-text-text-base">
                <span class="[font-weight:600]">{t("bench.progress.needsHuman")}</span>
                <span class="whitespace-pre-wrap">{result().needsHuman}</span>
              </div>
            </Show>
            <Show when={result().turn?.text}>
              <div class="max-h-[120px] overflow-y-auto whitespace-pre-wrap text-[12px] leading-[1.6] text-v2-text-text-base">
                {result().turn!.text}
              </div>
            </Show>
            <Show when={result().turn}>
              <div class="text-[11px] text-v2-text-text-muted">
                {t("bench.progress.tools")}
                {Object.entries(result().turn!.toolCounts)
                  .map(([tool, count]) => `${tool}×${count}`)
                  .join(" ") || t("bench.progress.tools.none")}
                {" · "}
                {t("bench.progress.tokens")} {result().spentTokens}
                <Show when={result().turn!.stopReason}>
                  {" · "}
                  {result().turn!.stopReason}
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.round.decision}>
        {(decision) => (
          <footer class="flex flex-col gap-1 border-t border-v2-border-border-base pt-2">
            <div class="text-[12px] text-v2-text-text-base">
              <span class="[font-weight:600]">
                {decision().by === "mother" ? t("bench.decision.mother") : t("bench.decision.policy")}
              </span>
              {" → "}
              {t(`bench.decision.${decision().decision}`)}
            </div>
            <Show when={decision().analysis ?? decision().reason}>
              <div class="whitespace-pre-wrap text-[12px] leading-[1.6] text-v2-text-text-muted">
                {decision().analysis ?? decision().reason}
              </div>
            </Show>
            <Show when={decision().ask}>
              <div class="whitespace-pre-wrap text-[12px] leading-[1.6] text-v2-text-text-base">
                {t("bench.progress.ask")}
                {decision().ask}
              </div>
            </Show>
            {/* 回执:谁在什么时候把那件事做了(或者做不了)。挂起的另一半。 */}
            <Show when={props.round.humanAck}>
              {(ack) => (
                <div class="text-[11px] text-v2-text-text-muted">
                  {ack().answer === "done" ? t("bench.progress.ack.done") : t("bench.progress.ack.cannot")}
                  <Show when={ack().by}> · {ack().by}</Show>
                  <Show when={ack().note}> · {ack().note}</Show>
                </div>
              )}
            </Show>
            {/* 代码改动来自**研发端的裁决**(它才是改代码的一侧),不是工位端的结果。 */}
            <Show when={decision().git}>
              {(git) => (
                <div class="text-[11px] text-v2-text-text-muted">
                  {t("bench.progress.changes")}
                  {git().changedFiles.length} · {git().headCommit.slice(0, 8)}
                  <Show when={diffSummary(git().diffStat)}>{(summary) => <> · {summary()}</>}</Show>
                </div>
              )}
            </Show>
          </footer>
        )}
      </Show>
    </article>
  )
}
