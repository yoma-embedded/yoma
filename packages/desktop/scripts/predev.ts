import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

// The server bundle is provided by the @yoma-desktop/opencode-server dependency
// (built in the backend repo via `bun publish/build-server.ts`), not built here.
