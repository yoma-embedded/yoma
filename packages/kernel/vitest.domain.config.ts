import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { name: "kernel-domain", environment: "node", include: ["test/**/*.test.ts"], fileParallelism: false },
})
