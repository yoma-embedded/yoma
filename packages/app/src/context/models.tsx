import { type Accessor, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@yoma-desktop/ui/context"
import { createProviderCatalog } from "@/components/kernel-providers"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  // directory 保留在签名里但不再使用:my-pi 的模型目录是进程级的,没有"这个工作目录用哪些
  // provider"这一层(opencode 的 per-directory config 没有对应物)。
  init: (_props: { directory?: Accessor<string | undefined> } = {}) => {
    // 必须用 createProviderCatalog 而不是一次性的 createResource:后者是挂载时的快照,
    // 首跑先挂载、后配 key,快照里 authenticated 永远是 false,模型选不中且无法自愈
    // (实测踩过)。catalog 订阅 invalidateProviders() 总线,auth.set 之后自动重拉。
    const catalog = createProviderCatalog()

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    // 只列已配置凭据的 provider —— 顶替原来的 providers.connected()。
    const available = createMemo(() =>
      catalog()
        .filter((provider) => provider.authenticated)
        .flatMap((provider) => provider.models.map((model) => ({ ...model, provider }))),
    )

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    // 原来的默认可见性靠 release_date + family 算"每个系列最新的、半年内发布的模型"。
    // 内核的 ModelInfo 没有发布日期也没有系列,这个启发式没有输入了 —— 默认全显示,
    // 用户显式隐藏的才藏起来。
    const visible = (model: ModelKey) => visibility().get(modelKey(model)) !== "hide"

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    const [recentModels] = createResource(
      async () => {
        const recent = store.recent
        await ready.promise
        return recent
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      /** 原始 provider 目录(含未认证的),活数据 —— local.tsx 的模型校验用它,别再碰 opencode 的 useProviders 空壳。 */
      providers: catalog,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: () => recentModels()!,
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
