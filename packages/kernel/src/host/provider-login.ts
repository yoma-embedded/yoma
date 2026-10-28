import { randomUUID } from "node:crypto"
import type { AuthPrompt, Provider } from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"
import type { AuthLoginView } from "../auth-view.ts"
import { FileCredentialStore } from "./models.ts"

// Pi's public bundle hook also works in Electron: variable imports otherwise resolve beside kernel.js.
registerBunOAuthFlows()

type Login = {
  view: AuthLoginView
  controller: AbortController
  committing?: boolean
  reply?: { id: string; resolve(value: string): void; reject(reason: unknown): void }
}

/** One native Pi login at a time; retained state lets a reattached renderer recover the prompt. */
export class ProviderLogin {
  private current?: Login

  constructor(
    private readonly options: {
      store: FileCredentialStore
      emit(view: AuthLoginView): void
      connected(): Promise<void>
      provider?: Provider
    },
  ) {}

  start(providerID: string, method: "browser" | "device_code" = "browser"): AuthLoginView {
    if (providerID !== "openai-codex") throw new Error("Subscription login is only available for OpenAI Codex")
    if (method !== "browser" && method !== "device_code") throw new Error("Unknown login method")
    if (this.current?.view.status === "pending") throw new Error("A login is already in progress")
    const provider = this.options.provider ?? builtinProviders().find((p) => p.id === providerID)
    if (!provider?.auth.oauth) throw new Error("Subscription login is unavailable")
    const login: Login = {
      view: { id: randomUUID(), providerID, status: "pending" },
      controller: new AbortController(),
    }
    this.current = login
    this.publish(login)
    void (async () => {
      try {
        const credential = await provider.auth.oauth!.login({
          signal: login.controller.signal,
          prompt: (prompt) => {
            if (prompt.type === "select" && prompt.options.some((o) => o.id === method)) return Promise.resolve(method)
            return this.prompt(login, prompt)
          },
          notify: (notice) => {
            if (login.controller.signal.aborted) return
            login.view.notice =
              notice.type === "auth_url"
                ? { type: notice.type, url: notice.url, message: notice.instructions }
                : notice.type === "device_code"
                  ? { type: notice.type, url: notice.verificationUri, userCode: notice.userCode }
                  : { type: notice.type, message: notice.message }
            this.publish(login)
          },
        })
        login.controller.signal.throwIfAborted()
        await this.options.store.modify(providerID, async () => {
          login.controller.signal.throwIfAborted()
          // Once the locked atomic commit starts, cancellation cannot undo a saved credential.
          login.committing = true
          return credential
        }, { signal: login.controller.signal })
        if (login.controller.signal.aborted) return
        login.view = { id: login.view.id, providerID, status: "success" }
        const connected = this.options.connected()
        this.publish(login)
        // The exchange succeeded; a catalog refresh failure must not misreport a saved login as failed.
        await connected.catch(() => undefined)
      } catch {
        if (login.controller.signal.aborted) return
        // Provider errors can contain response bodies or tokens. Never serialize them to the renderer/log.
        login.view = {
          id: login.view.id,
          providerID,
          status: "failed",
          error: "Login failed. Retry or use device code login.",
        }
      } finally {
        login.reply?.reject(new Error("Login ended"))
        login.reply = undefined
        this.publish(login)
      }
    })()
    return structuredClone(login.view)
  }

  status(id: string): AuthLoginView
  status(id?: string): AuthLoginView | undefined
  status(id?: string): AuthLoginView | undefined {
    return structuredClone(id ? this.find(id).view : this.current?.view)
  }

  reply(id: string, promptID: string, value: string): void {
    const login = this.find(id)
    if (login.view.status !== "pending" || login.reply?.id !== promptID) throw new Error("Login prompt has expired")
    if (typeof value !== "string" || !value.trim() || value.length > 16_384) throw new Error("Invalid login response")
    const prompt = login.view.prompt
    if (prompt?.type === "select" && !prompt.options?.some((o) => o.id === value))
      throw new Error("Invalid login option")
    login.reply.resolve(value.trim())
  }

  cancel(id?: string, closing = false): void {
    const login = id ? this.find(id) : this.current
    if (!login || login.view.status !== "pending") return
    if (login.committing && !closing) return
    login.controller.abort()
    login.reply?.reject(new Error("Login cancelled"))
    login.view = { id: login.view.id, providerID: login.view.providerID, status: "cancelled" }
    this.publish(login)
  }

  private find(id: string): Login {
    if (!this.current || this.current.view.id !== id) throw new Error("Login has expired")
    return this.current
  }

  private publish(login: Login): void {
    this.options.emit(structuredClone(login.view))
  }

  private prompt(login: Login, prompt: AuthPrompt): Promise<string> {
    const signal = prompt.signal ? AbortSignal.any([prompt.signal, login.controller.signal]) : login.controller.signal
    signal.throwIfAborted()
    const id = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const finish = (value?: string) => {
        signal.removeEventListener("abort", abort)
        if (login.reply?.id === id) {
          login.reply = undefined
          delete login.view.prompt
          this.publish(login)
        }
        if (value === undefined) reject(new Error("Login prompt cancelled"))
        else resolve(value)
      }
      const abort = () => finish()
      signal.addEventListener("abort", abort, { once: true })
      login.reply = { id, resolve: (value) => finish(value), reject: () => finish() }
      login.view.prompt = {
        id,
        type: prompt.type,
        message: prompt.message,
        ...(prompt.type === "select"
          ? { options: prompt.options.map((o) => ({ ...o })) }
          : { placeholder: prompt.placeholder }),
      }
      this.publish(login)
    })
  }
}
