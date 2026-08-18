/**
 * 工具链核账页(设置 → 工具链)。
 *
 * 项目声明的 `.my-pi/toolchain.json` 对上这台机器实际装了什么:后端是内核的
 * `toolchain.status` / `toolchain.set` 两个 RPC(kernel/src/host/toolchain.ts),
 * 与 agent 的 toolchain 工具共用同一套探测与验证 —— 这里打的勾就是系统提示词里
 * agent 看到的那份账,填进去的路径 agent 下个会话自动认得(本机账本 by:"user")。
 *
 * 三种形态,由 ToolchainStatusView 的 declared/error 区分:没声明清单(绝大多数
 * 项目)给引导文案;清单坏了把解析错误原文摆出来(设置页正是排查它的地方);正常
 * 核账逐工具一行,MISSING/版本不符的行带安装指引 + 手填路径输入框。
 *
 * 工程目录来自当前路由(`params.dir`,base64)—— 设置对话框叠在工程路由上打开时
 * 才有;从主页打开时没有目录,只能显示"先打开一个工程"。
 */

import { createMemo, createResource, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { TextInputV2 } from "@yoma-desktop/ui/v2/text-input-v2"
import { Icon } from "@yoma-desktop/ui/icon"
import type { ToolchainResolvedTool } from "@yoma-desktop/kernel"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { kernel } from "@/utils/kernel"
import { decode64 } from "@/utils/base64"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

const primaryBin = (tool: ToolchainResolvedTool) => Object.values(tool.bin)[0]

export const SettingsToolchainV2: Component = () => {
  const language = useLanguage()
  const params = useParams()
  const directory = createMemo(() => decode64(params.dir) ?? "")

  const [status, { mutate }] = createResource(directory, (dir) =>
    dir ? kernel.toolchain.status({ directory: dir }) : undefined,
  )
  const [state, setState] = createStore({
    paths: {} as Record<string, string>,
    saving: undefined as string | undefined,
    probing: false,
  })

  const failToast = (err: unknown) =>
    showToast({
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })

  const reprobe = async () => {
    const dir = directory()
    if (!dir || state.probing) return
    setState("probing", true)
    try {
      mutate(await kernel.toolchain.status({ directory: dir, fresh: true }))
    } catch (err) {
      failToast(err)
    } finally {
      setState("probing", false)
    }
  }

  const record = async (id: string) => {
    const dir = directory()
    const path = state.paths[id]?.trim()
    if (!dir || !path || state.saving) return
    setState("saving", id)
    try {
      mutate(await kernel.toolchain.set({ directory: dir, id, path }))
      setState("paths", id, "")
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.toolchain.toast.recorded", { id }),
      })
    } catch (err) {
      failToast(err)
    } finally {
      setState("saving", undefined)
    }
  }

  const statusLabel = (tool: ToolchainResolvedTool) => language.t(`settings.toolchain.status.${tool.status}`)

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.toolchain.title")}</h2>
      </div>

      <div class="settings-v2-tab-body">
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
                <div class="settings-v2-section">
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
                      disabled={state.probing}
                      onClick={() => void reprobe()}
                    >
                      {language.t(state.probing ? "settings.toolchain.reprobing" : "settings.toolchain.reprobe")}
                    </ButtonV2>
                  </div>
                  <SettingsListV2>
                    <For each={view().tools}>
                      {(tool) => (
                        <div class="settings-v2-toolchain-row" data-status={tool.status}>
                          <div class="settings-v2-toolchain-row-head">
                            <Icon
                              name={tool.status === "ok" ? "circle-check" : "warning"}
                              class="settings-v2-toolchain-icon"
                              data-ok={tool.status === "ok"}
                            />
                            <span class="settings-v2-toolchain-name">{tool.id}</span>
                            <Show when={tool.optional}>
                              <span class="settings-v2-toolchain-tag">{language.t("settings.toolchain.optional")}</span>
                            </Show>
                            <span class="settings-v2-toolchain-status">{statusLabel(tool)}</span>
                            <Show when={tool.version}>
                              <span class="settings-v2-toolchain-version">{tool.version}</span>
                            </Show>
                            <Show when={tool.wanted}>
                              <span class="settings-v2-toolchain-wanted">
                                {language.t("settings.toolchain.wanted", { version: tool.wanted! })}
                              </span>
                            </Show>
                          </div>

                          <Show when={tool.status === "ok" && primaryBin(tool)}>
                            <div class="settings-v2-toolchain-path">
                              {primaryBin(tool)}
                              <Show when={tool.source}> · {tool.source}</Show>
                            </div>
                          </Show>

                          <Show when={tool.status === "ambiguous" && tool.candidates?.length}>
                            <div class="settings-v2-toolchain-candidates">
                              {language.t("settings.toolchain.candidates")}
                              <For each={tool.candidates}>{(candidate) => <div>{candidate}</div>}</For>
                            </div>
                          </Show>

                          <Show when={tool.status !== "ok"}>
                            <Show when={tool.hint}>
                              <div class="settings-v2-toolchain-hint">{tool.hint}</div>
                            </Show>
                            <div class="settings-v2-toolchain-set">
                              <TextInputV2
                                value={state.paths[tool.id] ?? ""}
                                onInput={(event) => setState("paths", tool.id, event.currentTarget.value)}
                                placeholder={language.t("settings.toolchain.pathPlaceholder")}
                              />
                              <ButtonV2
                                size="normal"
                                variant="neutral"
                                disabled={!state.paths[tool.id]?.trim() || state.saving === tool.id}
                                onClick={() => void record(tool.id)}
                              >
                                {language.t(
                                  state.saving === tool.id ? "settings.toolchain.recording" : "settings.toolchain.record",
                                )}
                              </ButtonV2>
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </SettingsListV2>
                </div>
              </Show>
            )}
          </Show>
        </Show>
      </div>
    </>
  )
}
