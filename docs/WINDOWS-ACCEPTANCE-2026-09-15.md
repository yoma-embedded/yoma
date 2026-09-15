# Windows 引擎、数据与安装验收（2026-09-15）

## 结论

本机完成了自包含引擎构建、NSIS 出包、独立目录静默安装，以及安装后内核、引擎和首次会话验收。
这不是干净 Windows 机器或真实板子的完整验收。HAL/CMSIS 未交付，Windows 部分旧测试夹具仍失败，不能报告全仓测试全绿。
第 1–6 步迁移没有重做；示波器、例程库和第 7 步仍按交接暂缓。

后续已修复本页记录的 32 项 Windows 夹具失败，两工具真实引擎测试 58/58 通过；详见
[Windows 引擎测试夹具收尾](WINDOWS-ENGINE-FIXTURES-2026-09-15.md)。本页保留首次安装验收的历史结果。

后续 PowerShell 专项修复、Windows 实际编译和 IPC/paint 验收见
[Windows PowerShell 使用验收](WINDOWS-POWERSHELL-2026-09-15.md)。下文安装包信息保留首轮基线。

## 基线与本机环境

- 分支 `yoma-v2`，接手 HEAD `6254cc4`；它的父提交是交接代码基线 `88b3f98`。接手时工作树干净。
- 没有 fetch/修改远端，没有提交或推送；本轮修改留在工作树。
- Windows 11 x64；PATH 上 Node `22.23.1`、npm `10.9.8`。原 node_modules 为旧 Bun 布局。
  用临时 Node `24.14.0` / npm `11.19.0` 完成 `npm ci`（未修改全局安装）。
  安装时 `ini@7` 提示该 Node 24 小版本低于其要求；后续构建/类型检查使用本机 Node 22.23.1，
  产品运行时为 Electron `42.3.3` / Node `24.15.0`。后续可统一到满足依赖要求的 Node 24 版本。
- Rust、uv、MSYS2 ucrt64、CMake、Arm GDB、OpenOCD 已存在。
- `engines/data/stm32` 是有效 Windows junction，指向本仓 `engines/stm32-config-kernel/data`，有 27 个 pack。
- 只读查询 GitHub：`engines-v0.2.0` Release 不存在；现有 `engines.lock.json` 的预编译下载路径不可用。
  本轮使用本机 `--dist`，没有伪造或改指另一个未经核验的 Release。

## 本轮修正

1. **安装后内核无法加载**：desktop 将 raw TS 的 `pi-ai` 列在 dependencies，electron-vite 将它外部化。
   源码工作区可因 workspace 软链通过，安装后的 app.asar 却报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。
   将它移入 devDependencies，与 kernel 一样内联；锁文件同步。上游源码未改。
2. **交付数据不可见**：暂存时对显式目录也验 manifest 的二进制哈希与 irpack 数量，并把 manifest 带入安装包。
   安装后的 smoke 使用 `YOMA_DESKTOP_DIR` / `YOMA_ENGINES_DIR`，真正启动引擎、加载全部器件数据，报告 HAL/CMSIS 缺失。
   `--require-stm32-data` 能使缺数据成为失败；Windows 发布 CI 接入安装后 smoke。
3. **错误文案**：纠正“irpack 不随包出货”。普通 `--dist` 会带数据，Windows CI 显式允许缺失；
   HAL/CMSIS 是另一份不打包的资源。README、发布流程、工具提示和 Release 文案保持同一解释。

## 已验证

