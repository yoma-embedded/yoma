// @ts-nocheck
import { ToolErrorCard } from "./tool-error-card"

const docs = `### Overview
Tool call failure summary styled like a tool trigger.

### API
- Required: \`tool\` (tool id, e.g. flash, bash)
- Required: \`error\` (error string)

### Behavior
- Collapsible; click header to expand/collapse.
`

const samples = [
  {
    tool: "flash",
    error: "flash `openocd` failed (exit 1): Error: no device found. Connect an ST-Link/J-Link/CMSIS-DAP probe and check the OS actually sees it.",
  },
  {
    tool: "gdb",
    error: "gdb connection lost: target stopped responding after 5s (epoch 3)",
  },
  {
    tool: "stm32config",
    error: "stm32kernel validate failed (exit 2): unknown peripheral `TIM9` for STM32F103C8",
  },
  {
    tool: "netlist",
    error: "controller_map failed: could not resolve net `VDD_MCU` — no matching pin in board IR",
  },
  {
    tool: "datasheet",
    error: "datasheet search unavailable: server /api/search returned 404 (endpoint not deployed yet)",
  },
  {
    tool: "log",
    error: "log start failed: /dev/tty.usbmodem14203 is busy — another capture is already running",
  },
  {
    tool: "bash",
    error: "bash Command failed: exit code 1: cargo build --release",
  },
  {
    tool: "read",
    error: "read File not found: /Users/ben/firmware/src/does-not-exist.c",
  },
  {
    tool: "grep",
    error: "grep Regex error: Invalid regular expression: (unterminated group",
  },
]

export default {
  title: "UI/ToolErrorCard",
  id: "components-tool-error-card",
  component: ToolErrorCard,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
  args: {
    tool: "apply_patch",
    error: samples[0].error,
  },
  argTypes: {
    tool: {
      control: "select",
      options: ["apply_patch", "bash", "read", "glob", "grep", "webfetch", "websearch", "question"],
    },
    error: {
      control: "text",
    },
  },
  render: (props: { tool: string; error: string }) => {
    return <ToolErrorCard tool={props.tool} error={props.error} />
  },
}

export const All = {
  render: () => {
    return (
      <div style="display: flex; flex-direction: column; gap: 12px; max-width: 720px;">
        {samples.map((item) => (
          <ToolErrorCard tool={item.tool} error={item.error} />
        ))}
      </div>
    )
  },
}
