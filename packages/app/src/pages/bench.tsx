// 调试台:信箱闭环(母 agent ↔ 工位 runner)的产品面。四个分区:配置 / 任务 / 进度 / 终报。
// 工位与决策同一套代码,角色只影响可见动作。Node 侧全部在 Electron main
// (packages/desktop/src/main/mailbox.ts),这里只消费 platform.mailbox;web 平台显示提示。
// 判据不归模型管、任务书由模板生成 —— 描述只进 task,判据永远来自模板。
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
type Tier = "quick" | "standard" | "thorough"

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
    /** init 任务终局后自动接着起的常驻角色(任务页"一键开跑"的后半程)。 */
    afterInit: undefined as MailboxRoleView | undefined,
    form: { remote: "", role: "runner" as MailboxRoleView, branch: "", pollSeconds: "" },
    task: { templatePath: "", description: "", tier: "standard" as Tier, title: "" },
  })

  const t = (key: string) => language.t(key as never)
  const say = (error: boolean, text: string) => setState("notice", { error, text })

  function applyStatus(status: MailboxStatusView) {
    setState("status", status)
    if (status.settings && !state.form.remote) {
      setState("form", {
        remote: status.settings.remote,
        role: status.settings.role,
        branch: status.settings.branch ?? "",
        pollSeconds: status.settings.pollSeconds ? String(status.settings.pollSeconds) : "",
      })
    }
    // 一键开跑的后半程:init 任务终局成功 → 自动起本机角色的常驻守护。
    if (state.afterInit && status.phase === "done" && status.task?.kind === "init") {
      const role = state.afterInit
      setState("afterInit", undefined)
      void mailbox?.start({ kind: role }).then((result) => {
        if (!result.ok) say(true, result.message ?? t("bench.error.generic"))
      })
    }
    if (state.afterInit && status.phase === "error") setState("afterInit", undefined)
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

  async function saveSettings() {
    if (!mailbox) return
    const pollSeconds = Number.parseInt(state.form.pollSeconds, 10)
    const result = await mailbox.configure({
      remote: state.form.remote,
      role: state.form.role,
      branch: state.form.branch.trim() || undefined,
      pollSeconds: Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds : undefined,
    })
    say(!result.ok, result.ok ? t("bench.config.saved") : (result.message ?? t("bench.error.generic")))
  }

  async function probeRemote() {
    if (!mailbox) return
    setState("busy", true)
    const result = await mailbox.probe(state.form.remote)
    setState("busy", false)
    say(!result.ok, result.message)
  }

  async function composeAndLaunch() {
    if (!mailbox) return
    setState("busy", true)
    const composed = await mailbox.composeJob({
      templatePath: state.task.templatePath.trim(),
      description: state.task.description,
      tier: state.task.tier,
      title: state.task.title.trim() || undefined,
    })
    if (!composed.ok || !composed.jobFile) {
      setState("busy", false)
      say(true, composed.message ?? t("bench.error.generic"))
      return
    }
    setState("afterInit", state.form.role)
    const started = await mailbox.start({ kind: "init", jobFile: composed.jobFile })
    setState("busy", false)
    if (!started.ok) {
      setState("afterInit", undefined)
      say(true, started.message ?? t("bench.error.generic"))
    } else {
      say(false, t("bench.task.launched"))
      setState("tab", "progress")
    }
  }

  async function startDaemon() {
    if (!mailbox) return
    const result = await mailbox.start({ kind: state.form.role })
    say(!result.ok, result.ok ? t("bench.task.daemonStarted") : (result.message ?? t("bench.error.generic")))
    if (result.ok) setState("tab", "progress")
  }

  async function startRehearsal() {
    if (!mailbox) return
    const result = await mailbox.start({ kind: "sim", fresh: true })
    say(!result.ok, result.ok ? t("bench.task.rehearsalStarted") : (result.message ?? t("bench.error.generic")))
    if (result.ok) setState("tab", "progress")
  }

  async function stopTask() {
    if (!mailbox) return
    const result = await mailbox.stop()
    if (!result.ok) say(true, result.message ?? t("bench.error.generic"))
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
                    placeholder="/path/to/project/.bench/mailbox.template.json"
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
                    <span class={LABEL}>{t("bench.task.tier")}</span>
                    <SelectV2
                      options={["quick", "standard", "thorough"] as Tier[]}
                      current={state.task.tier}
                      value={(tier) => tier}
                      label={(tier) => t(`bench.task.tier.${tier}`)}
                      onSelect={(tier) => tier && setState("task", "tier", tier)}
                    />
                  </div>
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
      case "awaiting-runner":
        return `${props.t("bench.progress.state.awaitingRunner")}(${props.t("bench.round")} ${current.round})`
      case "awaiting-mother":
        return `${props.t("bench.progress.state.awaitingMother")}(${props.t("bench.round")} ${current.round})`
      case "done":
        return `${props.t("bench.progress.state.done")}:${current.verdict.reason}`
    }
  }
  return <div class={`${CARD} px-3 py-2 text-[12px] text-v2-text-text-base`}>{text()}</div>
}

function RoundCard(props: { round: MailboxRoundView; t: (key: string) => string; onWatch: (sessionID: string) => void }) {
  const t = props.t
  const grade = () => props.round.result?.grade
  const checks = () => {
    const current = grade()
    if (!current) return []
    return current.build ? [current.build, ...current.checks] : current.checks
  }
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

      <Show when={props.round.result}>
        {(result) => (
          <div class="flex flex-col gap-2">
            <Show when={result().error}>
              <div class="text-[12px] text-v2-state-fg-danger">{result().error}</div>
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
                <Show when={result().denied.length > 0}>
                  {" · "}
                  {t("bench.progress.denied")} {result().denied.length}
                </Show>
                <Show when={result().turn!.stopReason}>
                  {" · "}
                  {result().turn!.stopReason}
                </Show>
              </div>
            </Show>
            <For each={checks()}>
              {(check) => (
                <div class="flex items-baseline gap-2 text-[12px]">
                  <span
                    class={
                      check.outcome === "pass"
                        ? "text-v2-state-fg-success"
                        : check.outcome === "skip"
                          ? "text-v2-text-text-muted"
                          : "text-v2-state-fg-danger"
                    }
                  >
                    {check.outcome === "pass" ? "✓" : check.outcome === "skip" ? "–" : "✗"}
                  </span>
                  <span class="text-v2-text-text-base">{check.summary}</span>
                </div>
              )}
            </For>
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
          </footer>
        )}
      </Show>
    </article>
  )
}
