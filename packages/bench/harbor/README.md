# 把 yoma 接进 Harbor(开源跑批器)

用开源 benchmark 给 yoma 打分,而不是自建评测集。这个目录只有胶水:任务、环境、判据、
榜单对照全部来自 [Harbor](https://github.com/harbor-framework/harbor) 及其数据集。

```
harbor run -d terminal-bench/terminal-bench-2-1 --agent yoma_agent:Yoma \
    -m deepseek/deepseek-v4-flash-vision-exp -n 3
  │
  ├─ 每题一个 Docker 容器(任务自带 environment/Dockerfile)
  │   install()  装 node + 上传 dist/yoma-eval-entry.mjs
  │   run()      node yoma-eval-entry.mjs --cwd "$PWD" --instruction-file … --out … --events …
  │   post_run() 读 result.json → 填 token/cost/metadata,events.jsonl → ATIF trajectory.json
  │
  └─ verifier   tests/test.sh → /logs/verifier/reward.txt   ← 判据不归我们管
```

`yoma-eval-entry.mjs` 内部就是 bench 的 `runTurn` + `createKernelHost`,所以压缩、轮级重试、
思考档位、13 个工具的装配、会话 JSONL 与桌面端**完全同一条路**。

---

## 一次性准备

```bash
# 1. 构建纯 node 产物(容器里只有 node,没有 bun、没有本仓检出)
bun --cwd packages/bench build:eval        # → packages/bench/dist/yoma-eval-entry.mjs

# 2. 装跑批器
uv tool install harbor

# 3. 凭据(只走环境变量,理由见下)
export DEEPSEEK_API_KEY=sk-...

# 4. Docker daemon 要在跑
docker desktop start && docker info
```

### Windows 上必须先设这三个环境变量

**实测踩过,全都不是可选的**:

```bash
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1      # 见下 ①
export PYTHONPATH="$PWD/packages/bench/harbor"   # 见下 ②(在仓库根执行)
```

① **中文 Windows 的 GBK 控制台会让 Harbor 当场崩**:它的 rich 进度条用盲文点字符
(`U+2826`)画动画,GBK 编不了,`UnicodeEncodeError` 直接把整个 run 带走 —— 一个字的
结果都拿不到。这和 yoma 自己在 `agent/src/harness/env/nodejs.ts` 的 `getShellEnv` 里
钉 `PYTHONIOENCODING` 是同一类坑,只是这次轮到我们当受害者。

② **`--agent` 要的是 Python 模块路径,不是文件路径。** Harbor 的 `import_symbol` 走
`importlib.import_module()`,喂 `packages/bench/harbor/yoma_agent.py:Yoma` 会报
`No module named 'packages/bench/harbor/yoma_agent'`。正确写法是把目录挂上 `PYTHONPATH`,
然后 `--agent yoma_agent:Yoma`(PowerShell 是 `$env:PYTHONPATH='...'`)。

③ **job 名不能复用**:同名目录已存在且 config 不同时 Harbor 抛 `FileExistsError`,
不会自动换名。失败重跑记得换 `--job-name`。

## 零 key 冒烟:先验链路,再花钱

判据一定不过(faux 脚本是死的),这次要看的是**装 node → 传产物 → 跑起来 → 收产物**这条链路。

```bash
harbor run -d harbor/hello-world --agent yoma_agent:Yoma \
    -m deepseek/deepseek-v4-flash-vision-exp \
    --ak faux=packages/bench/harbor/faux-smoke.json \
    -o ../../evals/jobs --job-name yoma-faux-smoke -q -y
```

**已跑通(2026-08-26)**:1 trial / **0 exceptions** / reward 0.0(faux 解不出题,是预期的),
耗时 5m17s(大头是容器里装 node)。产物齐全:

```
<job>/hello-world__<id>/agent/
  instruction.md                          送进去的任务
  yoma-result.json                        结构化结果(工具调用/用量/错误)
  yoma-events.jsonl                       事件流
  trajectory.json                         ATIF transcript(harbor view 能看)
  yoma.txt                                stdout
  yoma-config/sessions/--app--/*.jsonl    会话 —— 拿回桌面端就能回放
```

`--app--` 这个目录名说明 `--cwd "$PWD"` 正确解析成了容器镜像的 WORKDIR(`/app`);
ATIF 里能看到 `bash` 工具的真实输出,证明工具是在容器里跑的。

## 正式跑

```bash
# 通用 coding 能力
harbor run -d terminal-bench/terminal-bench-2-1 --agent yoma_agent:Yoma \
    -m deepseek/deepseek-v4-flash-vision-exp -n 3 -k 3

# 对照组:同一个模型换 harness —— 这一栏才是 yoma 的成绩
harbor run -d terminal-bench/terminal-bench-2-1 -a terminus-2 -m deepseek/deepseek-v4-flash -n 3 -k 3
harbor run -d terminal-bench/terminal-bench-2-1 -a opencode  -m deepseek/deepseek-v4-flash -n 3 -k 3
```

> **对照组不是可选项。** Terminal-Bench 榜上没有任何 DeepSeek 行,yoma 的绝对分没有参照系。
> 榜单量级供参考:同一个 Fable 5,Claude Code 83.8% vs Terminus 2 80.4%(harness 之差约 3 分),
> 而 Terminus 2 换模型是 66%→80%(模型之差 15 分)。所以第一圈要看的是"yoma 有没有比
> Terminus 2 低得离谱",不是分数本身。

其它值得跑的数据集(`harbor run -d <名字>`):

| 数据集 | 题数 | 测什么 |
|---|---|---|
| `terminal-bench/terminal-bench-2-1` | 89 | 终端里的真实任务(16 类,含 debugging) |
| `aider/aider-polyglot` | 225 | 6 种语言的编辑题,含 C++ —— 最接近"改 C 代码" |
| `benchflow/skillsbench` | 87 | agent 会不会用技能(配 `--skill` 做有/无对照) |
| `swe-bench/swe-bench-verified` | 500 | issue → patch,fail-to-pass。镜像大,先抽子集 |

## agent kwargs(`--ak key=value`)

| kwarg | 作用 |
|---|---|
| `bundle` | 产物路径,默认 `packages/bench/dist/yoma-eval-entry.mjs`(env: `YOMA_EVAL_BUNDLE`) |
| `timeout_ms` | 一轮的墙钟上限。**建议设成 task agent 超时的 ~90%**,理由见下 |
| `faux` | 假模型脚本,零 key 冒烟用(env: `YOMA_EVAL_FAUX`) |
| `thinking` | `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`。不填落到 kernel 默认 `max` |

---

## 四条要记住的事

**1. 凭据只走环境变量,不写 `auth.json`。**
`--config-dir` 落在 `/logs/agent/yoma-config`(会话 JSONL 要被收走,以便拿回桌面端回放),
而那个目录整个会下载到本机 —— 把 key 写进去等于把它落进每一次 trial 的日志。
pi-ai 的 deepseek provider 本来就认 `DEEPSEEK_API_KEY`,`ModelConnectionSpec(passthrough=True)`
会原名传进容器。

**2. 超时要给 yoma 自己收。**
到点 yoma 会 abort 并**照常写出** `result.json`(工具调用、用量、错误都在);Harbor 硬杀之后
什么都拿不到 —— 一次超时于是从"有证据的失败"变成"没有数据的空洞"。所以 `timeout_ms`
要略小于 task 给 agent 的超时。

**3. 退出码 2 = 我们的配置错误,不是 agent 没做出来。**
缺 key、未知模型走这条,适配器把它翻译成 `AgentAuthenticationError` / `ModelNotFoundError`。
混在一起会把"忘了配 key"记成一次模型失败。

**4. `cost` 为 0 时记成 `None` 而不是 0。**
pi-ai 的定价表里没有条目时 cost 会**静默**是 0。首跑必须人工核"钱 ≠ 0 且量级合理";
faux 模式下 cost 恒为 0,所以 faux 的数字永远不能当成绩。

---

## 版本

**PyPI 的 `harbor` 0.22.0 与 GitHub main 上的 0.22.0 内容不同**(版本号没跟着动)。实测差异:

| | PyPI 0.22.0(`uv tool install harbor`) | GitHub main @ d49ab85 |
|---|---|---|
| agent 能力声明 | `SUPPORTS_ATIF: bool = True` | `capabilities = AgentCapabilities(atif=True)` |
| `harbor.agents.capabilities` | **不存在** | 有 |

本适配器对着 **PyPI 版**写(那是团队里每个人 `uv tool install harbor` 装到的)。
升级 Harbor 之后如果 import 报 `ModuleNotFoundError` 或 `AttributeError`,先对一下这两处。
源码参考放在 `D:\MyCode\yoma\evals\harbor`(main 分支,比 PyPI 新,**不要照着它改**)。

## 本机自检(不需要 Docker)

```bash
# 产物在纯 node 下跑得起来 + 工具真的执行
node packages/bench/dist/yoma-eval-entry.mjs --cwd <临时目录> \
    --instruction "写一个 smoke.txt" --out result.json --events events.jsonl \
    --faux packages/bench/harbor/faux-smoke.json

# 适配器能被 Harbor 导入,ATIF 转换对不对
bun --cwd packages/bench test src/eval
```
