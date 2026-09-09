import { defineConfig } from "vitest/config"
import { KERNEL_VITE_ALIAS } from "./packages/kernel/kernel-alias.ts"

export default defineConfig({
  resolve: { alias: KERNEL_VITE_ALIAS },
  test: {
    environment: "node",
    include: ["packages/ai/test/**/*.test.ts"],
  },
})
