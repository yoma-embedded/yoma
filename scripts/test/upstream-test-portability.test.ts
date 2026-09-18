import { describe, expect, it } from "vitest"
import { adaptUpstreamTest } from "../upstream-test-portability.ts"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("upstream test portability", () => {
  it("keeps migration fixture placement consistent with a native Windows cwd", () => {
    const id = resolve(import.meta.dirname, "../..", "packages/agent/test/harness/jsonl-v3-migration.test.ts")
    const code = adaptUpstreamTest(readFileSync(id, "utf8"), id)!
    expect(code).toContain('"C:\\\\workspace"')
    expect(code).toContain('"--C--workspace--"')
    expect(code).not.toContain('"/workspace"')
    expect(code).not.toContain('"--workspace--"')
  })
  it("adapts cwd fixtures but never touches runtime code", () => {
    const input = 'const cwd = "/workspace-a"; const other = "/workspace-b"'
    expect(adaptUpstreamTest(input, "/repo/packages/agent/test/harness/jsonl-session-repo.test.ts")).toBe(
      'const cwd = "C:\\\\workspace-a"; const other = "C:\\\\workspace-b"',
    )
    expect(adaptUpstreamTest(input, "/repo/packages/agent/src/harness/session/jsonl/repo.ts")).toBeUndefined()
  })
  it("preserves every shell assertion and only changes the cwd representation", () => {
    for (const file of ["nodejs-env", "tools"]) {
      const id = resolve(import.meta.dirname, "../..", `packages/agent/test/harness/${file}.test.ts`)
      const input = readFileSync(id, "utf8")
      const output = adaptUpstreamTest(input, id)!
      expect(output).not.toBe(input)
      expect(output.replaceAll('"$(cygpath -alw .)"', '"$PWD"')).toBe(input)
    }
  })
  it("makes session temp-dir cleanup wait out Windows EPERM instead of calling rmSync once", () => {
    const id = resolve(import.meta.dirname, "../..", "packages/agent/test/harness/session-test-utils.ts")
    const input = readFileSync(id, "utf8")
    const output = adaptUpstreamTest(input, id)!
    expect(output).toContain("afterEach(async () => {")
    expect(output).toContain('errCode !== "EPERM"')
    expect(output).toContain("setTimeout(resolve, 100)")
    expect(output).not.toContain("if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });")
    expect(adaptUpstreamTest(input, "/repo/packages/agent/src/harness/session-test-utils.ts")).toBeUndefined()
  })
})
