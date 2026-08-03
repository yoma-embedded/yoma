import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@yoma-desktop/kernel"
import { base64Encode } from "@yoma-desktop/util/encode"
import { autoRespondsPermission, isDirectoryAutoAccepting } from "./permission-auto-respond"

const permission = (sessionID: string) =>
  ({
    sessionID,
  }) as Pick<PermissionRequest, "sessionID">

describe("autoRespondsPermission", () => {
  test("uses the directory-scoped auto-accept key", () => {
    const directory = "/tmp/project"
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, permission("root"), directory)).toBe(true)
  })

  test("uses the legacy session-only auto-accept key", () => {
    expect(autoRespondsPermission({ root: true }, permission("root"), "/tmp/project")).toBe(true)
  })

  test("defaults to requiring approval when no override exists", () => {
    expect(autoRespondsPermission({ other: true }, permission("root"), "/tmp/project")).toBe(false)
  })

  test("honours an explicit false override", () => {
    const directory = "/tmp/project"
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, permission("root"), directory)).toBe(false)
  })

  test("falls back to directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
    }

    expect(autoRespondsPermission(autoAccept, permission("root"), directory)).toBe(true)
  })

  test("session-level override takes precedence over directory-level", () => {
    const directory = "/tmp/project"
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, permission("root"), directory)).toBe(false)
  })
})

describe("isDirectoryAutoAccepting", () => {
  test("returns true when directory key is set", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(true)
  })

  test("returns false when directory key is not set", () => {
    expect(isDirectoryAutoAccepting({}, "/tmp/project")).toBe(false)
  })

  test("returns false when directory key is explicitly false", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: false }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(false)
  })
})
