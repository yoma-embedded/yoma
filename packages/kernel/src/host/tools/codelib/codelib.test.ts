import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { confirmNeeded, toolGuidelines } from "../contracts.ts"
import { createCodelibClient, sourceOf } from "./client.ts"
import { archivePath, extractArchive, materialize } from "./materialize.ts"
import { createCodelibTool, describeSearch } from "./session.ts"

const temps: string[] = []
const servers: Server[] = []
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), "yoma-codelib-test-")); temps.push(dir); return dir }
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const dir of temps.splice(0)) {
    if (!path.basename(dir).startsWith("yoma-codelib-test-")) throw new Error("Test cleanup boundary")
    await rm(dir, { recursive: true, force: true })
  }
})
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const identity = { corpusId: "example@main", corpusVersion: "a".repeat(64), revisionSha256: "b".repeat(64), indexSha256: "c".repeat(64), commit: "d".repeat(40), archiveSha256: "e".repeat(64), archiveBytes: 123 }

/** Independently construct tar headers so malicious names/types can be tested. */
function member(name: string, content = "", type = "0") {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write("0000600\0", 100)
  header.write("0000000\0", 108)
  header.write("0000000\0", 116)
  const data = Buffer.from(content)
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124)
  header.write("00000000000\0", 136)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write("ustar\0", 257)
  header.write("00", 263)
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148)
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)])
}
function tar(...members: Buffer[]) { return gzipSync(Buffer.concat([...members, Buffer.alloc(1024)])) }
function fakeArchive(bytes: Buffer) {
  return { archive: async (_id: string, _commit: string, _sha: string, consume: (res: Response) => Promise<unknown>) => consume(new Response(bytes)), json: vi.fn() } as unknown as ReturnType<typeof createCodelibClient>
}

describe("codelib review regression", () => {
  it.each(["corpusVersion", "indexSha256", "revisionSha256", "archiveSha256", "enrichSha256"])("requires a real string for source SHA %s", key => {
    for (const value of [["a".repeat(64)], { value: "a".repeat(64) }, 123]) {
      expect(() => sourceOf({ ...identity, [key]: value })).toThrow(key)
    }
  })
  it("accepts explicit null optional identities and validates enrich SHA when present", () => {
    expect(sourceOf({ ...identity, revisionSha256: null, archiveSha256: null, enrichSha256: null }).enrichSha256).toBeNull()
    expect(sourceOf({ ...identity, enrichSha256: "a".repeat(64) }).enrichSha256).toBe("a".repeat(64))
    expect(sourceOf(identity).enrichSha256).toBeUndefined()
    for (const enrichSha256 of ["", "short", "z".repeat(64), undefined]) expect(() => sourceOf({ ...identity, enrichSha256 })).toThrow("enrichSha256")
  })
  it.each([
    ["Dir/first.c", "dir/second.c"],
    ["Root/Dir/first.c", "Root/dir/second.c"],
    ["Root/Dir/first.c", "root/Dir/second.c"],
  ])("rejects implicit parent case alias %s and %s without publishing", async (first, second) => {
    const cwd = await temp()
    const bytes = tar(member(first, "one"), member(second, "two"))
    await expect(materialize(fakeArchive(bytes), cwd, "example", identity.commit, sha(bytes), null)).rejects.toThrow("alias")
    expect(await readdir(path.join(cwd, ".yoma/codelib"))).toEqual([])
  })
  it("allows same-spelling implicit parents followed by explicit directories", async () => {
    const cwd = await temp()
    const bytes = tar(member("Dir/Sub/first.c", "one"), member("Dir/", "", "5"), member("Dir/Sub/", "", "5"), member("Dir/Sub/second.c", "two"))
    const out = await materialize(fakeArchive(bytes), cwd, "example", identity.commit, sha(bytes), null)
    expect(await readFile(path.join(out, "Dir/Sub/first.c"), "utf8")).toBe("one")
    expect(await readFile(path.join(out, "Dir/Sub/second.c"), "utf8")).toBe("two")
  })
})

