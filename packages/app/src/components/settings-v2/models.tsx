import { useFilteredList } from "@yoma-desktop/ui/hooks"
import { ProviderIcon } from "@yoma-desktop/ui/provider-icon"
import { Switch } from "@yoma-desktop/ui/v2/switch-v2"
import { Icon as IconV2 } from "@yoma-desktop/ui/v2/icon"
import { IconButtonV2 } from "@yoma-desktop/ui/v2/icon-button-v2"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { TextInputV2 } from "@yoma-desktop/ui/v2/text-input-v2"
import { type Component, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { refreshProviderCatalog } from "@/components/kernel-providers"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const PROVIDER_ICON_SIZE = 16

/**
 * 模型列表里哪些厂商排前面。唯一的用处就是这个排序 —— 原来它住在 `hooks/use-providers.ts`
 * 里,那个文件是 opencode 的 provider 目录(内核没有,已整体删掉),只剩这个常量值得留。
 */
const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]

export const SettingsModelsV2: Component = () => {
  const language = useLanguage()
  const models = useModels()
  const [refreshing, setRefreshing] = createSignal(false)

  /**
   * 联网重新拉各家的模型目录。
   *
   * 需要这个按钮的理由:内建目录是随版本冻结的快照,厂商上新比我们发版快 —— 不点它,新出的模型
   * 永远不会自己出现在列表里(开会话只恢复磁盘缓存,不联网)。失败不弹错:一家的目录接口挂了
   * 不影响别家,内核那边已经逐条发过诊断。
   */
  const refresh = async () => {
    if (refreshing()) return
    setRefreshing(true)
    try {
      await refreshProviderCatalog()
    } finally {
      setRefreshing(false)
    }
  }

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="flex items-center justify-between gap-2">
          <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
          {/* 图标集里没有 refresh,用文字按钮 —— 这个动作本来也值得一句话说清它会联网。 */}
          <ButtonV2 size="normal" variant="ghost-muted" disabled={refreshing()} onClick={() => void refresh()}>
            {language.t(refreshing() ? "settings.models.refreshing" : "settings.models.refresh")}
          </ButtonV2>
        </div>
        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={list.filter()}
            onInput={(event) => list.onInput(event.currentTarget.value)}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("dialog.model.search.placeholder")}
          />
          <Show when={list.filter()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-v2-tab-search-clear"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => list.clear()}
            />
          </Show>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-models">
        <Show
          when={!list.grouped.loading}
          fallback={
            <div class="settings-v2-models-status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={
              <div class="settings-v2-models-status">
                <span>{language.t("dialog.model.empty")}</span>
                <Show when={list.filter()}>
                  <span class="settings-v2-models-status-filter">&quot;{list.filter()}&quot;</span>
                </Show>
              </div>
            }
          >
            <For each={list.grouped.latest}>
              {(group) => (
                <div class="settings-v2-section" data-component="settings-models-provider">
                  <div class="settings-v2-models-group-header">
                    <ProviderIcon
                      id={group.category}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-models-provider-icon shrink-0"
                    />
                    <h3 class="settings-v2-section-title">{group.items[0].provider.name}</h3>
                  </div>
                  <SettingsListV2>
                    <For each={group.items}>
                      {(item) => {
                        const key = { providerID: item.provider.id, modelID: item.id }
                        return (
                          <SettingsRowV2 title={item.name} description="">
                            <div>
                              <Switch
                                checked={models.visible(key)}
                                onChange={(checked) => {
                                  models.setVisibility(key, checked)
                                }}
                                hideLabel
                              >
                                {item.name}
                              </Switch>
                            </div>
                          </SettingsRowV2>
                        )
                      }}
                    </For>
                  </SettingsListV2>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </>
  )
}
