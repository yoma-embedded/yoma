import type { AuthLoginView } from "@yoma-desktop/kernel"
import { Button } from "@yoma-desktop/ui/button"
import { TextField } from "@yoma-desktop/ui/text-field"
import { For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { kernel } from "@/utils/kernel"
import { invalidateProviders } from "./kernel-providers"

export function ProviderSubscriptionLogin(props: { connected(): void }) {
  const language = useLanguage()
  const platform = usePlatform()
  const [store, setStore] = createStore({
    login: undefined as AuthLoginView | undefined,
    value: "",
    error: "",
    starting: false,
  })
  let disposed = false
  let opened = ""
  const update = (login: AuthLoginView) => {
    if (disposed || (store.login && store.login.id !== login.id)) return
    if (store.login?.prompt?.id !== login.prompt?.id) setStore("value", "")
    setStore("login", login)
    if (login.notice?.type === "auth_url" && login.notice.url && opened !== login.notice.url) {
      opened = login.notice.url
      platform.openLink(opened)
    }
    if (login.status === "success") {
      invalidateProviders()
      props.connected()
    }
  }
  const unsubscribe = kernel.subscribe((events) => {
    for (const event of events) if (event.type === "auth.login") update(event.login)
  })
  onMount(() => {
    void kernel.model
      .loginStatus()
      .then((login) => {
        if (login?.status === "pending") update(login)
      })
      .catch(() => undefined)
  })
  onCleanup(() => {
    disposed = true
    unsubscribe()
    if (store.login?.status === "pending") void kernel.model.loginCancel(store.login.id).catch(() => undefined)
  })
  const start = async (method: "browser" | "device_code") => {
    setStore({ error: "", login: undefined, starting: true })
    try {
      const login = await kernel.model.loginStart({ providerID: "openai-codex", method })
      if (disposed) {
        await kernel.model.loginCancel(login.id)
        return
      }
      const current = await kernel.model.loginStatus(login.id)
      if (current) update(current)
    } catch {
      setStore("error", language.t("common.requestFailed"))
    } finally {
      setStore("starting", false)
    }
  }
  const reply = async (value: string) => {
    const login = store.login
    if (!login?.prompt) return
    try {
      await kernel.model.loginReply({ id: login.id, promptID: login.prompt.id, value })
    } catch {
      setStore("error", language.t("common.requestFailed"))
    }
  }
  return (
    <div class="flex flex-col gap-4" data-component="subscription-login">
      <p>{language.t("provider.connect.subscription.description")}</p>
      <Show
        when={store.login?.status === "pending"}
        fallback={
          <div class="flex gap-3">
            <Button disabled={store.starting} onClick={() => void start("browser")}>
              {language.t("provider.connect.subscription.browser")}
            </Button>
            <Button disabled={store.starting} variant="ghost" onClick={() => void start("device_code")}>
              {language.t("provider.connect.subscription.device")}
            </Button>
          </div>
        }
      >
        <p role="status">{store.login?.notice?.message ?? language.t("provider.connect.subscription.waiting")}</p>
        <Show when={store.login?.notice?.url}>
          {(url) => (
            <Button variant="secondary" onClick={() => platform.openLink(url())}>
              {language.t("provider.connect.subscription.open")}
            </Button>
          )}
        </Show>
        <Show when={store.login?.notice?.userCode}>{(code) => <code class="select-all">{code()}</code>}</Show>
        <Show when={store.login?.prompt}>
          {(prompt) => (
            <>
              <Show
                when={prompt().type === "select"}
                fallback={
                  <form
                    class="flex flex-col gap-3"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void reply(store.value)
                    }}
                  >
                    <TextField
                      label={prompt().message}
                      type={prompt().type === "secret" ? "password" : "text"}
                      value={store.value}
                      placeholder={prompt().placeholder}
                      onChange={(value) => setStore("value", value)}
                    />
                    <Button type="submit" disabled={!store.value.trim()}>
                      {language.t("common.continue")}
                    </Button>
                  </form>
                }
              >
                <p>{prompt().message}</p>
                <For each={prompt().options}>
                  {(option) => <Button onClick={() => void reply(option.id)}>{option.label}</Button>}
                </For>
              </Show>
            </>
          )}
        </Show>
        <Button
          variant="ghost"
          onClick={() =>
            void kernel.model
              .loginCancel(store.login!.id)
              .catch(() => setStore("error", language.t("common.requestFailed")))
          }
        >
          {language.t("common.cancel")}
        </Button>
      </Show>
      <Show when={store.error || store.login?.error}>
        <p role="alert">{store.error || store.login?.error}</p>
      </Show>
    </div>
  )
}
