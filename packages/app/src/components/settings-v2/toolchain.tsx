/**
 * 工具链核账页(设置 → 工具链),两个分区:
 *
 * **本机工具链(按芯片平台)** —— 机器级,不需要打开工程。选平台(STM32 / ESP32 /
 * Nordic)→ 按预设逐工具核账 → 缺的手填路径,或者让 Yoma 自动装。后端是
 * `toolchain.families` / `familyStatus` / `familySet` / `install` / `installCancel`
 * 几个 RPC(kernel/src/host/toolchain.ts),预设本体在 coding-agent 的 families.ts;
 * 填进去 / 装出来的路径落 `~/.yoma/toolchains.json`(机器账本),这台电脑上所有工程与
 * agent 会话全局认得 —— 工具链是电脑的属性,不是项目的属性。dir 型条目(CubeMX 安装
 * 目录 / ESP-IDF 根目录 / Zephyr SDK)占位文案要的是目录,验证也只验存在(pathKind 从
 * families RPC 带回)。选中的平台记在 localStorage("yoma.toolchain.family"),重开设置页还在。
 *
 * **自动安装**:核账结果里带 `installable` 的工具(catalog.ts 对这台机器有包)显示
 * "安装"按钮;进度走内核事件 `toolchain.install`(download 阶段带字节数),按工具 id
 * 存进一个 store;装完拿 RPC 回来的核账直接 mutate,不重新探测。取消走 installCancel。
 *
 * **当前工程清单** —— 项目声明的 `.yoma/toolchain.json` 对上这台机器,原有行为:
 * 后端 `toolchain.status` / `toolchain.set`,与 agent 的 toolchain 工具共用同一套
 * 探测与验证。工程目录来自当前路由(`params.dir`,base64)—— 从主页打开时没有,
 * 只显示"先打开一个工程";机器分区不受影响,这正是它存在的理由之一。
 */

