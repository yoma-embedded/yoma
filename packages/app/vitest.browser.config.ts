import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }, conditions: ["browser"] },
  test: { name: "app-browser", environment: "happy-dom", setupFiles: ["./vitest.setup.ts"], include: ["test-browser/**/*.test.ts"] },
})
