# Yoma

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

## 快速开始

```bash
git clone https://github.com/yoma-embedded/yoma-pi.git yoma-pi
cd yoma-pi
bun install
bun engines/build.ts    # 网表解析 / STM32 工具。STM32 配置需要本机已装 CubeMX：build 会解析器件库生成 irpack(不入库)
bun dev:desktop         # 改内核要重启这条命令
```

启动后在设置里配 API key。无权限确认，能烧录、能 gdb、能跑命令——只在你信任的本机上用。

**STM32驱动配置工具获取HAL库源码** — 只需在第一次调用STM32驱动生成工具前跑一次，按照芯片族拉取：

```powershell
powershell -File engines/stm32-config-kernel/tools/fetch-fw.ps1 -Families STM32F1
```

有 CubeMX 且下过固件包时，脚本会先从 `%USERPROFILE%\STM32Cube\Repository`（如 `C:\Users\你\STM32Cube\Repository`）拷贝；否则从 ST 的 GitHub 拉。产物落在仓库内 `engines/data/stm32/fw/STM32F1/`（相对克隆目录）。

**数据手册服务器配置** — Yoma 不内置服务器，要有一台跑着手册 RAG 服务的机器（团队自建或内网部署）。在本机写 `~/.yoma/.env`：

```
YOMA_DATASHEET_SERVER=http://你的服务器:端口
```

重启 `bun dev:desktop` 后，agent 的 `datasheet` 工具才能检索手册。


## 许可

MIT。第三方来源见 `NOTICE`：桌面端继承自 [opencode](https://github.com/anomalyco/opencode)；`packages/ai` 来自 [pi](https://github.com/earendil-works/pi)。
