import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "vitest"
import { FileCredentialStore } from "./models.ts"
import { readSubscriptionUsage, subscriptionUsage } from "./provider-usage.ts"

test("usage keeps zero distinct from unavailable and returns only public summary fields", () => {
  const result = subscriptionUsage({
    plan_type: "plus",
    rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1800000000 } },
    additional_rate_limits: [
      { limit_name: "Extra", rate_limit: { secondary_window: { used_percent: 72, limit_window_seconds: 604800 } } },
    ],
    credits: { unlimited: false, balance: "0" },
    access_token: "must-not-leak",
  })
  expect(result).toMatchObject({
    status: "ready",
    plan: "plus",
    windows: [
      { usedPercent: 0, windowMinutes: 300, resetsAt: 1800000000 },
      { name: "Extra", usedPercent: 72, windowMinutes: 10080 },
    ],
    credits: { balance: "0" },
  })
  expect(JSON.stringify(result)).not.toContain("must-not-leak")
  expect(subscriptionUsage({ rate_limit: null }).status).toBe("unavailable")
  expect(subscriptionUsage({ rate_limit: { primary_window: { used_percent: null } } }).windows).toEqual([])
})

test("usage uses only Yoma's OAuth credential and hides authenticated error bodies", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yoma-usage-"))
  const store = new FileCredentialStore(path.join(dir, "auth.json"))
  try {
    expect(
      (
        await readSubscriptionUsage(store, async () => {
          throw new Error("must not fetch")
        })
      ).status,
    ).toBe("disconnected")
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 600_000,
      accountId: "test-account",
    }))
    let called = false
    const result = await readSubscriptionUsage(store, async (url, init) => {
      called = true
      expect(url).toBe("https://chatgpt.com/backend-api/wham/usage")
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-access", "ChatGPT-Account-Id": "test-account" })
      expect(init?.redirect).toBe("error")
      return Response.json({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000 } } })
    })
    expect(called).toBe(true)
    expect(result).toMatchObject({ status: "ready", windows: [{ usedPercent: 40 }] })
    const denied = await readSubscriptionUsage(
      store,
      async () => new Response("test-access secret error", { status: 403 }),
    )
    expect(denied).toMatchObject({ status: "unavailable", httpStatus: 403, windows: [] })
    expect(JSON.stringify(denied)).not.toContain("secret")
    expect(
      (
        await readSubscriptionUsage(store, async () => {
          throw new Error("test-access failed")
        })
      ).status,
    ).toBe("unavailable")
    expect(await store.read("openai-codex")).toMatchObject({ access: "test-access", refresh: "test-refresh" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
