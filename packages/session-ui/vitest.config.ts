import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  test: { name: "session-ui", environment: "node", include: ["src/**/*.test.ts"] },
})
