import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { name: "kernel", environment: "node", include: ["src/**/*.test.ts"] },
})
