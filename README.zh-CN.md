# Yoma

[English](README.md) | 简体中文

面向**嵌入式工程师**的agent——不止是代码编辑，而是可以根据硬件事实全流程闭环调试。

### 原生集成嵌入式特定工具

- **烧录工具**：支持不同硬件平台的烧录
- **日志采集**：支持串口或 RTT 长时间采集日志并分析
- **gdb 调试**：断点、单步、表达式、故障分析等功能
- **逻辑分析仪**：DSLogic 采集与协议解码（I²C / SPI / UART / CAN 等，内置 150 个解码器），总线流量按事务读，可与固件应发的内容做差分
- **示波器**：Siglent SDS824X HD，通过 USB 设置、量测、截图和触发采集；agent 读取保存的证据，前端可缩放波形、放置游标和回看截图。Mac 首轮真机检查通过，Windows USB 与故障恢复稳定性仍待验证，见[USB 接入与验收](docs/scope-usb.md)。

### 贴合硬件事实

- **原理图 / 网表解析工具**：从 net格式或者pdf格式解析原理图，解析引脚映射与外设连接，理解硬件信息
- **数据手册检索**：在手册库里按芯片搜寄存器/外设说明，作为代码的第一手证据，避免AI幻觉（内置公共手册服务地址，联网即用；可换成自建的）

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

- **Windows**：下载 `yoma-win-x64.exe`。安装可能提示“Windows 已保护你的电脑”：选 **更多信息 → 仍要运行**。
- **macOS（Apple Silicon）**：下载 `yoma-mac-arm64.dmg`，打开后把 Yoma 拖进「应用程序」。安装包目前没有 Apple 开发者签名，首次打开会被拦：到 **系统设置 → 隐私与安全性**，在底部点 **仍要打开**；或在终端执行 `xattr -dr com.apple.quarantine /Applications/Yoma.app`。这种包不会自动安装更新：有新版本时应用里会提示，点一下打开下载页，下载后覆盖安装（需要再放行一次）。Intel Mac 暂无安装包；逻辑分析仪引擎暂未随 macOS 包提供。

### 2. 配 API key

目前只支持 DeepSeek 和 Kimi。

Agent 需要 API key；串口监视器和 GDB 手动控制不需要配置模型。

- 第一次：顶部提示「还没配 API key」→ 点 **去连接**
- 之后：左上角菜单 **File → Settings**（或 `Ctrl+,`）→ 左侧 **提供商** → 选 DeepSeek / Kimi → **连接** → 粘贴 API key

### 3. 工具链(编译器 / CMake / OpenOCD / GDB …)

设置左侧 **工具链** 按芯片平台逐项核账。带「安装」按钮的工具(Arm GNU Toolchain、CMake、Ninja、OpenOCD、Windows 上的 Git)Yoma 可以直接帮你装:从官方发布页下载钉死版本的压缩包、校验 sha256、解压到 `~/.yoma/toolchains/`,之后所有会话自动认得。会话里 agent 撞到「命令不存在」时也会自己装。其余工具(J-Link、STM32CubeProgrammer、Keil、ESP-IDF 等厂商安装器)按提示手动安装后把路径填进来即可。

Windows 上的 Git Bash 里、macOS/Linux 的终端里,这些目录不会自动进你自己的 PATH —— 它们只对 Yoma 的会话生效。

### 4. 数据手册检索

装完即用:Yoma 内置了公共手册服务器的地址，检索服务运行在远端，需要网络连接，无需用户自建或在 Windows 本机启动服务器。检索时发出去的只有你的查询语句和芯片型号。要换成自建服务器,在本机 `~/.yoma/.env` 写入(环境变量 `YOMA_DATASHEET_SERVER` 优先级更高):

```
YOMA_DATASHEET_SERVER=http://你的服务器:端口
```

不想联网查手册就写 `YOMA_DATASHEET_SERVER=off`。

### 5. 第一次生成 STM32 驱动

先在本机安装 STM32CubeMX。生成完整工程时，还需要通过 CubeMX 下载所用芯片族的固件包。
如果安装在自定义位置，在 Yoma 工具链设置中指定 CubeMX 安装目录和固件仓库。

Yoma 安装包携带配置引擎和本地转换器。首次使用时，从你的 CubeMX 数据库生成器件缓存；
生成工程再读取你已下载的 HAL/CMSIS。数据库或引擎变化后，会生成新的缓存版本。
**这些数据不上传、不随 Yoma 安装包分发。** 缺少资源时会提示补充本机配置；`schema` 和原始网表解析不依赖 CubeMX。
详见[引擎和数据的交付边界](docs/桌面版发布流程.md#引擎和数据的交付边界)。

### 6. 工程档案与项目记忆

打开工程后，可以在对话中让 agent 检查并保存工程配置，或「记住这个调试结论」。Agent 保存带依据的工程知识、调试经验和任务交接，后续会话自动读取最近的记忆、按需检索更多历史；需要删除时直接说「忘记这条记忆」。[使用方式、存储位置与限制](docs/project-memory.md)。

### 7. 嵌入式工作台

从首页直接打开仪器，也可以使用固定显示的「串口与日志 / GDB 调试 / 示波器 / 逻辑分析仪」工具栏。控制台默认展开，新建工作区还没发送消息时也能使用；在 Agent 输入框打字不会切换或弹出仪器。

- **串口监视器**：选择或填写端口、设置波特率，再点击连接。刷新会重新发现端口，断开会释放当前日志源。端口与波特率既能下拉选择，也能手动输入，并按工程记忆。底部发送栏支持 **UTF-8 文本 / Hex**、None / LF / CR / CRLF 换行、回车发送、↑ / ↓ 历史命令和独立的 Ctrl+C 按钮。串口采用 **8N1、无流控**，单次最多发送 4096 字节；无需 Agent 就能收发、筛选日志、跟随最新输出。TCP 与命令日志源仍为只读。
- **GDB**：选择已有服务器、OpenOCD、J-Link 或 QEMU，填写 ELF 和连接参数后，直接连接、继续、暂停、单步、设置断点及只读求值。手动按钮与 Agent 共用当前会话的调试器，不会发送聊天请求。
- **示波器历史波形**：拖动平移，滚轮或双指缩放，双击适配全幅，点击放置 A/B 游标。面板明确区分保存的采样点、包络预览和采集参数，不冒充实时采集。示波器、逻辑分析仪的采集仍通过 Agent 工具执行。

## 从源码运行

```bash
git clone https://github.com/yoma-embedded/yoma.git yoma
cd yoma
npm install
npm run engines:build    # 构建引擎和 CubeMX 本地转换器；用户数据在使用功能时准备
npm run dev:desktop         # 改内核要重启这条命令
```

## 提交前检查

运行 `npm run check:ci`：它与 Ubuntu CI 共用入口，检查上游哈希、强制类型检查、准备 ripgrep 并跑全量单测。
Windows 上另跑 `npm run test:windows`；涉及子进程、文件路径或桌面打包的改动，须等 PR 的 Windows CI（含构建和 Electron 验收）通过后再发布。Mac 本地全绿不能代替 Windows 验证。原生引擎构建和完整引擎冒烟留在专门的引擎／发布流程。

## 许可

MIT。第三方来源见 `NOTICE`：桌面端继承自 [opencode](https://github.com/anomalyco/opencode)；内核派生自 [pi](https://github.com/earendil-works/pi)（`packages/ai`、`packages/agent`、`packages/chord`、`packages/telemetry` 为 vendored 上游拷贝，`packages/kernel/src/host` 为派生）。
