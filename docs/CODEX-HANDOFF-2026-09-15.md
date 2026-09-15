# Yoma：Mac → Windows / Codex 接续

## 先读结论

第 1–6 步已按当前约定范围完成。第 6 步的完成指工具按新内核接口重写、装配和回归验证完成；Windows 安装包、干净环境与真实板子的完整验收仍待做。示波器和例程库是主动停放的功能，不计入本轮第 6 步。第 7 步拆包改名仍可选。

下一阶段建议是：让 Windows 上一份可独立安装的 Yoma，完成一项真实嵌入式调试任务，再验证双机信箱闭环。这个建议尚未展开实现。

## 接手时的事实

- 日期：2026-09-15。
- 仓库：`git@github.com:yoma-embedded/yoma.git`；分支：`yoma-v2`。
- 代码基线：`88b3f98064450340c52c1af60c03eaa1cbe9727e`，标题“netlist 与 stm32config 接回内核，补齐产物隔离和诊断回路”。
- 生成本文前工作树干净，本地记录的 `origin/yoma-v2` 与 HEAD 一致；本次未重新 fetch 验证远端。
- 前一轮交付曾报告 `dc77473`。当前提交与它的 Git tree 相同，均为 `0c6740b7e09645868c7858ba5f7c7d81c488b97b`，只是提交身份变了。
- Claude 原会话 ID：`adc756bc-0820-44cf-984c-20d99a2228dc`。该会话及其记忆在 Mac 本地，Git 不携带它们；接续不依赖运行 `claude --resume`。
- 原路线 Artifact：<https://claude.ai/code/artifact/ee38f81d-a7b1-48e4-9032-cd42be46f9a8>。它是 2026-09-12 的快照，只写到第 6 步前三刀，不能据此判断今天的进度。

新机器先核对自己的 `git status`、分支和提交，不要覆盖已有改动。

## 必要阅读顺序

1. 根 `AGENTS.md` 与本文。
2. 要改 app / desktop 时，先读各包的 `AGENTS.md`。
3. `CLAUDE.md` 中与当前任务相关的历史教训；不要假设 Codex 会自动加载这个文件。
4. `README.md` / `README.zh-CN.md` 是面向用户的权威文档。若旧路线或文档与当前实现冲突，核实后报告并修正文档。
5. 做分发时读 `docs/桌面版发布流程.md`、`engines/build.ts`、`packages/desktop/engines.lock.json`、`.github/workflows/desktop-win.yml` 与 `.github/workflows/engines.yml`。
6. 做双机任务时读 `docs/信箱闭环-协议与双机部署.md` 与 `docs/调试台-Windows双机上手.md`。

## 路线与不可破坏的边界

目标是减少接缝，让嵌入式工具沿同一套会话、协议和界面工作。

- 餐厅：app / session-ui / ui / util / desktop。界面只看浏览器安全的菜单与工具契约。
- 菜单：kernel 的 `.` 门，提供协议、视图类型和客户端，不含 Node 和发动机。
- 厨房：kernel 的 `./host`，组装发动机、管理会话和投影；bench 是第二个宿主。
- 工具间在厨房内：`host/domain/` 与 `host/tools/<名字>/{contract.ts,session.ts}`。契约从 `./tools/*/contract` 与 `./tools/contracts` 出口给界面，执行代码不越界。
- 发动机：agent / ai / chord / telemetry，按上游哈希锁定，源码不改；升级只走同步机制。
- 用标准 package exports 与 `boundary.test.ts` 守边界，不恢复 alias，不引入第二套装配。

七步状态：

| 步骤 | 状态 |
| --- | --- |
| 1. 原装 pi 发动机进仓、哈希封条 | 完成 |
| 2. 工具卡片归零、万能卡回退 | 完成 |
| 3. 厨房切换新发动机、旧工具进 attic | 完成 |
| 4. coding-agent 并入 kernel、拔掉别名、机器守边界 | 完成 |
| 5. 前端盘点、删除不用的页面和组件 | 完成 |
| 6. 依新接口逐个重写当前范围内的工具 | 完成 |
| 7. 菜单拆 protocol / 厨房改名 host | 可选，暂缓 |