describe("codelib snapshot contract", () => {
  it("uses the kernel confirmation gate only for materialize and registers guidelines", () => {
    for (const action of ["search", "show", "catalog"]) expect(confirmNeeded("codelib", { action })).toBeUndefined()
    expect(confirmNeeded("codelib", { action: "materialize" })?.label).toBe("例程库")
    expect(toolGuidelines(["codelib"]).join(" ")).toContain("Never read latest metadata")
  })
  it("preserves server ranking, complete pins, null identities and actual engine", () => {
    const response = describeSearch({ hits: [{ score: 1, entry: { targets: [], buildable: false, buildNote: "generic 语料，未验证可编译" }, source: identity }, { score: 100, source: { ...identity, commit: null, archiveSha256: null, revisionSha256: null, archiveBytes: null } }], _meta: { actualEngine: "legacy", degraded: true } })
    expect(response.hits.map(hit => hit.score)).toEqual([1, 100])
    expect(response.hits[0]?.source).toEqual(identity)
    expect(response.hits[0]?.compatibility).toContain("兼容性未证实")
    expect(response.hits[0]?.buildNote).toContain("未验证可编译")
    expect(response._meta).toEqual({ actualEngine: "legacy", degraded: true })
    expect(response.hits[1]?.source.commit).toBeNull()
    expect(() => sourceOf({ ...identity, archiveBytes: undefined })).toThrow("archiveBytes")
    expect(() => sourceOf({ ...identity, indexSha256: undefined })).toThrow("indexSha256")
  })
  it("catalog accepts the existing bare array response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ id: "a" }])))
    expect(await createCodelibClient("http://localhost").json("/api/codelibs")).toEqual({ corpora: [{ id: "a" }] })
  })
  it("show calls a single pinned card endpoint and performs no disk writes", async () => {
    const cwd = await temp()
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ path: "src/example.c" }))
    vi.stubGlobal("fetch", fetch)
    const tool = createCodelibTool({ server: "http://localhost", env: {} })
    const result = await tool.execute("id", { action: "show", corpusId: "example@main", path: "src/example.c", revision: identity.revisionSha256 }, () => {}, { env: { cwd } } as never, undefined as never, {} as never)
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("example.c") })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toContain(`/entries/src/example.c?revision=${identity.revisionSha256}`)
    expect(await readdir(cwd)).toEqual([])
  })
  it("serializes every explicit old filter without inventing filters from queryText", async () => {
    const cwd = await temp()
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ hits: [], corpora: [], query: {} }))
    vi.stubGlobal("fetch", fetch)
    const tool = createCodelibTool({ server: "http://localhost", env: {} })
    const params = { action: "search" as const, queryText: "original intent", ecosystem: "generic", board: "board-a", target: "stm32f4", peripherals: ["uart"], keywords: ["dma"], tier: "all", entryKind: ["project", "lib"], buildableOnly: false, corpora: ["a"], limit: 7 }
    await tool.execute("id", params, () => {}, { env: { cwd } } as never, undefined as never, {} as never)
    const { action: _action, ...expected } = params
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(expected)
    expect(await readdir(cwd)).toEqual([])
  })
  it("keeps every selected hit source when large card text is truncated without disk spill", async () => {
    const cwd = await temp()
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ hits: [{ entry: { summary: "x".repeat(120_000) }, source: identity }], _meta: { actualEngine: "guard" } })))
    const tool = createCodelibTool({ server: "http://localhost", env: {} })
    const result = await tool.execute("id", { action: "search" }, () => {}, { env: { cwd } } as never, undefined as never, {} as never)
    const text = result.content.find(part => part.type === "text")
    if (!text || text.type !== "text") throw new Error("Missing text result")
    const response = JSON.parse(text.text)
    expect(response.truncated).toBe(true)
    expect(response.hits[0].source).toEqual(identity)
    expect(response._meta.actualEngine).toBe("guard")
    expect(await readdir(cwd)).toEqual([])
  })
  it.each([404, 409, 422, 429, 503])("preserves HTTP %i failures without fallback", async status => {
    const fetch = vi.fn(async () => new Response("failure", { status }))
    vi.stubGlobal("fetch", fetch)
    await expect(createCodelibClient("http://localhost").json("/api/codelibs/search", {})).rejects.toThrow(`HTTP ${status}`)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("times out stalled bodies after response headers", async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{") })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address() as { port: number }
    await expect(createCodelibClient(`http://127.0.0.1:${addr.port}`, undefined, 60).json("/api/codelibs")).rejects.toThrow("timed out")
  })
})

