import { expect, test } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { prepareChromeTrace } from "../chrome-trace"

test("creates the configured trace directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-trace-"))
  try {
    const file = await prepareChromeTrace(path.join(root, "nested", "traces"), "session/tab", false, "test")
    expect(file.endsWith("-session-tab-458ed9e3-test.json")).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
