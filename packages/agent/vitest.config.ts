import { upstreamTestPortability } from "../../scripts/upstream-test-portability.ts"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [upstreamTestPortability()],
  test: {
    name: "agent",
    environment: "node",
    testTimeout: 30000,
    include: ["test/harness/**/*.test.ts", "test/agent.test.ts", "test/agent-loop.test.ts"],
  },
})
