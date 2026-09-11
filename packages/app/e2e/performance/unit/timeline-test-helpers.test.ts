import { expect, test } from "vitest"
import { fixture } from "../timeline/session-timeline-stress.fixture"
import { stressSessionHref } from "../timeline/timeline-test-helpers"

test("builds stress session links on the single-kernel session route", () => {
  expect(stressSessionHref(fixture.sourceID)).toBe(`/session/${fixture.sourceID}`)
})
