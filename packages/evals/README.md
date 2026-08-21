# @yoma-desktop/evals —— agent 评测

评测的对象是 **整个 agent**(模型 + harness + 工具 + 提示词),不是某个函数。方法论抄 Anthropic 的
《Demystifying evals for AI agents》,术语也照搬:**task**(一道题)/ **trial**(跑一次)/ **grader**(判分器)/
**transcript**(全程记录,这里就是会话 JSONL)/ **outcome**(环境终态)。

这 **不是** bench 的判据层。产品里没有判据层是 2026-08-10 的产品决定(通过与否归模型);评测是开发期的东西,
只在开发机上跑,不进安装包。它复用 bench 的执行核心(`runTurnInChildProcess` → `turn-entry.ts`),
所以投影器、自动压缩、工具装配、会话落盘全部与桌面端和调试台是同一套 —— 评的就是用户用的那个 agent。

## 目录

```
packages/evals/
  src/                      runner、graders、会话读取、报告、CLI
  tasks/<组>/<id>/task.json  题目:一个目录一题;可附 files/(本题私有夹具)
  runs/<stamp>/             每次运行的产物(.gitignore)
    run.json                本次配置:模型、档位、k、git sha、时间
    results.jsonl           一行一个 trial
    summary.md              汇总
    sessions/               会话 JSONL(与桌面端同格式;--sessions-root 可指到桌面端目录以便回放)
    trials/<task>/<n>/      workspace/(agent 的 cwd)+ state/
```

turn 的输入/输出由 bench 的 runner 落在 `workspace/.yoma/bench/turns/turn-<stamp>.json{,.result.json}`
—— 那是它自己的约定,evals 不去挪它(挪了就得在两处维护同一个 stamp 公式)。
`results.jsonl` 的 `inputFile` / `outputFile` 记着绝对路径:出了事直接拿输入文件重放一轮。
`selftest` 的产物落在 `runs/selftest-<stamp>/`,格式与 run 完全一样,`report` 对它同样成立。

## 一次 trial 怎么跑

1. 新建工作目录 `runs/<stamp>/trials/<task>/<n>/workspace/`,按 `setup.files` 复制夹具进去。
   **不带 `.git`**,文件名不泄露题意 —— 文章里 Anthropic 自己撞过"agent 翻上个 trial 的 git history"。
2. 经 bench 的 `runTurnInChildProcess()` 起 `turn-entry.ts` 子进程跑一轮。**一 trial 一进程**,理由与 bench
   一字不差:yoma 的探针租约 / gdb 会话表 / log 采集器都是模块级全局,进程边界是免费且可靠的清理。
   `prompt` 原样交给 agent;`job` 由 runner 合成(`id` = task.id,`model` 来自 CLI,`task` = prompt)。
3. 收 `TurnResult`(text / toolCalls / usage / stopReason / errors)和会话 JSONL —— 工具的 **输出** 只在会话里
   (`TurnResult.toolCalls` 只有输入),groundedness 这类判分要读它。
4. 跑 graders,写一行 `results.jsonl`。全部 trial 结束后写 `summary.md`。

## task.json

```jsonc
{
  "id": "netlist-rp2040-main-controller",   // 必填,== 目录名,^[a-z0-9][a-z0-9.-]*$
  "title": "RP2040 板:识别主控",            // 必填,给人看
  "tags": ["netlist", "L1", "kicad"],       // 必填,汇总按它分组;约定 L1(纸面)/L2(仿真)/L3(真板)/L4(信箱)
  "requires": ["engines"],                  // 可选,能力门控:engines | qemu | board | datasheet-server;不满足则整题 skip
  "env": { "kind": "none" },                // 必填;v1 只实现 none(临时目录)。qemu / board / mailbox 预留,出现即报错
  "setup": {
    "files": [                              // 可选;from 相对仓库根,to 相对工作目录(保留扩展名,解析器认它)
      { "from": "engines/controller_map/tests/fixtures/RP2040_kicad_netlist.xml", "to": "board.xml" }
    ]
  },
  "prompt": "……",                           // 必填,交给 agent 的全文。必须写明答案格式(见下)
  "reference": {                            // 必填:参考解 + 出处。没有参考解的题不收
    "answer": "U3",                         // string | string[] | number | object
    "note": "check.py: controller is U3 / RP2040;已用 controller_map.exe 直跑核实"
  },
  "graders": [ /* 见下表,至少一个 */ ],
  "faux": {                                 // 可选。不写则 selftest 自动合成(见 selftest 一节)
    "good": [[{ "tool": "netlist", "input": { "netlistPath": "board.xml" } }], [{ "text": "```json\n{\"answer\":\"U3\"}\n```" }]],
    "bad":  [[{ "text": "```json\n{\"answer\":\"U1\"}\n```" }]]
  },
  "timeoutMs": 600000                       // 可选,默认 10 分钟;到点 abort,trial 记 error
}
```

**答案格式约定**:prompt 必须要求 agent 在 **最后一条消息** 里用 ```` ```json ```` 围栏给出
`{"answer": …}`;runner 取 `TurnResult.text` 里 **最后一个** json 围栏(与 bench 的 `parseMotherDecision` 同一纪律)。
没有这个锚点,代码判分无处下手,LLM judge 也会被长报告带偏。

`parseTask` 会在**开跑前**把几类"跑完 k 遍才发现"的错误拦下来,错误消息一律指到字段路径:
`id` 与目录名不一致、`prompt` 里根本没提 json 围栏(那样 `answer` 必判 fail,而看起来像模型不听话)、
`requires` 打错字(不认识的能力名在运行期一律视为不满足 → 一道永远跳过的题)、
以及**一个 equals/oneOf/matches 都不填的 `answer` grader**(它永远亮绿)。
一道坏题不阻断其余题 —— 它变成一条 `errors` 并让命令以 1 退出。

