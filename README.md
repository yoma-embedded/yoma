# Yoma

[English](README.en.md) | 简体中文

面向**嵌入式工程师**的agent——不止是代码编辑，而是可以根据硬件事实全流程闭环调试。

### 原生集成嵌入式特定工具

- **烧录工具**：支持不同硬件平台的烧录
- **日志采集**：支持串口或 RTT 长时间采集日志并分析
- **gdb 调试**：断点、单步、表达式、故障分析等功能

### 贴合硬件事实

- **原理图 / 网表解析工具**：从 net格式或者pdf格式解析原理图，解析引脚映射与外设连接，理解硬件信息
- **数据手册检索**：在手册库里按芯片搜寄存器/外设说明，作为代码的第一手证据，避免AI幻觉（需配 `YOMA_DATASHEET_SERVER`路径）

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

### 3. 烧录 / GDB / 日志 工具路径配置

本机安装项目用的 OpenOCD、J-Link 或厂商工具链。设置左侧 **工具链** 里按芯片平台所需路径配置。

### 4. 数据手册检索

Yoma 不内置数据手册检索服务，需要一个存储数据手册的服务器地址。在本机 `~/.yoma/.env` 写入：

```
YOMA_DATASHEET_SERVER=http://你的服务器:端口
```

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
bun install
bun engines/build.ts    # 网表解析 / STM32 工具。STM32 配置需要本机已装 CubeMX：build 会解析器件库生成 irpack
bun dev:desktop         # 改内核要重启这条命令
```

## 许可

MIT。第三方来源见 `NOTICE`：桌面端继承自 [opencode](https://github.com/anomalyco/opencode)；内核派生自 [pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-ai` 为 npm 依赖，`packages/agent`、`packages/coding-agent` 为派生）。
