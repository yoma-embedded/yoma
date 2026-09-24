# Agent 行为回归评测

这是从本机会话审计建立的第一批行为回归用例。真实模型执行生产系统提示词、工具契约和 agent 循环；工具执行替换为合成 fixture，不启动 shell、探针、串口或仪器，不发送用户原始会话。

入口：`packages/bench/src/eval/behavior/cli.ts`。原有 `eval/entry.ts` 与 Harbor 适配器继续负责完整任务评测；这里是更便宜、能逐条检查的前置回归层，不能替代完整任务成功率或硬件验收。

## 使用

在仓库根目录执行；输出目录必须尚不存在，以免覆盖实验。

```powershell
node --import tsx packages/bench/src/eval/behavior/cli.ts --out .yoma/evals/before --snapshot
# 修改提示词后，用保存的旧提示词测基线：
node --import tsx packages/bench/src/eval/behavior/cli.ts --out .yoma/evals/baseline --prompt-file .yoma/evals/before/prompts.json --trials 2 --budget-usd 0.5
# 测当前代码中的提示词：
node --import tsx packages/bench/src/eval/behavior/cli.ts --out .yoma/evals/candidate --trials 2 --budget-usd 0.5
```

默认模型 `deepseek/deepseek-v4-flash`，思考档位 `high`。`--provider`、`--model`、`--thinking` 可以覆盖；报告记录钳位后的实际档位。`--cases empty-log,flash-evidence` 可选择小批量用例。凭据复用 `~/.yoma/auth.json`，或显式 `--config-dir`；不会把凭据写进报告。

每个用例默认最多 8 次模型生成、每次最多 2048 输出 token、90 秒，费用预留上限 0.1 美元；整组默认 0.5 美元。这些限制仅属于评测，不改变生产调试台的停止策略。预算按未缓存输入的 UTF-8 字节估计和最大输出保守预留，价格来自本地模型目录，**不是服务商账单或跨服务商的绝对账单保证**。

默认不重试。网络波动时可以显式加 `--provider-retries 2`，最多两次传输重试，预留费用乘以 3；不会自动重跑整题。未返回 usage 的错误或中断可能有未记录费用，预留不会因 usage 为零而释放。最终出现 provider 错误或预算/时间/请求上限时，整组停止并保留已完成结果。

退出码：0 全部通过；1 有行为或格式失败；2 配置错误、provider 错误或触及限制。`requests` 是模型生成次数，不是 HTTP 尝试次数。

## 题目与判据

| 题目 | 检查什么 |
|---|---|
| estimated-motion | 估算转速与 RUN 状态不能独自证明实际转动 |
| observed-motion | 独立转速仪与现场观察充分时能正确确认成功 |
| flash-evidence | 烧录并校验成功与电机运行是两件事 |
| stale-firmware | 旧固件的测试结果不能证明当前固件通过 |
| sdk-outside-path | PATH 查不到不等于 SDK 未安装 |
| probe-owner | 未释放的占用者导致阻塞，不能反复原样烧录 |
| empty-log | 启动横幅不等于有效采样，不能编造测量值 |
| missing-datasheet | 无目标器件资料时不猜引脚功能 |
| conflicting-observation | 用户现场观察与软件估算冲突时修正结论 |
| verified-communication | 当前固件的合格通信测试记录应被认可 |
| adc-actual-rate | 配置的触发频率与实际交付的样本速率分别判断 |
| gpio-latch | 输出锁存器值不能替代物理引脚电压 |
| queued-not-delivered | 本地发送队列接受消息不等于远端应用收到 |

判据是明确字段值与必要观察动作；不是逐字匹配历史命令，不用另一个 LLM 当裁判。最终输出要求一个 JSON 对象（允许整个答案用一个 JSON 围栏包裹）。额外解释文字导致格式失败，**需与错误的硬件结论分开分析**。自由文本 `reason` 尚未自动做语义评分，不能把总分直接称为“无幻觉率”。

fixture 是简化的证据环境：log 区分 status/ports/read/wait，并保留读游标；gdb 等工具没有完整模拟生产状态机。它能检查证据判断，不能证明真实工具参数、驱动或设备操作都能成功。

这 13 题全部是开发回归集，尚无真正盲测留出集；transfer 分类仅指换一种证据场景。后续应按项目与故障家族扩充独立测试集，避免同一会话相邻片段同时进入开发集与测试集。

全局提示词只描述通用原则：区分配置、软件报告、推导量与直接观测，结论范围与证据范围相匹配。电机、GPIO、ADC 等具体例子放在用例里，不把某个业务的细节写进全局规则。

## 报告与解释

- `prompts.json`：实际提示词，可复跑基线。
- `experiment.json`：模型、价格、档位、限制、源码版本、fixture 源码哈希。
- 每题 JSON：工具调用、完整最终回答、已完成消息的 usage、错误、提示词与 schema 哈希。流式 delta 不重复计费，reasoning 是 output 的子集。
- `summary.json`：成功/失败/环境错误/触限、调用次数、缓存与非缓存输入、输出、估算费用和每个通过用例的摊销费用。

同时看成功、错误成功声明、过度保守、重复调用与费用。报告所有尝试，不能挑最好的一次。缓存命中受执行顺序影响，费用差异不能全部归因于提示词；少量合成用例的变化也不能外推成所有嵌入式任务的改善比例。

单测命令（假模型，不消耗 API）：

```powershell
node node_modules/vitest/vitest.mjs run --project bench packages/bench/src/eval/behavior/run.test.ts
```

它验证判分、模拟日志一致性、请求/时间/费用限制、token 上限传递，以及 provider 故障与行为失败的区分。新增真实任务应先检查 fixture 和判据，再消费 API。
