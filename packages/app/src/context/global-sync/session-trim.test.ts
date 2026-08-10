import { describe, expect, test } from "bun:test"
import type { Session } from "@yoma-desktop/kernel"
import { trimSessions } from "./session-trim"

const session = (input: { id: string; created: number; updated?: number; archived?: number }) =>
  ({
    id: input.id,
    directory: "/tmp",
    title: input.id,
    time: {
      created: input.created,
      updated: input.updated ?? input.created,
      archived: input.archived,
    },
  }) satisfies Session

describe("trimSessions", () => {
  test("keeps the base window and recent sessions beyond the limit", () => {
    const now = 1_000_000
    const list = [
      session({ id: "a", created: now - 100_000 }),
      session({ id: "b", created: now - 90_000 }),
      session({ id: "c", created: now - 80_000 }),
      session({ id: "d", created: now - 70_000, updated: now - 1_000 }),
      session({ id: "e", created: now - 60_000, archived: now - 10 }),
    ]

    const result = trimSessions(list, { limit: 2, now })
    expect(result.map((x) => x.id)).toEqual(["a", "b", "c", "d"])
  })
})
