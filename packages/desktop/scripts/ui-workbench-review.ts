/**
 * Manual production-renderer review. Never attaches to an existing app: a copy of
 * the built bundle runs on a free CDP port with temporary onboarding user data.
 * Requires a seed directory containing seed.json and sessions/ (demo data only).
 *
 * node --import tsx packages/desktop/scripts/ui-workbench-review.ts \
 *   --seed /absolute/demo --out /absolute/review --engines /absolute/engines
 * Add --check for the embedded-workbench interaction assertions.
 * Add --serial-loopback with --check for real PTY send/receive checks (POSIX + Python 3, no hardware).
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "@playwright/test"

const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const repo = resolve(option("worktree") ?? join(dirname(fileURLToPath(import.meta.url)), "../../.."))
const seedRoot = option("seed")
const output = option("out")
if (!seedRoot || !output) throw new Error("--seed and --out are required absolute paths")
const out = resolve(output)
const seed = JSON.parse(readFileSync(join(seedRoot, "seed.json"), "utf8")) as {
  workspace: string
  sessions: { id: string; title: string }[]
}
const theme = option("theme") ?? "dark"
const [width, height] = (option("size") ?? "1440x900").split("x").map(Number)
if (!["light", "dark"].includes(theme) || !width || !height) throw new Error("Invalid theme or size")
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const temp = mkdtempSync(join(tmpdir(), "yoma-ui-review-"))
const bundle = join(temp, "packages/desktop/out")
const errors: string[] = []
const metrics: { title: string; domReadyMs: number; rows: number }[] = []
const checks: string[] = []
const manualFeedback: string[] = []
let scopeGeometry: { canvasHeight: number; visibleHeight: number } | undefined
let draftGeometry: { width: number; availableWidth: number } | undefined
const homeNavigations: string[] = []
let browser: Browser | undefined
let page: Page | undefined
let serialDevice: ReturnType<typeof spawn> | undefined
let child: ReturnType<typeof spawn> | undefined
let exit: number | null | undefined
let log = ""
mkdirSync(out, { recursive: true })
mkdirSync(dirname(bundle), { recursive: true })
cpSync(join(repo, "packages/desktop/out"), bundle, { recursive: true })
writeFileSync(join(temp, "package.json"), '{"type":"module"}\n')
symlinkSync(join(repo, "node_modules"), join(temp, "node_modules"), "dir")
const main = join(bundle, "main/index.js")
const original = readFileSync(main, "utf8")
const bundleHash = createHash("sha256").update(original).digest("hex")
const rendererIndexHash = createHash("sha256")
  .update(readFileSync(join(bundle, "renderer/index.html")))
  .digest("hex")
// TEST_ONBOARDING isolates Electron stores, but the production kernel otherwise
// defaults to ~/.yoma. Inject its existing configDir option only in this copy.
const kernelFile = join(bundle, "main/kernel.js")
const kernel = readFileSync(kernelFile, "utf8")
if (!kernel.includes("host = createKernelHost({")) throw new Error("Missing kernel host initialization")
if (!kernel.includes("return host.handle(method, params);")) throw new Error("Missing kernel request dispatch")
const requestsFile = join(temp, "manual-instrument-requests.jsonl")
const readRequests = () =>
  existsSync(requestsFile)
    ? readFileSync(requestsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; tool?: string; action?: string })
    : []
writeFileSync(
  kernelFile,
  'import { appendFileSync as uiReviewAppend } from "node:fs";\n' +
    kernel
      .replace(
        "host = createKernelHost({",
        `host = createKernelHost({ configDir: ${JSON.stringify(join(temp, "kernel-config"))},`,
      )
      .replace(
        "return host.handle(method, params);",
        `
    if (method === "session.prompt" || (method === "instrument.execute" && params?.input?.action !== "status")) {
      uiReviewAppend(${JSON.stringify(requestsFile)}, JSON.stringify({ method, tool: params?.tool, action: params?.input?.action }) + "\\n");
    }
    return host.handle(method, params);`,
      ),
)
const port = await new Promise<number>((resolvePort, reject) => {
  const server = createServer()
  server.on("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (!address || typeof address === "string") return reject(new Error("Missing debug port"))
    server.close(() => resolvePort(address.port))
  })
})
if (!/"remote-debugging-port", "\d+"/.test(original)) throw new Error("Missing development CDP switch")
writeFileSync(main, original.replace(/"remote-debugging-port", "\d+"/, `"remote-debugging-port", "${port}"`))
const electronRoot = join(repo, "node_modules/electron")
const electron = join(electronRoot, "dist", readFileSync(join(electronRoot, "path.txt"), "utf8").trim())

async function capture(name: string) {
  await page!.mouse.move(width * 0.55, 18)
  await sleep(350)
  await page!.screenshot({ path: join(out, `${name}.png`) })
  console.log(`SCREENSHOT ${name}`)
}

async function home() {
  if (await page!.locator('[data-component="home-session-search"]').count()) return
  const button = page!.getByRole("button", { name: /^(主页|Home)(\s|$)/ }).first()
  if (await button.count()) {
    homeNavigations.push("home button")
    await button.click()
  } else {
    homeNavigations.push("page reload fallback")
    await page!.reload()
  }
  await page!.locator('[data-component="home-session-search"]').waitFor()
  await sleep(700)
}

async function openSession(title: string) {
  await home()
  const metric = await page!.evaluate<{
    title: string
    domReadyMs: number
    rows: number
  }>(`new Promise((done, reject) => {
    const title = ${JSON.stringify(title)};
    const row = Array.from(document.querySelectorAll('[data-component="home-session-row"]'))
      .find(element => element.textContent?.includes(title));
    if (!row) return reject(new Error("Missing seeded session: " + title));
    const began = performance.now(); row.click();
    const frame = () => {
      if (performance.now() - began > 30000) return reject(new Error("Session mount timeout"));
      const rows = document.querySelectorAll("[data-timeline-key]").length;
      if (!document.querySelector('[data-component="session-composer"]') || !rows) { requestAnimationFrame(frame); return; }
      requestAnimationFrame(() => requestAnimationFrame(() => done({ title, domReadyMs: performance.now() - began, rows })));
    };
    requestAnimationFrame(frame);
  })`)
  metrics.push(metric)
  console.log(`BENCHMARK ${JSON.stringify(metric)}`)
  await sleep(1400)
}

async function surfaceState() {
  return page!.evaluate<string>(`JSON.stringify({
    console: !!document.querySelector('[data-component="session-console"]'),
    review: !!document.querySelector("#review-panel"),
    tabs: Array.from(document.querySelectorAll('[data-component="session-console"] [data-instrument], [data-component="instrument-rail"] [data-instrument]'))
      .map(element => [element.getAttribute("data-instrument"), element.getAttribute("aria-selected")]),
  })`)
}

async function typingCheck(label: string) {
  const before = await surfaceState()
  const composer = page!.locator('[data-component="prompt-input"][contenteditable="true"]').last()
  await composer.fill("串口日志 gdb 示波器")
  await sleep(500)
  if ((await surfaceState()) !== before) throw new Error(`${label}: typing changed instrument panels`)
  checks.push(`${label}: typing leaves instrument panels unchanged`)
  await capture(`${label}-typing`)
  await composer.fill("")
}

try {
  child = spawn(electron, [main], {
    cwd: dirname(bundle),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)),
      ),
      YOMA_TEST_ONBOARDING: "1",
      YOMA_CHANNEL: "dev",
      YOMA_SCOPE_DEMO: "1",
      YOMA_ENGINES_DIR: option("engines") ?? join(repo, "engines"),
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.on("exit", (code) => {
    exit = code
  })
  child.stdout?.on("data", (data: Buffer) => {
    log = (log + data.toString()).slice(-20_000)
  })
  child.stderr?.on("data", (data: Buffer) => {
    log = (log + data.toString()).slice(-20_000)
  })
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (exit !== undefined) throw new Error(`Isolated Electron exited: ${exit}\n${log}`)
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 })
      break
    } catch {
      await sleep(250)
    }
  }
  if (!browser) throw new Error(`No isolated CDP endpoint\n${log}`)
  page = browser.contexts()[0]!.pages()[0]
  if (!page) throw new Error("No renderer page")
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/Electron Security Warning|Insecure Content-Security-Policy/.test(message.text())
    )
      errors.push(message.text())
  })
  await page.locator('[data-component="home-session-search"]').waitFor({ timeout: 40_000 })
  const onboarding = readdirSync(temp).find((name) => name.startsWith("yoma-onboarding-"))
  if (!onboarding) throw new Error("Isolated onboarding userData was not created")
  cpSync(join(seedRoot, "sessions"), join(temp, onboarding, "desktop/sessions"), { recursive: true })
  await page.evaluate(`(async () => {
    const api = window.api;
    await Promise.all([
      api.storeSet("yoma.global.dat", "server", ${JSON.stringify(JSON.stringify({ projects: { local: [{ worktree: seed.workspace, expanded: true }] }, lastProject: { local: seed.workspace } }))}),
      api.storeSet("yoma.global.dat", "language", JSON.stringify({ locale: "zh" })),
    ]);
    localStorage.setItem("yoma.global.dat:language", JSON.stringify({ locale: "zh" }));
    localStorage.setItem("yoma-color-scheme", ${JSON.stringify(theme)});
  })()`)
  await page.reload()
  await page.locator('[data-component="home-session-search"]').waitFor()
  for (const session of seed.sessions) {
    await page.evaluate(
      `window.api.kernel.request("session.messages", ${JSON.stringify({ sessionID: session.id })}).then(() => true)`,
    )
  }
  await page.reload()
  await page.locator('[data-component="home-session-row"]').first().waitFor()
  await page.setViewportSize({ width, height })
  await sleep(700)
  await capture("01-home")
  for (const [index, session] of seed.sessions.entries()) {
    await openSession(session.title)
    await capture(`0${index + 2}-session`)
  }
  for (let round = 0; round < 3; round++) for (const session of seed.sessions) await openSession(session.title)

  if (process.argv.includes("--check")) {
    await openSession(seed.sessions[0]!.title)
    const consolePanel = page.locator('[data-component="session-console"]')
    await consolePanel.waitFor()
    for (const instrument of ["log", "gdb"]) {
      const tab = consolePanel.locator(`[role="tab"][data-instrument="${instrument}"]`)
      await tab.click()
      await tab.click()
      if (!(await consolePanel.isVisible())) throw new Error(`${instrument}: repeated tab click hid console`)
      checks.push(`${instrument}: visible tab remains open after repeated click`)
      await capture(`10-${instrument}`)
      if (instrument === "log") {
        const serial = consolePanel.locator('[data-component="serial-controls"]')
        await serial.locator('[data-slot="port-field"] input').fill("/dev/yoma-ui-review-not-present")
        await serial.locator('[data-slot="baud-field"] input').fill("115200")
        await serial.locator('[data-slot="connect"]').click()
        await serial.locator('[role="alert"]').waitFor({ timeout: 30_000 })
        const feedback = await serial.locator('[role="alert"]').innerText()
        if (!feedback.includes("/dev/yoma-ui-review-not-present"))
          throw new Error(`Unexpected serial connection failure: ${feedback}`)
        manualFeedback.push(feedback)
        const requests = readRequests()
        if (
          !requests.some(
            (request) =>
              request.method === "instrument.execute" && request.tool === "log" && request.action === "start",
          )
        ) {
          throw new Error("Manual serial connect did not issue instrument.execute(log,start)")
        }
        if (requests.some((request) => request.method === "session.prompt"))
          throw new Error("Manual serial connect submitted an agent prompt")
        checks.push(
          "serial: nonexistent-port error through instrument.execute(log,start), no model credentials or agent prompt",
        )
        await capture("10-serial-connection-error")
        if (process.argv.includes("--serial-loopback")) {
          serialDevice = spawn("python3", ["-u", "-c", `
import os, pty
master, slave = pty.openpty()
print(os.ttyname(slave), flush=True)
while True:
    data = os.read(master, 4096)
    print(data.hex(), flush=True)
    os.write(master, b"DEVICE RX: " + data.hex().encode() + b"\\n")
`], { stdio: ["ignore", "pipe", "pipe"] })
          let serialData = ""
          serialDevice.stdout!.setEncoding("utf8")
          serialDevice.stdout!.on("data", (chunk) => { serialData += chunk })
          for (let i = 0; i < 50 && !serialData.includes("\n"); i++) await sleep(100)
          if (!serialData.includes("\n")) throw new Error("Virtual serial device did not start")
          await serial.locator('[data-slot="port-field"] input').fill(serialData.split("\n")[0]!)
          await serial.locator('[data-slot="baud-field"] select').selectOption("230400")
          await serial.locator('[data-slot="baud-field"] input').fill("115200")
          await serial.locator('[data-slot="connect"]').click()
          await page.waitForFunction(`document.querySelector('[data-component="serial-controls"] [data-slot="ctrl-c"]')?.disabled === false`)
          const sender = serial.locator('[data-slot="send-input"]')
          await serial.locator('[data-slot="ending-field"] select').selectOption("crlf")
          await sender.fill("你好")
          const beforeTyping = readRequests().filter((r) => r.action === "write").length
          await sleep(300)
          if (readRequests().filter((r) => r.action === "write").length !== beforeTyping) throw new Error("Typing transmitted serial data")
          await sender.press("Enter")
          await page.waitForFunction(`document.querySelector('[data-slot="send-input"]')?.value === ""`)
          await serial.locator('[data-slot="send-form"] select').selectOption("hex")
          await serial.locator('[data-slot="ending-field"] select').selectOption("none")
          await sender.fill("00 FF")
          await serial.locator('[data-slot="send"]').click()
          await page.waitForFunction(`document.querySelector('[data-slot="send-input"]')?.value === ""`)
          await serial.locator('[data-slot="ending-field"] select').selectOption("crlf")
          await sender.fill("draft stays")
          await serial.locator('[data-slot="ctrl-c"]').click()
          for (let i = 0; i < 50 && !serialData.replace(/\n/g, "").endsWith("e4bda0e5a5bd0d0a00ff03"); i++) await sleep(100)
          const bytes = serialData.split("\n").slice(1).join("")
          if (bytes !== "e4bda0e5a5bd0d0a00ff03") throw new Error(`Wrong serial bytes: ${bytes}`)
          if (await sender.inputValue() !== "draft stays") throw new Error("Ctrl+C cleared the message draft")
          await serial.locator('[data-slot="monitor-output"]').getByText(/DEVICE RX:/).first().waitFor()
          await capture("10-serial-duplex")
          await serial.screenshot({ path: join(out, "10-serial-panel.png") })
          checks.push("serial: production UI → contextBridge → kernel → PTY exact UTF-8/CRLF, Hex 00 FF, Ctrl+C 03; reply visible; typing sends nothing")
          await serial.locator('[data-slot="connect"]').click()
          await page.waitForFunction(`document.querySelector('[data-component="serial-controls"] [data-slot="ctrl-c"]')?.disabled === true`)
          serialDevice.kill("SIGTERM")
          serialDevice = undefined
        }

      }
    }
    await typingCheck("11-session")
    const scopeTab = page.locator('[data-component="instrument-rail"] [data-instrument="scope"]').first()
    if (await scopeTab.count()) await scopeTab.click()
    const plot = page.locator('[data-component="scope-waveform"] [data-slot="plot"]')
    await plot.waitFor()
    await page.waitForFunction(
      `document.querySelector('[data-component="scope-waveform"] [data-slot="plot"]')?.getAttribute("aria-busy") === "false"`,
    )
    scopeGeometry = await page.evaluate(`(() => {
      const canvas = document.querySelector('[data-component="scope-waveform"] canvas');
      const bounds = canvas.getBoundingClientRect();
      let top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
      for (let parent = canvas.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
          const clip = parent.getBoundingClientRect();
          top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
        }
      }
      return { canvasHeight: bounds.height, visibleHeight: Math.max(0, bottom - top) };
    })()`)
    if (scopeGeometry && scopeGeometry.visibleHeight < scopeGeometry.canvasHeight - 1) {
      throw new Error(
        `Default scope waveform is clipped: ${scopeGeometry.visibleHeight}/${scopeGeometry.canvasHeight}px visible`,
      )
    }
    await capture("12-scope")
    await page.getByRole("button", { name: "放大波形", exact: true }).click()
    await sleep(300)
    const canvas = plot.locator("canvas")
    await canvas.scrollIntoViewIfNeeded()
    const bounds = await canvas.boundingBox()
    if (!bounds) throw new Error("Missing waveform canvas bounds")
    const range = page.locator('[data-component="scope-waveform"] [data-slot="view-range"]')
    const beforeWheel = await range.textContent()
    await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5)
    await page.mouse.wheel(0, -120)
    await sleep(300)
    if ((await range.textContent()) === beforeWheel)
      throw new Error("Scope wheel gesture did not change the visible time range")
    const beforeDrag = await range.textContent()
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.5, { steps: 12 })
    await page.mouse.up()
    await sleep(300)
    if ((await range.textContent()) === beforeDrag)
      throw new Error("Scope drag gesture did not pan the visible time range")
    await page.mouse.click(bounds.x + bounds.width * 0.35, bounds.y + bounds.height * 0.5)
    await page.keyboard.down("Shift")
    await page.mouse.click(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.5)
    await page.keyboard.up("Shift")
    await capture("13-scope-cursors")
    checks.push("scope: button/wheel zoom, drag pan, and both cursor interactions completed")
    await home()
    await page.locator('[data-action="home-new-session"]').first().click()
    await page.locator('[data-component="prompt-input"][contenteditable="true"]').waitFor()
    draftGeometry = await page.evaluate(`(() => {
      const draft = document.querySelector('[data-component="workbench-draft"]');
      return { width: draft.getBoundingClientRect().width, availableWidth: draft.closest("main").getBoundingClientRect().width };
    })()`)
    if (draftGeometry && draftGeometry.availableWidth - draftGeometry.width > 1) {
      throw new Error(
        `Draft workbench does not fill its available width: ${draftGeometry.width}/${draftGeometry.availableWidth}px`,
      )
    }
    await capture("14-draft")
    await typingCheck("15-draft")
    await home()
    await page.locator('[data-component="workbench-launcher"] button[data-instrument="log"]').click()
    await page.locator('[data-component="serial-controls"]').waitFor()
    const toolbarLog = page.locator('[data-component="workbench-toolbar"] button[data-instrument="log"]')
    await toolbarLog.click()
    await toolbarLog.click()
    if (!(await page.locator('[data-component="session-console"]').isVisible()))
      throw new Error("Toolbar selection hid the serial console")
    if (readRequests().some((request) => request.method === "session.prompt"))
      throw new Error("Standalone workspace navigation submitted an agent prompt")
    checks.push("home: opens standalone serial workspace, toolbar selection keeps it open, no agent prompt")
    await capture("16-home-open-serial")
  }
  if (errors.length) throw new Error(`Renderer errors: ${errors.join("\n")}`)
  rmSync(join(out, "FAILED.png"), { force: true })
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error))
  if (page && !page.isClosed()) await capture("FAILED").catch(() => undefined)
  process.exitCode = 1
} finally {
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        repo,
        seedRoot,
        bundleHash,
        rendererIndexHash,
        theme,
        width,
        height,
        evidence:
          "Production renderer with temporary config/userData and seeded demo hardware history; no physical hardware test.",
        metrics,
        homeNavigations,
        checks,
        manualRequests: readRequests(),
        manualFeedback,
        scopeGeometry,
        draftGeometry,
        errors,
      },
      null,
      2,
    ) + "\n",
  )
  if (browser) {
    const session = page && !page.isClosed() ? await browser.newBrowserCDPSession().catch(() => undefined) : undefined
    await session?.send("Browser.close").catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
  if (exit === undefined) child?.kill("SIGTERM")
  for (let i = 0; i < 50 && exit === undefined; i++) await sleep(100)
  if (exit === undefined) child?.kill("SIGKILL")
  serialDevice?.kill("SIGKILL")
  rmSync(temp, { recursive: true, force: true })
  console.log(`Review report: ${join(out, "report.json")}`)
}
