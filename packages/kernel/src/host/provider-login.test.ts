import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuthInteraction, OAuthCredential, Provider } from "@earendil-works/pi-ai"
import { afterEach, expect, it, vi } from "vitest"
import type { AuthLoginView } from "../auth-view.ts"
import { FileCredentialStore } from "./models.ts"
import { ProviderLogin } from "./provider-login.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const credential: OAuthCredential = {
  type: "oauth",
  access: "test-access-secret",
  refresh: "test-refresh-secret",
  expires: Date.now() + 3600000,
}

function setup(login: (interaction: AuthInteraction) => Promise<OAuthCredential>) {
  const dir = mkdtempSync(join(tmpdir(), "yoma-login-"))
  dirs.push(dir)
  const path = join(dir, "auth.json")
  const store = new FileCredentialStore(path)
  const events: AuthLoginView[] = []
  const connected = vi.fn(async () => {})
  const controller = new ProviderLogin({
    store,
    connected,
    emit: (view) => events.push(view),
    provider: { id: "openai-codex", auth: { oauth: { login } } } as Provider,
  })
  return { controller, store, events, connected, path }
}

it("relays native browser/manual callback prompts and persists only on success", async () => {
  const s = setup(async (interaction) => {
    expect(
      await interaction.prompt({
        type: "select",
        message: "Method",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device code" },
        ],
      }),
    ).toBe("browser")
    interaction.notify({ type: "auth_url", url: "https://auth.openai.com/test", instructions: "Authorize in browser" })
    expect(
      await interaction.prompt({ type: "manual_code", message: "Paste callback", signal: interaction.signal }),
    ).toBe("http://localhost/callback?code=fake")
    return credential
  })
  await s.store.modify("deepseek", async () => ({ type: "api_key", key: "keep" }))
  const start = s.controller.start("openai-codex")
  await vi.waitFor(() => expect(s.controller.status(start.id).prompt?.type).toBe("manual_code"))
  const prompt = s.controller.status(start.id).prompt!
  s.controller.reply(start.id, prompt.id, "http://localhost/callback?code=fake")
  await vi.waitFor(() => expect(s.controller.status(start.id).status).toBe("success"))
  expect(await s.store.read("openai-codex")).toEqual(credential)
  expect(await s.store.read("deepseek")).toEqual({ type: "api_key", key: "keep" })
  expect(s.connected).toHaveBeenCalledOnce()
  expect(JSON.stringify(s.events)).not.toMatch(/test-access-secret|test-refresh-secret/)
  expect(() => s.controller.reply(start.id, prompt.id, "replay")).toThrow("expired")
})

it("supports the native device-code method and removes a manual prompt when the callback wins", async () => {
  const s = setup(async (interaction) => {
    expect(
      await interaction.prompt({
        type: "select",
        message: "Method",
        options: [{ id: "device_code", label: "Device" }],
      }),
    ).toBe("device_code")
    interaction.notify({
      type: "device_code",
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "FAKE-CODE",
      expiresInSeconds: 900,
    })
    const step = new AbortController()
    const pending = interaction
      .prompt({ type: "manual_code", message: "Optional", signal: step.signal })
      .catch(() => undefined)
    step.abort()
    await pending
    return credential
  })
  const start = s.controller.start("openai-codex", "device_code")
  await vi.waitFor(() => expect(s.controller.status(start.id).status).toBe("success"))
  expect(s.events.some((v) => v.notice?.userCode === "FAKE-CODE")).toBe(true)
  expect(s.controller.status(start.id).prompt).toBeUndefined()
})

it.each(["cancel", "expired", "failure"])(
  "%s preserves the prior credential and never emits provider error bodies",
  async (outcome) => {
    let finish!: (value: OAuthCredential) => void
    const s = setup(async (interaction) => {
      if (outcome !== "cancel") throw new Error(`invalid_grant ${credential.refresh}`)
      await interaction.prompt({ type: "manual_code", message: "Callback" }).catch(() => {})
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    await s.store.modify("openai-codex", async () => credential)
    const before = readFileSync(s.path, "utf8")
    const start = s.controller.start("openai-codex")
    if (outcome === "cancel") {
      expect(() => s.controller.start("openai-codex")).toThrow("already")
      s.controller.cancel(start.id)
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
      finish({ ...credential, access: "new-secret" })
    }
    await vi.waitFor(() =>
      expect(s.controller.status(start.id).status).toBe(outcome === "cancel" ? "cancelled" : "failed"),
    )
    expect(readFileSync(s.path, "utf8")).toBe(before)
    expect(JSON.stringify(s.events)).not.toContain(credential.refresh)
    expect(s.connected).not.toHaveBeenCalled()
  },
)