| 项目 | 结果 |
| --- | --- |
| 上游哈希封条 | 364 个源码/测试文件与 40 个生成数据快照匹配 |
| kernel 边界 + desktop 打包配置测试 | 2 文件，9 项通过 |
| 强制 typecheck | 11/11 包、根 tsconfig 通过，0 缓存命中 |
| lint | 0 错误、75 警告 |
| 格式与 diff 检查 | 修改的 TS 文件通过 Prettier，`git diff --check` 通过 |
| Windows 自包含引擎构建 | Rust + 三个 PyInstaller 程序 + LA/DLL/Python，分发自检通过 |
| 实际器件数据 | 27 包全量加载，2240 条 MCU 记录 |
| LA 软件解码 | 演示文件输出预期 300 条 I²C 注解；未接采集硬件 |
| 真实工具调用 | 自包含引擎经 stm32config 查询 STM32F405；netlist 解析 ODrive 网表并生成三份 board IR 产物 |
| 缺失/损坏路径 | 无数据时 schema 可用、配置报明确提示；smoke 可选数据模式跳过、必需模式失败；损坏数据失败；暂存与 smoke 均拒绝 manifest 数量不符 |
| desktop 构建与 NSIS 打包 | 成功，Dev 渠道 0.1.4 |
| 独立目录静默安装 | 成功，app.asar 与 resources/engines/manifest.json 到位 |
| 安装后 smoke | 16 工具、五个必需引擎启动、LA 解码、27 个数据包均通过 |
| 安装后 renderer E2E | 15 项通过，包括首次会话、MessagePort 排队、错误结构过 contextBridge、mailbox 与 updater 桥 |

## 失败、跳过与尚未验证

- `tools-netlist.test.ts` + `tools-stm32config.test.ts` + desktop 配置测试的首次运行：22 通过、32 失败、5 跳过。
  32 个失败均在旧 `.cmd` 假引擎启动处报 `spawn EINVAL`；共享夹具仍以 Bun/libuv 可直接启动 cmd 为前提，
  普通 Node 不成立。真实引擎层还被 `process.platform !== "win32"` 显式跳过。本轮未改这个独立问题，
  另以实际 Windows 自包含程序经过工具执行层取证。全仓单测未跑，不将这些失败或跳过写成通过。
- 初次安装产物 smoke 和 renderer E2E 捕获 pi-ai 外部化错误；修复后重建、重打包、安装，两项均通过。
- HAL/CMSIS 未随包交付，`stm32config generate` 固定使用 `data/stm32/fw`，没有独立目录参数或自动获取。
  完整工程生成/编译、已验证例程基线、已知故障定位与修复均尚未验收。
- 本机装有开发工具；迁移安装目录与 PyInstaller 分发审计不能等同于“未装 Python/Rust/CubeMX 的干净机器”。
- 没有启动当前正式 app，没有重启用户 app/内核；只运行独立测试进程。未跑 paint、IPC、mailbox 全套或自动更新。
- Windows PnP 名称查询未命中 J-Link/ST-Link/STM32/DSLogic/常见 USB 串口；尚未确定板子、探针、接线、例程、网表。
- 仓库没有 `routine-driven-development`；`.agents/` 被 Git 忽略，本机常用技能目录也未找到。
  真实任务开始前需要补齐该技能或由维护者提供替代流程，不能假称已按它执行。
- 未运行任何真实板子烧录、log/gdb/LA 采集或 mother/runner 双机任务。

## 本机产物与证据

- 安装包：`packages/desktop/dist/yoma-win-x64.exe`，168621693 字节，未发布。
- SHA-256：`fb7d92ef99b1f376366a4068f05b8c8f20acaeace4e21bd6432d4bef17d64ba6`。
- 自包含引擎：`engines/dist/`；暂存目录：`packages/desktop/.engines-stage/`。
- 本轮安装目录：`.yoma/windows-acceptance-20260915/installed/`（Yoma Dev，保留供复查）。
- 本机日志：`.yoma/windows-acceptance-20260915/{build,package,typecheck,installed-smoke,installed-renderer}.log`。
- 真实工具与失败路径的临时验证脚本：`.yoma/windows-acceptance-20260915/check.ts`，产物在同目录 `run-mm6rrc/`。
  上述构建产物和本机日志被忽略，不随 Git 迁移。

## 下一步

先解决 Windows 假引擎夹具和真实引擎测试的平台跳过，再落实板子、已验证例程、原理图/网表、探针/串口接线及技能来源。
按实际芯片准备 HAL/CMSIS 与构建环境；从例程原样跑通起步，增加一个能力，再加入一个已知故障验证诊断与修复。
单机真板闭环通过后再复用同一任务验收 mother/runner 信箱；不要用本轮软件冒烟代替这些验收。
