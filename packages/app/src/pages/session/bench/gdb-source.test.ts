import { describe, expect, test } from "vitest"
import { breakAt, breakpointOnLine, changedNames, pendingOnLine, sameSource } from "./gdb-source"

describe("debugger source matching", () => {
  test("matches a path suffix with a directory, and not a bare filename", () => {
    expect(sameSource("Core/Src/main.c", "D:/proj/Core/Src/main.c")).toBe(true)
    expect(sameSource("core/src/main.c", "D:\\proj\\Core\\Src\\main.c")).toBe(true)
    expect(sameSource("./Core/Src/main.c", "proj/Core/Src/main.c")).toBe(true)
    expect(sameSource("main.c", "D:/proj/Core/Src/main.c")).toBe(false)
    expect(sameSource("main.c", "main.c")).toBe(true)
    expect(sameSource(undefined, "main.c")).toBe(false)
  })

  test("a breakpoint sits on a line only when the file and the kind both match", () => {
    const breakpoints = [
      { number: 1, kind: "break", file: "D:/proj/Core/Src/main.c", line: 42 },
      { number: 2, kind: "watch", file: "Core/Src/main.c", line: 42 },
      { number: 3, kind: "break", file: "Core/Src/main.c", line: 7 },
    ]
    expect(breakpointOnLine(breakpoints, "Core/Src/main.c", 42)?.number).toBe(1)
    expect(breakpointOnLine(breakpoints, "Core/Src/main.c", 7)?.number).toBe(3)
    expect(breakpointOnLine(breakpoints, "other/main.c", 42)).toBeUndefined()
    expect(pendingOnLine([{ file: "Core/Src/main.c", line: 9 }], "D:/proj/Core/Src/main.c", 9)).toBe(0)
    expect(pendingOnLine([{ file: "main.c", line: 9 }], "D:/proj/Core/Src/main.c", 9)).toBe(-1)
  })

  test("highlights only registers whose previous value changed", () => {
    const prev = [
      { name: "r0", value: "0x1" },
      { name: "r1", value: "0x2" },
    ]
    const next = [
      { name: "r0", value: "0x1" },
      { name: "r1", value: "0x3" },
      { name: "r2", value: "0x9" },
    ]
    expect([...changedNames(prev, next)]).toEqual(["r1"])
    expect([...changedNames([], next)]).toEqual([])
  })

  test("breakpoint locations use forward slashes", () => {
    expect(breakAt("C:\\proj\\main.c", 42)).toBe("C:/proj/main.c:42")
  })
})
