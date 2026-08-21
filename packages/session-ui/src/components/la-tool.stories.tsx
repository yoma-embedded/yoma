// @ts-nocheck
import * as mod from "./la-tool"
import { create } from "@yoma-desktop/ui/storybook/scaffold"

const docs = `### Overview
Logic analyzer (\`la\`) tool card: capture summary, decoder annotation counts and a waveform thumbnail.

### API
- \`metadata\` is the kernel's \`LaToolDetails\` (action, captureId, samplerate, samples, channels, preview, decoders…).
- \`output\` is the tool's text answer, rendered monospace inside the collapsible body.

### Preview encoding
\`preview.rows[channelIndex]\` is base64 of \`ceil(columns / 4)\` bytes, 2 bits per column
(column \`c\` → byte \`c >> 2\`, bits \`(c & 3) * 2\`): \`01\` all high, \`10\` all low, \`11\` toggled.
The stories below synthesize those rows the same way the kernel does.

### Behavior
- Body is deferred (mounts on open, like the other heavy tool cards).
- Decoding, folding to pixels and the lane painter live in \`./la-preview\` — the dock's
  logic-analyzer panel draws the same waveform with the same \`paintLanes\`.
- The canvas is redrawn on resize and whenever \`data-color-scheme\` flips — colors are read
  from theme tokens (\`--icon-diff-add-base\` for the trace, \`--v2-border-border-base\` for the
  lane separators) with \`getComputedStyle\` at draw time.

### Theming/tokens
- \`data-component="la-tool"\` / \`data-component="la-waveform"\`, see \`la-tool.css\`.
`

const COLUMNS = 1024

function row(level) {
  const bytes = new Uint8Array(Math.ceil(COLUMNS / 4))
  for (let column = 0; column < COLUMNS; column += 1) {
    bytes[column >> 2] |= (level(column) & 3) << ((column & 3) * 2)
  }
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const HIGH = 1
const LOW = 2
const TOGGLE = 3

// SCL:总线空闲时拉高,事务期间每一列里都翻转过 → 11。
const scl = row((column) => (column >= 220 && column < 820 ? TOGGLE : HIGH))
// SDA:事务里既有翻转的字节,也有停在某个电平上的 ACK 位。
const sda = row((column) => {
  if (column < 220 || column >= 820) return HIGH
  const phase = (column - 220) % 90
  if (phase < 60) return TOGGLE
  if (phase < 72) return LOW
  return HIGH
})
// 一条没接东西的通道:整段都是高。
const idle = row(() => HIGH)
// 复位脚:先低后高,交界那一列是翻转。
const reset = row((column) => (column < 96 ? LOW : column === 96 ? TOGGLE : HIGH))

const channels = [
  { index: 0, name: "SCL", edges: 1204 },
  { index: 1, name: "SDA", edges: 903 },
  { index: 2, name: "SPARE", edges: 0 },
  { index: 3, name: "RESET", edges: 1 },
]

const preview = {
  columns: COLUMNS,
  from: 0,
  to: 1_000_000,
  rows: { "0": scl, "1": sda, "2": idle, "3": reset },
}

const story = create({
  title: "UI/LaTool",
  mod,
  name: "LaTool",
  args: {
    tool: "la",
    status: "completed",
    defaultOpen: true,
    input: { action: "summary", capture: "cap-0007" },
    metadata: {
      action: "summary",
      captureId: "cap-0007",
      dir: "/work/fw/.yoma/la/cap-0007",
      file: "/work/fw/.yoma/la/cap-0007/capture.dsl",
      samplerate: 25_000_000,
      samples: 1_000_000,
      durationMs: 40,
      triggerPos: 10,
      channels,
      preview,
      decoders: [
        { key: "i2c0", id: "1:i2c", annotations: 128 },
        { key: "eeprom", id: "1:i2c_eeprom", annotations: 12 },
      ],
      device: { model: "DSLogic Plus", pid: "0x0020" },
    },
    output: [
      "capture cap-0007 · 25 MHz · 1,000,000 samples · 40 ms",
      "SCL 1204 edges · SDA 903 edges · SPARE idle · RESET 1 edge",
      "decoders: i2c0 (1:i2c, 128 annotations), eeprom (1:i2c_eeprom, 12 annotations)",
    ].join("\n"),
  },
})

export default {
  title: "UI/LaTool",
  id: "components-la-tool",
  component: story.meta.component,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = story.Basic

export const Events = {
  args: {
    tool: "la",
    status: "completed",
    defaultOpen: true,
    input: { action: "events", capture: "cap-0007", decoder: "i2c0", fromMs: 0, toMs: 8 },
    metadata: {
      action: "events",
      captureId: "cap-0007",
      samplerate: 25_000_000,
      samples: 1_000_000,
      durationMs: 40,
      channels,
      decoders: [{ key: "i2c0", id: "1:i2c", annotations: 128 }],
      window: { from: 0, to: 200_000 },
      truncated: true,
    },
    output: [
      "    0.412 ms  W 0x51  00 A5",
      "    0.688 ms  R 0x51  37 12 00 FF",
      "    1.204 ms  W 0x51  01 5A",
      "    1.480 ms  R 0x51  NACK",
      "    2.016 ms  W 0x51  02 00",
      "… 195 more lines (narrow the window with fromMs/toMs, or raise limit)",
    ].join("\n"),
  },
}

export const TimedOut = {
  args: {
    tool: "la",
    status: "completed",
    defaultOpen: true,
    input: { action: "capture", capture: "cap-0008", timeoutMs: 30000 },
    metadata: {
      action: "capture",
      captureId: "cap-0008",
      dir: "/work/fw/.yoma/la/cap-0008",
      samplerate: 100_000_000,
      samples: 0,
      durationMs: 0,
      channels: [
        { index: 0, name: "SCL", edges: 0 },
        { index: 1, name: "SDA", edges: 0 },
      ],
      timedOut: true,
      issues: 1,
      device: { model: "DSLogic Plus", pid: "0x0020" },
    },
    output: "trigger never fired within 30000 ms — nothing captured (falling edge on channel 1)",
  },
}
