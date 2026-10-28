import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"
import { Type } from "typebox"
import { createModels } from "@earendil-works/pi-ai"
import { FileCredentialStore, NO_AMBIENT_AUTH, resolveModel } from "./models.ts"
import {
  customProvider,
  readCustomProviders,
  removeCustomProvider,
  saveCustomProvider,
  discoverCustomModels,
} from "./custom-providers.ts"

const dirs: string[] = []
const config = {
  name: "Test gateway",
  baseUrl: "https://gateway.example/v1",
  modelIds: ["test-model", "second-model"],
  contextWindow: 32768,
  maxOutput: 4096,
}
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "yoma-custom-"))
  dirs.push(dir)
  return { dir, file: path.join(dir, "auth.json"), store: new FileCredentialStore(path.join(dir, "auth.json")) }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("model discovery uses /models and the matching stored key, without saving or leaking credentials", async () => {
  const { store, file } = setup()
  const calls: Array<{ url?: string; authorization?: string }> = []
  const server = createServer((req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization })
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ id: "second" }, { id: "first" }, { id: "first" }, { id: "bad id" }, null] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    await saveCustomProvider(store, { ...config, baseUrl, apiKey: "stored-only-key" })
    const [saved] = await readCustomProviders(store)
    const original = readFileSync(file, "utf8")
    const ids = await discoverCustomModels(store, { baseUrl, providerID: saved!.id })
    expect(ids).toEqual(["first", "second"])
    expect(calls).toEqual([{ url: "/v1/models", authorization: "Bearer stored-only-key" }])
    expect(readFileSync(file, "utf8")).toBe(original)
    await expect(discoverCustomModels(store, { baseUrl: `${baseUrl}/other`, providerID: saved!.id })).rejects.toThrow(
      "API key",
    )
    expect(calls).toHaveLength(1)
    await expect(
      discoverCustomModels(
        store,
        { baseUrl, apiKey: "explicit-key" },
        async () => new Response("secret response body", { status: 401 }),
      ),
    ).rejects.toThrow("HTTP 401")
    expect(readFileSync(file, "utf8")).toBe(original)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("custom configuration and key survive reopen, editing and deletion without changing other credentials", async () => {
  const { dir, store, file } = setup()
  await store.modify("deepseek", async () => ({ type: "api_key", key: "unrelated-secret" }))
  await saveCustomProvider(store, { ...config, apiKey: "gateway-secret" })
  const reopened = new FileCredentialStore(file)
  const [saved] = await readCustomProviders(reopened)
  const resolved = await resolveModel(dir, { provider: saved!.id, authContext: NO_AMBIENT_AUTH })
  expect(resolved.models.getModels(saved!.id).map((m) => m.id)).toEqual(config.modelIds)
  await saveCustomProvider(reopened, { ...config, providerID: saved!.id, name: "Renamed", apiKey: "" })
  expect((await reopened.read(saved!.id))?.type).toBe("api_key")
  expect(await reopened.read(saved!.id)).toMatchObject({
    key: "gateway-secret",
    yomaCustomProvider: { name: "Renamed" },
  })
  await expect(
    saveCustomProvider(reopened, { ...config, providerID: saved!.id, baseUrl: "https://other.example/v1" }),
  ).rejects.toThrow("API key")
  expect((await readCustomProviders(reopened))[0]?.config.name).toBe("Renamed")
  await saveCustomProvider(reopened, {
    ...config,
    providerID: saved!.id,
    baseUrl: "https://other.example/v1",
    apiKey: "new-secret",
  })
  expect(await reopened.read(saved!.id)).toMatchObject({
    key: "new-secret",
    yomaCustomProvider: { baseUrl: "https://other.example/v1" },
  })
  await removeCustomProvider(reopened, saved!.id)
  expect(await readCustomProviders(reopened)).toEqual([])
  expect(await reopened.read("deepseek")).toEqual({ type: "api_key", key: "unrelated-secret" })
})

test("invalid input cannot overwrite a built-in provider or a corrupt credential file", async () => {
  const { store, file } = setup()
  for (const invalid of [
    { name: " " },
    { baseUrl: "file:///tmp/key" },
    { baseUrl: "https://user:secret@gateway.example/v1" },
    { baseUrl: "https://gateway.example/v1?api_key=secret" },
    { modelIds: [] },
    { modelIds: ["duplicate", "duplicate"] },
    { modelIds: ["has space"] },
    { contextWindow: -1 },
    { maxOutput: 32769 },
    { maxOutput: 1.5 },
    { providerID: "openai" },
  ])
    await expect(saveCustomProvider(store, { ...config, apiKey: "test-key", ...invalid })).rejects.toThrow()
  await expect(removeCustomProvider(store, "openai")).rejects.toThrow()
  writeFileSync(file, "{broken", "utf8")
  await expect(saveCustomProvider(store, { ...config, apiKey: "test-key" })).rejects.toThrow("auth.json")
  expect(readFileSync(file, "utf8")).toBe("{broken")
})

test("concurrent edits retain both custom providers and an API key", async () => {
  const { store, file } = setup()
  await Promise.all([
    saveCustomProvider(store, { ...config, apiKey: "first" }),
    saveCustomProvider(new FileCredentialStore(file), { ...config, name: "Second", apiKey: "second" }),
    new FileCredentialStore(file).modify("deepseek", async () => ({ type: "api_key", key: "third" })),
  ])
  expect(await readCustomProviders(store)).toHaveLength(2)
  expect(await store.read("deepseek")).toMatchObject({ key: "third" })
})

test("Pi sends the endpoint, model, key and tools over HTTP and parses streamed text and tool calls", async () => {
  const { store } = setup()
  const requests: Array<{ url?: string; auth?: string; body: Record<string, unknown> }> = []
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
    if (req.headers.authorization !== "Bearer test-key") {
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "Invalid key" } }))
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const delta =
      requests.length === 1
        ? { role: "assistant", content: "gateway works" }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_read",
                type: "function",
                function: { name: "read", arguments: '{"path":"README.md"}' },
              },
            ],
          }
    for (const choice of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: requests.length === 1 ? "stop" : "tool_calls" },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "chat-test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, ...choice }] })}\n\n`,
      )
    res.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address() as { port: number }
    const local = { ...config, baseUrl: `http://127.0.0.1:${address.port}/v1` }
    await saveCustomProvider(store, { ...local, apiKey: "test-key" })
    const [saved] = await readCustomProviders(store)
    const models = createModels({ credentials: store, authContext: NO_AMBIENT_AUTH })
    models.setProvider(customProvider(saved!.id, saved!.config))
    const model = models.getModel(saved!.id, "test-model")!
    const context = {
      messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }],
      tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
    }
    const reply = await models.completeSimple(model, context)
    expect(reply.content).toContainEqual({ type: "text", text: "gateway works" })
    const tool = await models.completeSimple(model, context)
    expect(tool.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "README.md" } }),
    )
    expect(requests[0]).toMatchObject({
      url: "/v1/chat/completions",
      auth: "Bearer test-key",
      body: { model: "test-model", stream: true, tools: [expect.objectContaining({ type: "function" })] },
    })
    await saveCustomProvider(store, { ...local, providerID: saved!.id, apiKey: "wrong-key" })
    const bad = await models.completeSimple(model, context)
    expect(bad.stopReason).toBe("error")
    expect(bad.errorMessage).toContain("Invalid key")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
