import { defineConfig } from "vitest/config"
import { KERNEL_VITE_ALIAS } from "../kernel/kernel-alias.ts"

export default defineConfig({
  resolve: { alias: KERNEL_VITE_ALIAS },
  test: { name: "bench", environment: "node", include: ["src/**/*.test.ts"] },
})
