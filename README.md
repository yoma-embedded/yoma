# Yoma

English | [简体中文](README.zh-CN.md)

An agent for **embedded engineers** — not just a code editor, but a full closed-loop debugging workflow grounded in hardware facts.

### Natively integrated embedded-specific tools

- **Flashing**: flash firmware across different hardware platforms
- **Log capture**: long-running log collection over serial or RTT, with analysis
- **gdb debugging**: breakpoints, single-stepping, expressions, fault analysis, and more
- **Logic analyzer**: DSLogic capture and protocol decoding (I²C / SPI / UART / CAN / …, 150 decoders bundled) — bus traffic read as transactions, diffed against what the firmware should have sent
- **Oscilloscope**: Siglent SDS800X HD over USB or LAN — analog waveforms with statistics and a text plot, the scope's own measurements, screenshots the agent can look at, and arm/collect around a reset or power-up

### Grounded in hardware facts

- **Schematic / netlist parsing**: parse schematics from net or PDF files to extract pin mappings and peripheral connections, so the agent understands the hardware
- **Datasheet search**: search a datasheet library for register/peripheral descriptions by chip, as first-hand evidence for code and a guard against AI hallucination (works out of the box against the public manual server; point it at your own if you prefer)

### Always start from an example project — never write drivers from scratch

Search vendor-verified examples and add capabilities step by step: get to a green light first, then change one thing and verify one thing at a time. For STM32 you can also write a configuration document; after validation it automatically generates driver code that compiles and runs.

### Autonomous closed-loop verification

Code change -> project compiles -> firmware flashed and verified, with board-level evidence from **logs or gdb**; register-level conclusions must cite the datasheet.

### Remote debugging (experimental)

- **Cross-machine multi-round loop**: the development side issues instructions and firmware; the debugging side reproduces on the board and sends back logs, captured data and conclusions, round after round until the problem converges
- **git mailbox sync**: per-round instructions, attachments, code patches and board-side evidence travel through a git repository, fully auditable
- **Independent agents on both ends**: each side runs its own agent; model context stays on the local machine and never crosses the network

## User guide

### 1. Install

Installers are published on [GitHub Releases](https://github.com/yoma-embedded/yoma/releases).

Download `yoma-win-x64.exe`. The installer may show "Windows protected your PC": choose **More info → Run anyway**.

### 2. Configure an API key

Currently only DeepSeek and Kimi are supported.

- First time: the banner at the top says "No API key configured yet" → click **Connect**
- Afterwards: top-left menu **File → Settings** (or `Ctrl+,`) → **Providers** on the left → pick DeepSeek / Kimi → **Connect** → paste your API key

### 3. Toolchains (compiler / CMake / OpenOCD / GDB …)

Under **Toolchain** on the left side of Settings, audit the tools for your chip platform. Tools with an **Install** button (Arm GNU Toolchain, CMake, Ninja, OpenOCD, and Git on Windows) are installed by Yoma itself: it downloads the pinned official release, verifies the sha256, unpacks it into `~/.yoma/toolchains/`, and every later session finds it automatically. The agent also installs them on its own when a command turns out to be missing. Everything else (J-Link, STM32CubeProgrammer, Keil, ESP-IDF and other vendor installers) is installed by hand following the hint; paste the path afterwards.

On Windows the bash the agent runs commands with comes the same way: a clean Windows has no bash, so the first time one is needed Yoma offers to install Git (the portable MinGit, ~39 MB, which ships bash plus ls/grep/sed and friends); the next command in that session already works. Machines with Git for Windows installed simply use its Git Bash.

Those directories are only on PATH inside Yoma sessions, not in your own terminal.

### 4. Datasheet search

Works out of the box: Yoma ships with the address of the public manual server. A search sends only your query text and the chip name. To use your own server, write to `~/.yoma/.env` on this machine (the `YOMA_DATASHEET_SERVER` environment variable takes precedence):

```
YOMA_DATASHEET_SERVER=http://your-server:port
```

Set `YOMA_DATASHEET_SERVER=off` to disable manual lookup entirely.

### 5. Generating an STM32 driver for the first time

Generating a driver project needs the family's HAL and CMSIS sources, which the installer does not ship (1.1 GB across 26 families). The first time you generate for a family, the agent runs `stm32config fetch-fw` itself: it downloads pinned versions of the components from ST's official GitHub repositories (a few MB to a couple dozen MB per family) into `~/.yoma/stm32/fw/<FAMILY>/`, where they survive Yoma upgrades. You can also just tell the agent "fetch the STM32F1 firmware". STM32MP1 is the exception: ST publishes no component repositories for it, so place the sources by hand following the layout of `engines/stm32-config-kernel/tools/fetch-fw.ps1`.

Developers running from source can still land several families at once with the repository script (copied from a local CubeMX installation when present):

```powershell
powershell -File engines/stm32-config-kernel/tools/fetch-fw.ps1 -Families STM32F1
```

That output lands in `engines/data/stm32/fw/STM32F1/` (relative to the repository root); generation prefers `~/.yoma/stm32/fw` and falls back to it.

## Run from source

```bash
git clone https://github.com/yoma-embedded/yoma.git yoma
cd yoma
bun install
bun engines/build.ts    # netlist parsing / STM32 tools. The STM32 device data (irpacks) ships with the repository; CubeMX is only needed to regenerate it
bun dev:desktop         # restart this command after changing the kernel
```

### Standalone core CLI (experimental)

No Electron or engine build is needed for this entry point. After `bun install`:

```bash
bun run cli --cwd /path/to/project
bun run cli --cwd /path/to/project --continue
bun run cli --cwd /path/to/project -p "Read AGENTS.md and explain how to verify this project"
```

Uses the existing Harness directly with **read / bash / edit / write**, streaming output,
Ctrl+C cancellation and saved sessions. Credentials reuse `~/.yoma/auth.json`; CLI sessions
are separate under `~/.yoma/cli/sessions`. New sessions request `max` thinking, clamped to
model support; the actual model and level are displayed. Use `--model provider/id` and
`--thinking off` to override. Compaction and retries are **manual**, and restoring history
does not automatically replay interrupted tools. This is not the new pi runtime or a sandbox.
See `bun run cli --help` and [the CLI/development guide (Chinese)](packages/coding-agent/CLI.md).

## License

MIT. Third-party sources are listed in `NOTICE`: the desktop app is inherited from [opencode](https://github.com/anomalyco/opencode); the kernel is derived from [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai` is an npm dependency; `packages/agent` and `packages/coding-agent` are derived works).
