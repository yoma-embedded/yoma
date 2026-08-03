import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

// 后端内核是 ../my-pi 的源码,由 electron-vite 在构建期 inline 进 out/main/kernel.js
// (见 packages/kernel/mypi.ts)。这里不需要准备任何后端产物。
