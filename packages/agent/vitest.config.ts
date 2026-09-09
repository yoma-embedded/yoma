import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "agent",
    environment: "node",
    testTimeout: 30000,
    include: ["test/harness/**/*.test.ts", "test/agent.test.ts", "test/agent-loop.test.ts"],
  },
})
