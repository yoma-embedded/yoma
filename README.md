# Yoma

English | [简体中文](README.zh-CN.md)

An agent for **embedded engineers** — not just a code editor, but a full closed-loop debugging workflow grounded in hardware facts.

### Natively integrated embedded-specific tools

- **Flashing**: flash firmware across different hardware platforms
- **Log capture**: long-running log collection over serial or RTT, with analysis
- **gdb debugging**: breakpoints, single-stepping, expressions, fault analysis, and more
- **Logic analyzer**: DSLogic capture and protocol decoding (I²C / SPI / UART / CAN / …, 150 decoders bundled) — bus traffic read as transactions, diffed against what the firmware should have sent
- **Oscilloscope**: Siglent SDS824X HD over USB — configuration, measurements, screenshots, and triggered captures. The agent reads saved evidence; the UI provides waveform zoom, cursors, and screenshot history. Initial Mac hardware checks passed; Windows USB and recovery reliability remain unverified. See the [USB integration guide (Chinese)](docs/scope-usb.md).

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

- **Windows**: download `yoma-win-x64.exe`. The installer may show "Windows protected your PC": choose **More info → Run anyway**.
- **macOS (Apple Silicon)**: download `yoma-mac-arm64.dmg`, open it and drag Yoma into Applications. The package is not signed with an Apple Developer ID yet, so the first launch is blocked: open **System Settings → Privacy & Security** and click **Open Anyway** at the bottom, or run `xattr -dr com.apple.quarantine /Applications/Yoma.app` in a terminal. This build does not install updates by itself: when a new version is out the app tells you and opens the download page; install it over the old one (and allow it once more). There is no Intel Mac package yet, and the logic-analyzer engine is not bundled on macOS yet.

### 2. Configure an API key

Currently only DeepSeek and Kimi are supported.

- First time: the banner at the top says "No API key configured yet" → click **Connect**
- Afterwards: top-left menu **File → Settings** (or `Ctrl+,`) → **Providers** on the left → pick DeepSeek / Kimi → **Connect** → paste your API key

### 3. Toolchains (compiler / CMake / OpenOCD / GDB …)

Under **Toolchain** on the left side of Settings, audit the tools for your chip platform. Tools with an **Install** button (Arm GNU Toolchain, CMake, Ninja, OpenOCD, and Git on Windows) are installed by Yoma itself: it downloads the pinned official release, verifies the sha256, unpacks it into `~/.yoma/toolchains/`, and every later session finds it automatically. The agent also installs them on its own when a command turns out to be missing. Everything else (J-Link, STM32CubeProgrammer, Keil, ESP-IDF and other vendor installers) is installed by hand following the hint; paste the path afterwards.

Those directories are only on PATH inside Yoma sessions, not in your own terminal.

### 4. Datasheet search

Works out of the box: Yoma ships with the address of the public manual server. A search sends only your query text and the chip name. To use your own server, write to `~/.yoma/.env` on this machine (the `YOMA_DATASHEET_SERVER` environment variable takes precedence):

```
YOMA_DATASHEET_SERVER=http://your-server:port
```

Set `YOMA_DATASHEET_SERVER=off` to disable manual lookup entirely.

### 5. Generating an STM32 driver for the first time

Install STM32CubeMX on this computer. For complete project generation, use CubeMX to download the firmware package for your chip family into its local firmware repository.
In Yoma's toolchain settings, select the CubeMX installation and firmware repository if they are in custom locations.

Yoma ships the configuration engine and local database converter. On first use, it generates device packs from your CubeMX database into a user cache; project generation also uses your downloaded HAL/CMSIS sources.
These resources stay on your computer: they are not uploaded or included in Yoma installers. A changed database or engine produces a new cache version.
Missing resources are reported with configuration instructions. `schema` and raw netlist parsing need no CubeMX data.
See the [engine and data delivery notes](docs/桌面版发布流程.md#引擎和数据的交付边界).

### 6. Project profiles and memory

Open a project and ask the agent to inspect and save its configuration, remember a debugging finding, retrieve previous experience, or forget an entry. Later turns load recent memories and retrieve more history as needed. Memory stays local but retrieved content is sent to your selected model. Saving relies on the agent calling the memory tool, not on background transcription. [Usage, storage and limitations (Chinese)](docs/project-memory.md).

## Run from source

```bash
git clone https://github.com/yoma-embedded/yoma.git yoma
cd yoma
npm install
npm run engines:build    # build executables, including the local CubeMX converter; user data is prepared at runtime
npm run dev:desktop         # restart this command after changing the kernel
```

## Before submitting changes

Run `npm run check:ci`, the same entry point as Ubuntu CI: upstream hashes, uncached type checks, ripgrep setup, and all unit tests.
On Windows, also run `npm run test:windows`. For process, path, or desktop packaging changes, wait for the PR's Windows CI (including the build and Electron checks) before releasing. A passing Mac run does not verify Windows behavior. Native engine builds and full engine smoke tests run in the dedicated engine/release workflows.

## License

MIT. Third-party sources are listed in `NOTICE`: the desktop app is inherited from [opencode](https://github.com/anomalyco/opencode); the kernel is derived from [pi](https://github.com/earendil-works/pi) (`packages/ai`, `packages/agent`, `packages/chord` and `packages/telemetry` are vendored from pi; `packages/kernel/src/host` is a derived work).
