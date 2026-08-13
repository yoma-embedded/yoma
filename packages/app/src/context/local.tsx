import { createSimpleContext } from "@yoma-desktop/ui/context"
import { base64Encode } from "@yoma-desktop/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { Persist, persisted } from "@/utils/persist"
import { cycleModelVariant, resolveThinkingVariant } from "./model-variant"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useServerSDK } from "./server-sdk"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

type State = {
  model?: ModelKey
  /** 内核里这就是 thinking level(off/low/high…),沿用 variant 这个名字是因为存档键已经这么写了。 */
  variant?: string | null
}

type Saved = {
  session: Record<string, State | undefined>
}

const WORKSPACE_KEY = "__workspace__"
const handoff = new Map<string, State>()

const handoffKey = (scope: ServerScope, dir: string, id: string) => ScopedKey.from(scope, dir, id)

const migrate = (value: unknown) => {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }

  if (item.session && typeof item.session === "object") return { session: item.session }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }

  return {
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
  }
}

const clone = (value: State | undefined) => {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies State
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useSDK()
    const sync = useSync()
    const serverSDK = useServerSDK()
    const models = useModels()

    const id = createMemo(() => params.id || undefined)

    const [saved, setSaved] = persisted(
      {
        ...Persist.serverWorkspace(serverSDK().scope, sdk().directory, "model-selection", ["model-selection.v1"]),
        migrate,
      },
      createStore<Saved>({
        session: {},
      }),
    )

    const [store, setStore] = createStore<{
      draft?: State
      promoting?: State
      last?: {
        type: "model" | "variant"
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      draft: undefined,
      last: undefined,
    })

    // 校验必须问内核目录(useModels().providers,活数据),**不能**问 opencode 时代的
    // useProviders 空壳:那套数据来自 server-sync,my-pi 内核永远不会喂它 —— 老 userData
    // 里有 opencode 缓存"碰巧能用",全新用户 connected 恒为空,选什么都被静默丢弃,
    // 表现为"模型一直选不中"(实测踩过)。
    const validModel = (model: ModelKey) => {
      const provider = models.providers().find((item) => item.id === model.providerID)
      if (!provider?.authenticated) return false
      return provider.models.some((item) => item.id === model.modelID)
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
    }


    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft ?? store.promoting
      return saved.session[session] ?? handoff.get(handoffKey(serverSDK().scope, sdk().directory, session))
    })

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(serverSDK().scope, sdk().directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        setStore("promoting", undefined)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
      setStore("promoting", undefined)
    })

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
    }

    // opencode 的 per-provider 默认模型来自它的 config 服务,内核没有对应物 ——
    // 这里的 UI 默认就取第一个已认证 provider 的第一个模型(目录顺序即 my-pi
    // PROVIDERS 表顺序);真正发请求时的内核默认(~/.pi/agent/settings.json)不受影响。
    const defaultModel = () => {
      for (const provider of models.providers()) {
        if (!provider.authenticated) continue
        const first = provider.models[0]
        if (first) return { providerID: provider.id, modelID: first.id }
      }
    }

    const fallback = createMemo<ModelKey | undefined>(() => recentModel() ?? defaultModel())

    const current = () => {
      const item = firstModel(() => scope()?.model, fallback)
      if (!item) return
      return models.find(item)
    }

    // 内核没有 agent,也就没有"agent 配置的默认 thinking level"这一层。
    const configured = () => undefined

    const selected = () => scope()?.variant

    const snapshot = () => {
      const model = current()
      return {
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...(scope() ?? {}),
        ...next,
      } satisfies State

      const session = id()
      if (session) {
        setSaved("session", session, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      current,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        startTransition(() =>
          batch(() => {
            setStore("last", {
              type: "model",
              model: item ?? null,
              variant: selected(),
            })
            write({ model: item })
            if (!item) return
            models.setVisibility(item, true)
            if (!options?.recent) return
            models.recent.push(item)
          }),
        )
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          const model = current()
          const saved = model ? models.variant.get({ providerID: model.provider.id, modelID: model.id }) : undefined
          return resolveThinkingVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
            saved,
          })
        },
        list() {
          return current()?.thinkingLevels ?? []
        },
        set(value: string | undefined) {
          startTransition(() =>
            batch(() => {
              const model = current()
              setStore("last", {
                type: "variant",
                model: model ? { providerID: model.provider.id, modelID: model.id } : null,
                variant: value ?? null,
              })
              write({ variant: value ?? null })
              if (model) {
                models.variant.set({ providerID: model.provider.id, modelID: model.id }, value ?? undefined)
              }
            }),
          )
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          const next = cycleModelVariant({
            variants: items,
            selected: this.current(),
            configured: this.configured(),
          })
          // 末档再循环回第一档,不要清成 undefined。
          this.set(next ?? items[0])
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk().directory)),
      model,
      session: {
        reset() {
          setStore({ draft: undefined, promoting: undefined })
        },
        promote(dir: string, session: string) {
          const next = clone(snapshot())
          if (!next) return
          const key = handoffKey(serverSDK().scope, dir, session)
          handoff.set(key, next)

          if (dir === sdk().directory) {
            setSaved("session", session, next)
          }

          setStore("promoting", next)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; model: ModelKey }) {
          const session = id()
          if (!session) return
          if (msg.sessionID !== session) return
          if (saved.session[session] !== undefined) return
          if (handoff.has(handoffKey(serverSDK().scope, sdk().directory, session))) return

          setSaved("session", session, {
            model: msg.model,
            variant: msg.model?.variant ?? null,
          })
        },
      },
    }
    return result
  },
})
