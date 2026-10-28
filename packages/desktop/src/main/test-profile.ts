import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

/** Explicit manual-test profiles are reused; automated onboarding tests remain disposable. */
export function prepareTestProfile(persistentRoot?: string, temporaryRoot = tmpdir()): string {
  if (persistentRoot && !isAbsolute(persistentRoot)) throw new Error("YOMA_TEST_PROFILE_DIR must be an absolute path")
  const root = persistentRoot ?? join(temporaryRoot, `yoma-onboarding-${randomUUID()}`)
  for (const dir of ["data", "config", "cache", "state", "desktop", "session"])
    mkdirSync(join(root, dir), { recursive: true })
  return root
}
