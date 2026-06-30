#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

// The server bundle is provided by the @yoma-desktop/opencode-server dependency
// (built in the backend repo via `bun publish/build-server.ts`), not built here.