describe("codelib safe materialize", () => {
  it.each(["../escape", "/absolute", "C:/drive", "a/../../escape", "a\\escape", "a:stream", "NUL.c", "a. ", "a/./file"])("rejects unsafe path %s", name => {
    expect(() => archivePath(name)).toThrow("Unsafe")
  })
  it("verifies bytes then publishes to a new directory, preserving existing files", async () => {
    const cwd = await temp()
    const bytes = tar(member("./", "", "5"), member("./src/", "", "5"), member("./src/main.c", "int main() {}"))
    const existing = path.join(cwd, ".yoma", "codelib", "example-main")
    await mkdir(existing, { recursive: true })
    await writeFile(path.join(existing, "keep"), "unchanged")
    const result = await materialize(fakeArchive(bytes), cwd, "example@main", identity.commit, sha(bytes), bytes.length)
    expect(await readFile(path.join(result, "src/main.c"), "utf8")).toBe("int main() {}")
    expect(await readFile(path.join(existing, "keep"), "utf8")).toBe("unchanged")
    expect((await readdir(path.join(cwd, ".yoma/codelib"))).some(name => name.startsWith(".tmp-"))).toBe(false)
  })
  it("sends original pins to archive, never reads latest metadata, accepts unknown bytes", async () => {
    const cwd = await temp()
    const bytes = tar(member("a.c", "source"))
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(bytes))
    vi.stubGlobal("fetch", fetch)
    await materialize(createCodelibClient("http://localhost"), cwd, "example@main", identity.commit, sha(bytes), null)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toContain(`expectedCommit=${identity.commit}&expectedArchiveSha256=${sha(bytes)}`)
  })
  it.each(["1", "2", "3", "4", "6", "7", "g"])("rejects link/device/unsupported type %s and cleans this invocation", async type => {
    const cwd = await temp()
    const bytes = tar(member("file", "", type))
    await expect(materialize(fakeArchive(bytes), cwd, "example", identity.commit, sha(bytes), null)).rejects.toThrow()
    expect(await readdir(path.join(cwd, ".yoma/codelib"))).toEqual([])
  })
  it("rejects checksum mismatch before extracting and cleans temporary data", async () => {
    const cwd = await temp()
    const bytes = tar(member("file", "data"))
    await expect(materialize(fakeArchive(bytes), cwd, "example", identity.commit, "0".repeat(64), null)).rejects.toThrow("SHA256")
    expect(await readdir(path.join(cwd, ".yoma/codelib"))).toEqual([])
  })
  it.each(["../escape", "/absolute", "C:/drive", "./a/../../escape"])("rejects malicious tar name %s after SHA verification", async name => {
    const cwd = await temp()
    const bytes = tar(member(name, "data"))
    await expect(materialize(fakeArchive(bytes), cwd, "example", identity.commit, sha(bytes), null)).rejects.toThrow("Unsafe")
    expect(await readdir(path.join(cwd, ".yoma/codelib"))).toEqual([])
  })
  it("supports GNU longnames but rejects PAX path traversal and case aliases", async () => {
    const cwd = await temp()
    const longName = "x".repeat(140) + ".c"
    const bytes = tar(member("././@LongLink", longName + "\0", "L"), member("short", "longname source"))
    const result = await materialize(fakeArchive(bytes), cwd, "example", identity.commit, sha(bytes), null)
    expect(await readFile(path.join(result, longName), "utf8")).toBe("longname source")
    const pax = tar(member("PaxHeader", "18 path=../escape\n", "x"), member("short", "malicious"))
    await expect(materialize(fakeArchive(pax), cwd, "example", identity.commit, sha(pax), null)).rejects.toThrow()
    const duplicate = tar(member("A.c", "one"), member("a.c", "two"))
    await expect(materialize(fakeArchive(duplicate), cwd, "example", identity.commit, sha(duplicate), null)).rejects.toThrow("Duplicate")
  })
  it("rejects missing pins/oversized downloads before creating managed directories", async () => {
    const cwd = await temp()
    const client = fakeArchive(Buffer.from("unused"))
    await expect(materialize(client, cwd, "example", "", identity.archiveSha256, null)).rejects.toThrow("pin")
    await expect(materialize(client, cwd, "example", identity.commit, identity.archiveSha256, 2 * 1024 ** 3 + 1)).rejects.toThrow("2 GiB")
    expect(await readdir(cwd)).toEqual([])
  })
  it("rejects truncated gzip/tar without publishing", async () => {
    const cwd = await temp()
    const complete = tar(member("file.c", "source"))
    const bytes = complete.subarray(0, complete.length - 5)
    await expect(materialize(fakeArchive(bytes), cwd, "example", identity.commit, sha(bytes), null)).rejects.toThrow()
    expect(await readdir(path.join(cwd, ".yoma/codelib"))).toEqual([])
  })
  it("rejects managed directory junctions before network/write into target", async () => {
    const cwd = await temp()
    const outside = await temp()
    await symlink(outside, path.join(cwd, ".yoma"), "junction")
    const client = fakeArchive(tar(member("file")))
    await expect(materialize(client, cwd, "example", identity.commit, identity.archiveSha256, null)).rejects.toThrow("link")
    expect(await readdir(outside)).toEqual([])
  })
  it("cancels a download and removes only invocation temporary data", async () => {
    const cwd = await temp()
    const controller = new AbortController()
    const client = {
      archive: async (_id: string, _commit: string, _sha: string, consume: (res: Response) => Promise<unknown>) => consume(new Response(new ReadableStream({
        start(stream) { stream.enqueue(Buffer.from("partial")); controller.abort(new Error("user cancelled")); stream.close() },
      }))),
    } as ReturnType<typeof createCodelibClient>
    await expect(materialize(client, cwd, "example", identity.commit, identity.archiveSha256, null, controller.signal)).rejects.toThrow("cancelled")
    expect(await readdir(path.join(cwd, ".yoma/codelib"))).toEqual([])
  })
  it("cancels during file extraction and removes partial tree without publishing", async () => {
    const cwd = await temp()
    const controller = new AbortController()
    const bytes = tar(member("large.c", "x".repeat(16 * 1024 ** 2)))
    const base = path.join(cwd, ".yoma/codelib")
    const timer = setInterval(() => {
      if (!existsSync(base)) return
      for (const name of readdirSync(base)) {
        if (name.startsWith(".tmp-") && existsSync(path.join(base, name, "source/large.c"))) controller.abort(new Error("cancelled during extraction"))
      }
    }, 2)
    try {
      await expect(materialize(fakeArchive(bytes), cwd, "example", identity.commit, sha(bytes), null, controller.signal)).rejects.toThrow("cancelled during extraction")
      expect(await readdir(base)).toEqual([])
    } finally { clearInterval(timer) }
  })
  it("extracts real system tar archives using service convention, including PAX long path", async () => {
    const cwd = await temp()
    const tree = path.join(cwd, "tree")
    await mkdir(tree)
    const longName = "long-" + "x".repeat(125) + ".c"
    await writeFile(path.join(tree, longName), "long source")
    const archive = path.join(cwd, "native.tar.gz")
    await promisify(execFile)("tar", ["--format=pax", "-czf", archive, "-C", tree, "."])
    const out = path.join(cwd, "out")
    await mkdir(out)
    await extractArchive(archive, out)
    expect(await readFile(path.join(out, longName), "utf8")).toBe("long source")
  })
})
