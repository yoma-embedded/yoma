import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

export default defineConfig({
  // hot:false 的理由见 packages/ui/vitest.config.ts(Windows 上 `file:///@solid-refresh` 加载不了)。
  plugins: [solid({ hot: false })],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { name: "app", environment: "happy-dom", setupFiles: ["./vitest.setup.ts"], include: ["src/**/*.test.ts"] },
})