## graders

每个 grader 产出 `{ type, pass, detail }`,trial 的 `pass` = 全部 grader 通过;`score` = 通过的比例(部分分)。

| type | 字段 | 判什么 |
|---|---|---|
| `answer` | `field?`(默认 `answer`)、`equals` \| `oneOf` \| `matches`(正则,整串匹配)、`unordered?`(数组按集合比,默认 true) | 最终答案。归一化:trim、折叠空白、大小写不敏感、剥掉包裹的引号/反引号。数组逐元素归一化 |
| `grounded` | `needles?: string[]`(默认 = 参考答案的字符串/各元素)、`mode?: all\|any`(默认 all) | needles 必须出现在 **某次已完成工具调用的输出** 里(大小写不敏感)。打的是"没量就猜"—— 嵌入式的头号失败模式 |
| `tool-called` | `tool`、`minCount?`(默认 1)、`status?`(默认不限) | 至少调过该工具。**只在题面本身要求用该工具时用** —— 文章明说判路径会冤枉合法解法 |
| `tool-forbidden` | `tools: string[]` | 一次都不许调。安全红线用(analysis-only 题禁 flash / gdb / log) |

grader 是注册表(`src/graders/index.ts`),加新类型不改 runner。计划中的下一批:`llm-judge`、`workspace-files`(outcome)、`qemu-fail-to-pass`。

## trial 的四种状态

- `pass` / `fail` —— graders 的裁决。
- `error` —— 基础设施问题:子进程崩、硬超时、provider 失败到最后(`stopReason` 非空)、没拿到任何最终答案且 `errors` 非空。
  **不计入 pass 率,单独统计。** 混进 fail 会把"API 抖了"记成"agent 笨",文章把这叫 correlated failures。
- `skip` —— `requires` 不满足。

## selftest:参考解必须过,已知坏解必须不过

`cli.ts selftest` 对每题跑两遍 faux(假模型,零 key 零网络,其余全真:真 harness、真工具、真会话落盘):

- `good`:默认合成为「调一次 netlist 工具(`setup.files[0].to`)→ 用参考答案作答」,期望 `pass`;
- `bad`:默认合成为「不调任何工具,给一个错答案」,期望 `fail`。

题目可在 `faux` 字段自带剧本(比如答案只在 `part` 模式的输出里才看得见)。这一步就是文章说的
"每题要有 reference solution 证明可解且 grader 没配错",外加反向一刀 —— 一个永远亮绿的 grader
在 `details-check.ts` 上踩过一次,不想再踩。

## 指标只记不判

每个 trial 都记:assistant 消息数(turns)、工具调用次数与按名计数、工具报错数、tokens(input / output /
**reasoning** / cache)、cost、elapsedMs、stopReason、errors。2026-08-11 那次"107 条消息 reasoning 为 0"是读
transcript 才发现的,有这张表跑完一眼就看见。

## 报告

- **pass@1** = 单次通过率的均值;**pass@k** = k 次里至少一次通过;**pass^k** = k 次全过。
- 按题、按 tag 两张表;error / skip 单列;失败 trial 附 grader 的 detail 与会话文件路径。

## CLI

```
bun packages/evals/src/cli.ts list     [--tasks <dir>] [--filter <子串或 tag>]
bun packages/evals/src/cli.ts selftest [--tasks <dir>] [--filter …] [--concurrency 4] [--engines-dir …]
bun packages/evals/src/cli.ts run      [--tasks <dir>] [--filter …] [--k 3] [--model provider/model] [--thinking <档位>]
                                       [--concurrency 4] [--out <dir>] [--engines-dir …] [--config-dir …] [--sessions-root …]
bun packages/evals/src/cli.ts report   <runDir>
```

- `--engines-dir`:默认 `YOMA_ENGINES_DIR`,再默认仓内 `engines/`。**显式指的路要么对要么报错**
  (旗标或环境变量给了却没有 `bin/` → 当场失败并指名这个旗标);**落到仓内默认值而 `bin/` 是空的
  不算错误** —— 路径照传(engines 目录必须显式传,别让 yoma 的 `enginesDir()` 去向上瞎找),
  `requires: ["engines"]` 的题由门控安静跳过。worktree 里 `engines/bin` 就是空的(根 `.gitignore`
  忽略它),要跑网表题就 `--engines-dir` 指到主检出。
- `--config-dir`:默认 `~/.yoma`(凭据 / 技能 / 上下文与桌面端同一份 —— 评的就是用户的那个 agent);
  selftest 用临时目录隔离。
- `--model` 不给则与 bench 同一规则(本机第一个有凭据的 provider),但 run.json 会记下实际用的。

## 出题纪律(抄文章的)

1. 两个领域专家独立判应得出同一个 pass/fail。答案格式写进 prompt,不留解释空间。
2. 每题带 `reference`(含出处),`selftest` 必须绿。0% pass@k 先怀疑题,再怀疑 agent。
3. 判产出不判路径:`tool-called` 慎用;`tool-forbidden` 只做安全红线。
4. 正反平衡:"该用 X 时用"与"不该用时不用"成对出题。
5. 题面不泄露答案:夹具用中性文件名,prompt 不提夹具来源。
6. **读 transcript**。每次跑完至少抽 10 条全文读,看失败是真蠢还是 grader 冤枉了合法解法。
