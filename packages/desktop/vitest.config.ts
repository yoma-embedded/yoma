import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { name: "desktop", environment: "node", include: ["src/**/*.test.ts", "electron-builder.config.test.ts"] },
})