当前 16 个工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`、`powershell`、`toolchain`、`flash`、`log`、`la`、`gdb`、`datasheet`、`netlist`、`stm32config`。前四个来自发动机，其余在工具间装配。串口是 log 的一种源，不恢复独立 serial 工具。工具进度、读图缩放、烧录确认也已接入。

示波器与例程库停放在原 Mac 仓库外的 `../yoma-parked/`，不会随本仓 Git 迁移。功能还要，但方案未定；不要擅自搬回主线。

用户强调一次只做一种性质的改动、按工具或独立问题切提交，交付时用自己的话说明改变与原因。报告行数增减；新功能净增要解释。不要自动提交、推送或重启用户正在使用的 app / 内核。

## 最后一刀做了什么

`netlist` 与 `stm32config` 接回内核。重点文件在 `packages/kernel/src/host/tools/` 两个同名目录、`host/domain/tool-output.ts`、`packages/kernel/test/tools-{netlist,stm32config}.test.ts`，以及 `engines/controller_map/controller_map/mcu_desc.py`。

- netlist 每次运行用独立产物目录，避免并发覆盖或读到上一次产物；三个必要 JSON 产物逐个检查。
- 大输出落到 `.yoma/tool-output/`，正文保留有界预览和完整文件路径；该目录自带忽略规则，避免产物卷入提交。
- 补齐非普通文件、非 STM32 型号、异常退出码、缺失诊断和 JSON 形状的失败路径。
- board_ir 保留底层 MCU_UNKNOWN 诊断，避免只剩无用的异常文字。
- 核对 UART 枚举和 Asynchronous 模式；实际生成代码验证波特率、停止位与字长。
- 两个工具的回归共 58 个测试。此次工具交付合计 14 个文件，新增 1831 行、删除 4 行；净增来自恢复工具能力与回归覆盖。

## 已有验证与边界

下面是上一轮在 Mac、上述同一代码树上实际跑出的结果，不代表 Windows 已经验证：

- 全量单测：206 个文件通过；2603 个测试通过、7 个跳过。
- 强制 typecheck：11/11 包通过，根 tsconfig 通过。
- lint：0 错误、75 条既有警告。
- `npm run build:desktop` 通过。
- desktop 的 `smoke`、`e2e:ipc`、`e2e:renderer`、`smoke:mailbox`、`e2e:mailbox`、`e2e:paint` 通过；paint 含 30 项检查。
- controller_map 的 `tests/check_board_ir.py`：58 项检查通过。
- STM32 测试显式配置 `YOMA_TEST_STM32_DATA`，使用 Mac 兄弟仓库 my-pi 的真实器件数据。新机器必须换成自己的有效路径。
- desktop smoke 中 LA 因缺 Mac 二进制而跳过，默认 STM32 数据路径也不可用；另行指定数据路径的测试覆盖了 STM32 引擎。这些跳过不能描述成硬件全通过。
- 本轮没有 Windows 真机验收，没有连接真实板子完成烧录调试。Mac 的临时测试日志不随 Git 迁移。

只增加本文无需重跑功能测试。Windows 上请按实际变更与环境重新验证，不照抄 Mac 结论。

## 下一阶段：先补分发，再跑真实任务

### 第一刀建议：理清并验证 Windows 引擎与数据交付

现有资料有一处冲突，尚未修：部分 CLAUDE.md / 工具文案说“irpacks 不随包发”，实际 `engines/build.ts` 的 `--dist` 会复制 irpacks；缺失时通常失败，只有显式 `--allow-missing-irpacks` 才放行。Windows CI 使用了这个放行参数。HAL/CMSIS firmware 数据则标记为 `not-bundled`，属于另一种资源。

应先沿构建脚本 → Release 资产 → 桌面安装包 → 运行时查找路径核对实际交付，再统一缺失时的获取方法和文案。不要把“开发机跑通”当作“用户装好就能跑”。

旧 Mac 的 `engines/data/stm32` 存在无效相对软链接；不要把该链接或旧 Mac 绝对路径当作 Windows 的数据配置。

### 然后做一项真实板子任务

选定一块实际可用的 STM32 板子与已验证例程，先立原样跑通的基线，再只增加一个能力。届时使用仓库的 routine-driven-development 技能。

验收链：原理图/网表 → 器件事实和配置 → 代码与构建 → flash → log / gdb / la 取证 → 判断结果；加入一个已知故障，确认 agent 能定位并修复。以任务实际需要选择仪器，无须为清单强行调用全部工具。

单机闭环成立后，把同一任务放进 mother / runner 双机信箱：研发端有源码与构建环境，工位端有板子和附件。用真实卡点决定下一轮优先级。暂不为名字拆包，也不提前恢复停放功能。

## Windows 接续操作

先在 Mac 将本文提交并推送到 `yoma-v2`。这些是交接操作示例，不代表助手已经执行：

```sh
git add docs/CODEX-HANDOFF-2026-09-15.md
git commit -m "docs: add Windows Codex handoff"
git push origin yoma-v2
```

Windows 新目录中：

```powershell
git clone --branch yoma-v2 git@github.com:yoma-embedded/yoma.git
cd yoma
git status --short --branch
git log -1 --oneline
```

已有检出则先检查未提交修改，再同步同一分支；不要直接覆盖或 reset。代码基线提交应仍在历史里，最新提交可能是本文的提交。

用 Windows Codex 打开这个 yoma 目录。Node/npm 按根 package.json 的 engines / packageManager 配置，CI 使用 Node 24；在 Windows 重新 `npm ci`。引擎按目标平台获取或构建，核实数据位置。不要复制 Mac 的 node_modules、虚拟环境、二进制或 out 目录。

Git 带走代码、文档和仓库技能；不会带走 Mac 聊天历史、停放目录、未跟踪的引擎数据或本机配置。模型凭据在 Windows 本机单独配置，不能写进本文或 Git。开发不依赖完整复制旧聊天，但可以把旧聊天当作补充背景。

### 粘贴给 Windows Codex 的首条消息

> 请接续 Yoma 开发。先读根 AGENTS.md、docs/CODEX-HANDOFF-2026-09-15.md 和 CLAUDE.md 中相关章节；改 app/desktop 前读包级 AGENTS.md。核对当前分支、工作树、提交及 Windows 环境。第 1–6 步已按当前范围完成，别重做工具迁移；示波器与例程库仍停放，第 7 步可选暂缓。下一阶段先检查 Windows 的引擎和数据交付：核对 irpacks 实际打包行为、CI 放行缺数据的影响、安装包运行时路径及缺资源提示。结合当前代码说明第一刀的具体范围和验证方法，再继续工作。遵守上游哈希封条、kernel 出口和工具契约边界；不要自动提交、推送或重启正在使用的 app/内核。汇报必须区分已验证、跳过和仍待真机验收。
