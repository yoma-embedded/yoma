import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "packages/kernel/vitest.domain.config.ts", "packages/app/vitest.browser.config.ts", "scripts/vitest.config.ts"],
  },
})
