# Yoma

[English](README.md) | 简体中文

面向**嵌入式工程师**的agent——不止是代码编辑，而是可以根据硬件事实全流程闭环调试。

### 原生集成嵌入式特定工具

- **烧录工具**：支持不同硬件平台的烧录
- **日志采集**：支持串口或 RTT 长时间采集日志并分析
- **gdb 调试**：断点、单步、表达式、故障分析等功能
- **逻辑分析仪**：DSLogic 采集与协议解码（I²C / SPI / UART / CAN 等，内置 150 个解码器），总线流量按事务读，可与固件应发的内容做差分
- **示波器**：Siglent SDS800X HD，USB 或 LAN 直连——模拟波形带统计与文本示意图、示波器自带量测、agent 能看的截图、围绕复位/上电的武装与收取

### 贴合硬件事实

- **原理图 / 网表解析工具**：从 net格式或者pdf格式解析原理图，解析引脚映射与外设连接，理解硬件信息
- **数据手册检索**：在手册库里按芯片搜寄存器/外设说明，作为代码的第一手证据，避免AI幻觉（装完即用，内置公共手册服务器；可换成自建的）

### 永远从例程工程起步，不空白写驱动

从厂商已验证例程检索、逐步加能力——先跑通绿点，再改一处、验一处。STM32 还可写配置文档，校验后自动生成可编译运行的驱动代码

### 自主闭环验证

代码改动 -> 工程编译通过 -> 烧录固件验证，有 **log 或 gdb** 的板级证据；寄存器级结论要有手册引用。

### 支持远程调试（experimental）

- **跨机多轮闭环**：开发端下发指令与固件，调试端上板复现并回传 log、采集数据与结论，多轮往返直到问题收敛
- **git 信箱同步**：轮次指令、附件、代码补丁、板端证据经 git 仓库传递，全程可审计
- **双端独立 agent**：两端各跑一个 agent，模型上下文留在本机，不过网

## 使用指南

### 1. 安装

安装包发在 [GitHub Releases](https://github.com/yoma-embedded/yoma/releases)。

下载 `yoma-win-x64.exe`后。安装可能提示“Windows 已保护你的电脑”：选 **更多信息 → 仍要运行**。

### 2. 配 API key

目前只支持 DeepSeek 和 Kimi。

- 第一次：顶部提示「还没配 API key」→ 点 **去连接**
- 之后：左上角菜单 **File → Settings**（或 `Ctrl+,`）→ 左侧 **提供商** → 选 DeepSeek / Kimi → **连接** → 粘贴 API key

### 3. 工具链(编译器 / CMake / OpenOCD / GDB …)

设置左侧 **工具链** 按芯片平台逐项核账。带「安装」按钮的工具(Arm GNU Toolchain、CMake、Ninja、OpenOCD、Windows 上的 Git)Yoma 可以直接帮你装:从官方发布页下载钉死版本的压缩包、校验 sha256、解压到 `~/.yoma/toolchains/`,之后所有会话自动认得。会话里 agent 撞到「命令不存在」时也会自己装。其余工具(J-Link、STM32CubeProgrammer、Keil、ESP-IDF 等厂商安装器)按提示手动安装后把路径填进来即可。

Windows 上的 Git Bash 里、macOS/Linux 的终端里,这些目录不会自动进你自己的 PATH —— 它们只对 Yoma 的会话生效。

### 4. 数据手册检索

装完即用:Yoma 内置了公共手册服务器的地址。检索时发出去的只有你的查询语句和芯片型号。要换成自建服务器,在本机 `~/.yoma/.env` 写入(环境变量 `YOMA_DATASHEET_SERVER` 优先级更高):

```
YOMA_DATASHEET_SERVER=http://你的服务器:端口
```

不想联网查手册就写 `YOMA_DATASHEET_SERVER=off`。

### 5. 第一次生成 STM32 驱动

用这个工具前，按所用的芯片类别把拉一次 HAL 源码即可：

```powershell
powershell -File engines/stm32-config-kernel/tools/fetch-fw.ps1 -Families STM32F1
```

当已经安装了 CubeMX 时从其安装目录拷贝，否则从 ST 官方 GitHub 仓库拉。产物例如 `engines/data/stm32/fw/STM32F1/`（相对仓库根目录）。

## 从源码运行

```bash
git clone https://github.com/yoma-embedded/yoma.git yoma
cd yoma
npm install
npm run engines:build    # 网表解析 / STM32 工具。STM32 配置需要本机已装 CubeMX：build 会解析器件库生成 irpack
npm run dev:desktop         # 改内核要重启这条命令
```

### 独立内核 CLI（实验性）

不需要 Electron，也不用先构建引擎。`npm install` 后直接运行：

```bash
npm run cli -- --cwd /path/to/project
npm run cli -- --cwd /path/to/project --continue
npm run cli -- --cwd /path/to/project -p "读一下 AGENTS.md，说明这个工程如何验证"
```

直接连接当前 Harness，只有 **read / bash / edit / write** 四工具，支持流式回答、
Ctrl+C 停止和会话保存/恢复。凭据复用 `~/.yoma/auth.json`；CLI 会话独立存放于
`~/.yoma/cli/sessions`。新会话默认请求 `max` 思考档位，按模型能力钳制，启动时显示实际值；
用 `--model provider/id`、`--thinking off` 显式选择。压缩/重试是**手动**的，
恢复历史不会自动重跑中断工具；这不是 pi 新运行时，也不是沙箱。
详见 `npm run cli -- --help` 和 [CLI 使用与多机开发说明](packages/coding-agent/CLI.md)。

## 许可

MIT。第三方来源见 `NOTICE`：桌面端继承自 [opencode](https://github.com/anomalyco/opencode)；内核派生自 [pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-ai` 为 npm 依赖，`packages/agent`、`packages/coding-agent` 为派生）。
