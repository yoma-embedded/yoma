import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, test } from "vitest"
import { prepareTestProfile } from "./test-profile"

test("reusing an explicit test profile preserves existing sessions and settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "yoma-test-profile-"))
  try {
    const root = prepareTestProfile(join(dir, "persistent"))
    const sessions = join(root, "desktop", "sessions")
    mkdirSync(sessions)
    const marker = join(sessions, "previous.jsonl")
    writeFileSync(marker, "previous session\n", "utf8")
    expect(prepareTestProfile(root)).toBe(root)
    expect(readFileSync(marker, "utf8")).toBe("previous session\n")
    expect(prepareTestProfile(undefined, dir)).not.toBe(prepareTestProfile(undefined, dir))
    expect(() => prepareTestProfile("relative-profile")).toThrow("absolute path")
  } finally {
    expect(dirname(realpathSync(dir))).toBe(realpathSync(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})
