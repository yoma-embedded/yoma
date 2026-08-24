# Yoma

English | [简体中文](README.zh-CN.md)

An agent for **embedded engineers** — not just a code editor, but a full closed-loop debugging workflow grounded in hardware facts.

### Natively integrated embedded-specific tools

- **Flashing**: flash firmware across different hardware platforms
- **Log capture**: long-running log collection over serial or RTT, with analysis
- **gdb debugging**: breakpoints, single-stepping, expressions, fault analysis, and more

### Grounded in hardware facts

- **Schematic / netlist parsing**: parse schematics from net or PDF files to extract pin mappings and peripheral connections, so the agent understands the hardware
- **Datasheet search**: search a datasheet library for register/peripheral descriptions by chip, as first-hand evidence for code and a guard against AI hallucination (requires `YOMA_DATASHEET_SERVER` to be configured)

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

### 3. Tool paths for flashing / GDB / logs

Install the OpenOCD, J-Link or vendor toolchain your project uses on this machine. Then, under **Toolchain** on the left side of Settings, configure the paths required for each chip platform.

### 4. Datasheet search

Yoma does not bundle a datasheet search service; you need the address of a server that stores the datasheets. On this machine, write to `~/.yoma/.env`:

```
YOMA_DATASHEET_SERVER=http://your-server:port
```

### 5. Generating an STM32 driver for the first time

Before using this tool, fetch the HAL sources once for the chip family you use:

```powershell
powershell -File engines/stm32-config-kernel/tools/fetch-fw.ps1 -Families STM32F1
```

If CubeMX is already installed, the sources are copied from its installation directory; otherwise they are pulled from ST's official GitHub repositories. The output lands in, for example, `engines/data/stm32/fw/STM32F1/` (relative to the repository root).

## Run from source

```bash
git clone https://github.com/yoma-embedded/yoma.git yoma
cd yoma
bun install
bun engines/build.ts    # netlist parsing / STM32 tools. STM32 configuration needs CubeMX installed locally: build parses the device database to generate irpacks
bun dev:desktop         # restart this command after changing the kernel
```

## License

MIT. Third-party sources are listed in `NOTICE`: the desktop app is inherited from [opencode](https://github.com/anomalyco/opencode); the kernel is derived from [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai` is an npm dependency; `packages/agent` and `packages/coding-agent` are derived works).