import { createEffect, createMemo, createResource, For, onCleanup, onMount, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { TextInputV2 } from "@yoma-desktop/ui/v2/text-input-v2"
import { Icon } from "@yoma-desktop/ui/icon"
import type { ToolchainFamilyToolView, ToolchainResolvedTool, ToolchainStatusView } from "@yoma-desktop/kernel"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { kernel } from "@/utils/kernel"
import { decode64 } from "@/utils/base64"
import { SettingsListV2 } from "./parts/list"
import {
  formatMB,
  installableMissing,
  installProgressPercent,
  isInstallInFlight,
  type InstallProgressView,
} from "./toolchain-install"
import "./settings-v2.css"

const FAMILY_STORAGE_KEY = "yoma.toolchain.family"

const primaryBin = (tool: ToolchainResolvedTool) => Object.values(tool.bin)[0]

/**
 * 安装进度按工具 id 存一份,**模块级**而不是组件级:装 Arm 工具链要几分钟,用户离开设置页
 * 再回来,组件重建但进度不能丢。事件来自内核(StreamSink 已把同一个 id 的相邻进度折叠成最后
 * 一条);终态(done / error / cancelled)保留在行上,直到核账刷新把它清掉。
 */
const [installs, setInstalls] = createStore<Record<string, InstallProgressView | undefined>>({})

/** 内核 RPC 的拒绝里带着 ToolchainInstallError 的结构化信息(kernel-entry 只序列化 data)。 */
const installErrorPhase = (err: unknown): string | undefined =>
  (err as { data?: { _tag?: string; phase?: string } } | undefined)?.data?._tag === "ToolchainInstallError"
    ? (err as { data: { phase?: string } }).data.phase
    : undefined

/** 单个工具一行,机器分区与工程分区共用 —— meta(预设的 title/pathKind)只有机器分区有。 */
const ToolRow: Component<{
  tool: ToolchainResolvedTool
  meta?: ToolchainFamilyToolView
  pathValue: string
  saving: boolean
  onPath: (value: string) => void
  onRecord: () => void
  /** 目录选择器(桌面端才有)。 */
  onBrowse?: () => void
  /** 自动安装的进度(有就画进度行);installing 期间按钮换成取消。 */
  progress?: InstallProgressView
  onInstall?: () => void
  onCancelInstall?: () => void
}> = (props) => {
  const language = useLanguage()
  const statusLabel = () => language.t(`settings.toolchain.status.${props.tool.status}`)
  const inFlight = () => isInstallInFlight(props.progress)

  const progressText = () => {
    const p = props.progress
    if (!p) return ""
    switch (p.phase) {
      case "download":
        return language.t("settings.toolchain.installing.download", {
          percent: String(installProgressPercent(p) ?? 0),
        })
      case "error":
        return language.t("settings.toolchain.installing.error", { message: p.message ?? "" })
      default:
        return language.t(`settings.toolchain.installing.${p.phase}`)
    }
  }

  return (
    <div class="settings-v2-toolchain-row" data-status={props.tool.status} data-tool={props.tool.id}>
      <div class="settings-v2-toolchain-row-head">
        <Icon
          name={props.tool.status === "ok" ? "circle-check" : "warning"}
          class="settings-v2-toolchain-icon"
          data-ok={props.tool.status === "ok"}
        />
        <span class="settings-v2-toolchain-name">{props.meta?.title ?? props.tool.id}</span>
        <Show when={props.meta}>
          <span class="settings-v2-toolchain-id">{props.tool.id}</span>
        </Show>
        <Show when={props.tool.optional}>
          <span class="settings-v2-toolchain-tag">{language.t("settings.toolchain.optional")}</span>
        </Show>
        <span class="settings-v2-toolchain-status">{statusLabel()}</span>
        <Show when={props.tool.version}>
          <span class="settings-v2-toolchain-version">{props.tool.version}</span>
        </Show>
        <Show when={props.tool.wanted}>
          <span class="settings-v2-toolchain-wanted">
            {language.t("settings.toolchain.wanted", { version: props.tool.wanted! })}
          </span>
        </Show>
      </div>

      <Show when={props.tool.status === "ok" && primaryBin(props.tool)}>
        <div class="settings-v2-toolchain-path">
          {primaryBin(props.tool)}
          <Show when={props.tool.source}> · {props.tool.source}</Show>
        </div>
      </Show>

      <Show when={props.tool.status === "ambiguous" && props.tool.candidates?.length}>
        <div class="settings-v2-toolchain-candidates">
          {language.t("settings.toolchain.candidates")}
          <For each={props.tool.candidates}>{(candidate) => <div>{candidate}</div>}</For>
        </div>
      </Show>

      <Show when={props.progress}>
        {(p) => (
          <div class="settings-v2-toolchain-progress" data-phase={p().phase}>
            <span>{progressText()}</span>
            <Show when={p().phase === "download"}>
              <div class="settings-v2-toolchain-progress-bar">
                <div style={{ width: `${installProgressPercent(p()) ?? 0}%` }} />
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.tool.status !== "ok"}>
        <Show when={props.tool.installable && props.onInstall}>
          {(_) => {
            const installable = () => props.tool.installable!
            return (
              <div class="settings-v2-toolchain-install">
                <Show
                  when={inFlight()}
                  fallback={
                    <ButtonV2
                      size="normal"
                      variant="contrast"
                      icon="download"
                      data-action="install"
                      onClick={() => props.onInstall?.()}
                    >
                      {language.t("settings.toolchain.install", {
                        title: installable().title,
                        version: installable().version,
                        size: formatMB(installable().bytes),
                      })}
                    </ButtonV2>
                  }
                >
                  <ButtonV2 size="normal" variant="neutral" data-action="install-cancel" onClick={() => props.onCancelInstall?.()}>
                    {language.t("settings.toolchain.cancel")}
                  </ButtonV2>
                </Show>
                <span class="settings-v2-toolchain-installable">{language.t("settings.toolchain.installable")}</span>
              </div>
            )
          }}
        </Show>
        <Show when={props.tool.hint}>
          <div class="settings-v2-toolchain-hint">{props.tool.hint}</div>
        </Show>
        <div class="settings-v2-toolchain-set">
          <TextInputV2
            value={props.pathValue}
            onInput={(event) => props.onPath(event.currentTarget.value)}
            placeholder={language.t(
              props.meta?.pathKind === "dir" ? "settings.toolchain.dirPlaceholder" : "settings.toolchain.pathPlaceholder",
            )}
          />
          <Show when={props.onBrowse}>
            <ButtonV2 size="normal" variant="neutral" data-action="browse" onClick={() => props.onBrowse?.()}>
              {language.t("settings.toolchain.browse")}
            </ButtonV2>
          </Show>
          <ButtonV2
            size="normal"
            variant="neutral"
            disabled={!props.pathValue.trim() || props.saving}
            onClick={() => props.onRecord()}
          >
            {language.t(props.saving ? "settings.toolchain.recording" : "settings.toolchain.record")}
          </ButtonV2>
        </div>
      </Show>
    </div>
  )
}

export const SettingsToolchainV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const params = useParams()
  const directory = createMemo(() => decode64(params.dir) ?? "")

  const failToast = (err: unknown) =>
    showToast({
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })

  const recordedToast = (id: string) =>
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("settings.toolchain.toast.recorded", { id }),
    })

  // 目录选择器只有桌面端有;web 宿主没有就不显示"浏览"按钮。
  const browse = (onPick: (dir: string) => void) => {
    if (platform.platform !== "desktop") return undefined
    return () =>
      void platform.openDirectoryPickerDialog({ multiple: false }).then((picked) => {
        const dir = Array.isArray(picked) ? picked[0] : picked
        if (dir) onPick(dir)
      })
  }

  // ── 自动安装进度(按工具 id,模块级 store)───────────────────────────────

  onMount(() => {
    const stop = serverSDK().event.listen((event) => {
      if (event.type !== "toolchain.install") return
      setInstalls(event.id, {
        packageId: event.packageId,
        version: event.version,
        phase: event.phase,
        bytes: event.bytes,
        total: event.total,
        message: event.message,
      })
    })
    onCleanup(stop)
    // renderer 重载(或本页第一次打开时内核里已经有安装在跑):进度事件不重放,
    // 先问一声"谁在装",给它们挂一个"准备中"的行,下一条事件会把阶段补上。
    void kernel.toolchain
      .installsActive()
      .then((ids) => {
        for (const id of ids) {
          if (!isInstallInFlight(installs[id])) setInstalls(id, { packageId: "", version: "", phase: "resolve" })
        }
      })
      .catch(() => {})
  })

  /** 核账刷新后:已经 ok 的工具不再顶着终态进度行。 */
  const clearSettledProgress = (view: ToolchainStatusView | undefined) => {
    if (!view) return
    for (const tool of view.tools) {
      if (tool.status === "ok" && installs[tool.id] && !isInstallInFlight(installs[tool.id])) setInstalls(tool.id, undefined)
    }
  }

  const installedToast = (id: string) =>
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("settings.toolchain.toast.installed", { id }),
    })

  /** 装一个工具;装完由调用方决定刷新哪份核账。失败的话术来自内核(ToolchainInstallError 的 message)。 */
  const installTool = async (id: string, installable: NonNullable<ToolchainResolvedTool["installable"]>) => {
    if (isInstallInFlight(installs[id])) return undefined
    setInstalls(id, { packageId: installable.packageId, version: installable.version, phase: "resolve" })
    try {
      const result = await kernel.toolchain.install({ id })
      installedToast(id)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 用户自己点的取消不是失败:行上留"已取消",不弹红 toast。
      if (installErrorPhase(err) === "cancelled" || installs[id]?.phase === "cancelled") {
        setInstalls(id, { packageId: installable.packageId, version: installable.version, phase: "cancelled" })
        return undefined
      }
      setInstalls(id, { packageId: installable.packageId, version: installable.version, phase: "error", message })
      showToast({ title: language.t("settings.toolchain.toast.installFailed", { id }), description: message })
      return undefined
    }
  }

  const cancelInstall = (id: string) => void kernel.toolchain.installCancel({ id }).catch(failToast)

  // ── 本机(按芯片平台)──────────────────────────────────────────────────────

  const [families] = createResource(() => kernel.toolchain.families())
  const [machine, setMachine] = createStore({
    family: localStorage.getItem(FAMILY_STORAGE_KEY) ?? "stm32",
    paths: {} as Record<string, string>,
    saving: undefined as string | undefined,
    probing: false,
    installingAll: false,
  })
  const [familyView, { mutate: mutateFamily }] = createResource(
    () => machine.family,
    (family) => kernel.toolchain.familyStatus({ family }),
  )

  const selectFamily = (id: string) => {
    setMachine("family", id)
    localStorage.setItem(FAMILY_STORAGE_KEY, id)
  }

  // localStorage 里可能躺着一个已经不存在的平台 id(预设改名/删除)—— 目录到手后落回第一个。
  createEffect(() => {
    const list = families()?.families
    if (list?.length && !list.some((family) => family.id === machine.family)) selectFamily(list[0].id)
  })

  const familyMeta = createMemo(() => families()?.families.find((family) => family.id === machine.family))
  const toolMeta = (id: string) => familyMeta()?.tools.find((tool) => tool.id === id)

  const reprobeFamily = async () => {
    if (machine.probing) return
    setMachine("probing", true)
    try {
      const view = await kernel.toolchain.familyStatus({ family: machine.family, fresh: true })
      mutateFamily(view)
      clearSettledProgress(view)
    } catch (err) {
      failToast(err)
    } finally {
      setMachine("probing", false)
    }
  }

  const recordFamilyPath = async (id: string) => {
    const path = machine.paths[id]?.trim()
    if (!path || machine.saving) return
    setMachine("saving", id)
    try {
      mutateFamily(await kernel.toolchain.familySet({ family: machine.family, id, path }))
      setMachine("paths", id, "")
      recordedToast(id)
    } catch (err) {
      failToast(err)
    } finally {
      setMachine("saving", undefined)
    }
  }

  /** 装完刷新当前平台的核账(非 fresh:账本已经有它,不必再逐个 --version)。 */
  const refreshFamilyAfterInstall = async () => {
    try {
      const view = await kernel.toolchain.familyStatus({ family: machine.family })
      mutateFamily(view)
      clearSettledProgress(view)
    } catch (err) {
      failToast(err)
    }
  }

  const installFamilyTool = async (tool: ToolchainResolvedTool) => {
    if (!tool.installable) return
    const result = await installTool(tool.id, tool.installable)
    if (result) await refreshFamilyAfterInstall()
  }

  const installAllMissing = async (view: ToolchainStatusView) => {
    if (machine.installingAll) return
    setMachine("installingAll", true)
    try {
      for (const id of installableMissing(view.tools)) {
        const tool = view.tools.find((t) => t.id === id)
        if (!tool?.installable) continue
        await installTool(id, tool.installable)
      }
      await refreshFamilyAfterInstall()
    } finally {
      setMachine("installingAll", false)
    }
  }

  const familySummary = (view: ToolchainStatusView) => {
    const ok = view.tools.filter((tool) => tool.status === "ok").length
    return language.t("settings.toolchain.machine.summary", { ok: String(ok), total: String(view.tools.length) })
  }

  // ── 当前工程清单 ──────────────────────────────────────────────────────────

  const [status, { mutate }] = createResource(directory, (dir) =>
    dir ? kernel.toolchain.status({ directory: dir }) : undefined,
  )
  const [project, setProject] = createStore({
    paths: {} as Record<string, string>,
    saving: undefined as string | undefined,
    probing: false,
  })

  const reprobeProject = async () => {
    const dir = directory()
    if (!dir || project.probing) return
    setProject("probing", true)
    try {
      const view = await kernel.toolchain.status({ directory: dir, fresh: true })
      mutate(view)
      clearSettledProgress(view)
    } catch (err) {
      failToast(err)
    } finally {
      setProject("probing", false)
    }
  }

  const recordProjectPath = async (id: string) => {
    const dir = directory()
    const path = project.paths[id]?.trim()
    if (!dir || !path || project.saving) return
    setProject("saving", id)
    try {
      mutate(await kernel.toolchain.set({ directory: dir, id, path }))
      setProject("paths", id, "")
      recordedToast(id)
    } catch (err) {
      failToast(err)
    } finally {
      setProject("saving", undefined)
    }
  }

  const installProjectTool = async (tool: ToolchainResolvedTool) => {
    const dir = directory()
    if (!dir || !tool.installable) return
    const result = await installTool(tool.id, tool.installable)
    if (!result) return
    try {
      const view = await kernel.toolchain.status({ directory: dir })
      mutate(view)
      clearSettledProgress(view)
    } catch (err) {
      failToast(err)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.toolchain.title")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.toolchain.machine.title")}</h3>
          <p class="settings-v2-toolchain-note">{language.t("settings.toolchain.machine.description")}</p>

          <div class="settings-v2-toolchain-families" role="tablist">
            <For each={families()?.families}>
              {(family) => (
                <button
                  type="button"
                  class="settings-v2-toolchain-family-chip"
                  data-active={family.id === machine.family}
                  data-action="settings-toolchain-family"
                  onClick={() => selectFamily(family.id)}
                >
                  {family.name}
                </button>
              )}
            </For>
          </div>

          <Show when={familyView()} fallback={<p class="settings-v2-toolchain-note">…</p>}>
            {(view) => (
              <Show
                when={!view().error}
                fallback={
                  <div class="settings-v2-toolchain-error">
                    <p>{language.t("settings.toolchain.parseError")}</p>
                    <pre>{view().error}</pre>
                  </div>
                }
              >
                <div class="settings-v2-toolchain-summary">
                  <p class="settings-v2-toolchain-note">{familySummary(view())}</p>
                  <div class="settings-v2-toolchain-install">
                    <Show when={installableMissing(view().tools).length > 0}>
                      <ButtonV2
                        size="normal"
                        variant="contrast"
                        icon="download"
                        data-action="install-all"
                        disabled={machine.installingAll}
                        onClick={() => void installAllMissing(view())}
                      >
                        {language.t("settings.toolchain.installAll")}
                      </ButtonV2>
                    </Show>
                    <ButtonV2
                      size="normal"
                      variant="neutral"
                      icon="reset"
                      disabled={machine.probing}
                      onClick={() => void reprobeFamily()}
                    >
                      {language.t(machine.probing ? "settings.toolchain.reprobing" : "settings.toolchain.reprobe")}
                    </ButtonV2>
                  </div>
                </div>
                <SettingsListV2>
                  <For each={view().tools}>
                    {(tool) => (
                      <ToolRow
                        tool={tool}
                        meta={toolMeta(tool.id)}
                        pathValue={machine.paths[tool.id] ?? ""}
                        saving={machine.saving === tool.id}
                        onPath={(value) => setMachine("paths", tool.id, value)}
                        onRecord={() => void recordFamilyPath(tool.id)}
                        onBrowse={browse((dir) => setMachine("paths", tool.id, dir))}
                        progress={installs[tool.id]}
                        onInstall={() => void installFamilyTool(tool)}
                        onCancelInstall={() => cancelInstall(tool.id)}
                      />
                    )}
                  </For>
                </SettingsListV2>
              </Show>
            )}
          </Show>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.toolchain.project.title")}</h3>
          <Show
            when={directory()}
            fallback={<p class="settings-v2-toolchain-note">{language.t("settings.toolchain.noProject")}</p>}
          >
            <Show when={status()} fallback={<p class="settings-v2-toolchain-note">…</p>}>
              {(view) => (
                <Show
                  when={view().declared}
                  fallback={
                    <Show
                      when={view().error}
                      fallback={<p class="settings-v2-toolchain-note">{language.t("settings.toolchain.notDeclared")}</p>}
                    >
                      <div class="settings-v2-toolchain-error">
                        <p>{language.t("settings.toolchain.parseError")}</p>
                        <pre>{view().error}</pre>
                      </div>
                    </Show>
                  }
                >
                  <div class="settings-v2-toolchain-summary">
                    <p class="settings-v2-toolchain-note">
                      {view().ok
                        ? language.t("settings.toolchain.allOk")
                        : language.t("settings.toolchain.attention", {
                            count: String(view().tools.filter((t) => t.status !== "ok" && !t.optional).length),
                          })}
                    </p>
                    <ButtonV2
                      size="normal"
                      variant="neutral"
                      icon="reset"
                      disabled={project.probing}
                      onClick={() => void reprobeProject()}
                    >
                      {language.t(project.probing ? "settings.toolchain.reprobing" : "settings.toolchain.reprobe")}
                    </ButtonV2>
                  </div>
                  <SettingsListV2>
                    <For each={view().tools}>
                      {(tool) => (
                        <ToolRow
                          tool={tool}
                          pathValue={project.paths[tool.id] ?? ""}
                          saving={project.saving === tool.id}
                          onPath={(value) => setProject("paths", tool.id, value)}
                          onRecord={() => void recordProjectPath(tool.id)}
                          onBrowse={browse((dir) => setProject("paths", tool.id, dir))}
                          progress={installs[tool.id]}
                          onInstall={() => void installProjectTool(tool)}
                          onCancelInstall={() => cancelInstall(tool.id)}
                        />
                      )}
                    </For>
                  </SettingsListV2>
                </Show>
              )}
            </Show>
          </Show>
        </div>
      </div>
    </>
  )
}
