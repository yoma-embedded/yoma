# 独立内核 CLI（第一步）

这个入口用于**不打开桌面端，直接使用并验收自己的 agent**。它接的是当前 Harness，
不是 pi 的新持久化运行时，也不是桌面/ACP 的另一层转发。

## 开始使用

在仓库根目录执行（需要 Bun；Windows 上 bash 工具还需要 Git Bash）：

```bash
bun install --frozen-lockfile
bun run cli --cwd /path/to/project
bun run cli --cwd /path/to/project --continue
bun run cli --cwd /path/to/project --session <启动时显示的会话ID>
bun run cli --cwd /path/to/project -p "读一下 AGENTS.md，说明这个工程如何验证"
bun run cli --help
```

Windows 将工程路径换成自己的路径，如 `--cwd "C:\work\firmware"`。
一次性模式 `-p` 支持 stdin；stdout 只有助手正文，工具进度与状态写 stderr。
例如 `git diff | bun run cli -p "审查这份差异"`（必须在 Yoma 仓库运行；
其他工程可用 `bun /path/to/yoma/packages/coding-agent/src/cli.ts`）。
一次性执行成功返回 0，模型失败返回 1，Ctrl+C 停止返回 130，SIGTERM 返回 143。

凭据复用 `~/.yoma/auth.json`，已在桌面/ACP 配置过 API key 就不用再配。
也支持提供商自己的环境变量，例如 `DEEPSEEK_API_KEY`。
不在命令行参数里传 key，也不要把凭据提交进 Git。

```bash
bun run cli --cwd /path/to/project --model deepseek/deepseek-v4-flash --thinking max
```

- 模型选择优先级：显式 `--model` → 恢复会话保存的模型 → `YOMA_PROVIDER/YOMA_MODEL`
  → `settings.json` 默认 → 本机首个有凭据的提供商。
- 新会话默认请求 `max`；按 pi-ai 的模型能力钳制。恢复保留原档位，除非传了 `--thinking`。
  **启动和每次切换都显示实际模型与档位**；这些会影响费用。
- `/models` 查看已配置模型，`/model provider/id` 和 `/thinking high` 在空闲时修改。
- `--config-dir` 隔离凭据与全局上下文；`--sessions-dir` 单独指定会话存放位置。

## 对话与停止

直接输入文字就是下一轮，会话自动保存。

| 操作                             | 行为                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `/status`                        | 工程、模型、档位、会话 ID、JSONL 文件路径                 |
| `/history`                       | 当前分支用户与助手正文，不展开工具结果                    |
| `/compact [说明]`                | 调用 Harness 手动压缩，原始历史仍在文件里                 |
| `/retry`                         | 调用 Harness 重试上一条失败的助手回合，不重复添加用户输入 |
| `/abort` / 忙时 Ctrl+C           | 停止当前模型请求/工具，等清理完成后继续对话               |
| `/quit` / 空闲时 Ctrl+C / Ctrl+D | 停止、清理并退出                                          |

忙时不排队新输入；会提示等本轮结束，或先停止。这里是逐行 CLI，不是全屏 TUI：
没有多行编辑器、命令补全、图片显示或会话树浏览器。

会话默认存放在 `~/.yoma/cli/sessions`，与桌面会话分开。
`--continue` 只找**同一工程路径**下最近修改的 CLI 会话；无匹配时明确报错。
恢复只读历史，不会自动重跑中断的模型请求或工具。异常退出时可能留下未完成工具调用，
**这不是崩溃恢复/断点续跑保证**；操作已经产生的文件或硬件效果不会因停止而撤销。
同一 CLI 会话不能被两个进程同时写；强杀遗留的 `.cli-lock` 必须确认进程已退出后手动删除。
会话文件含对话与工具结果，不要随代码公开提交。

## 你需要把关的路径

```text
packages/coding-agent/src/cli.ts             进程入口
  ├─ cli/args.ts                           参数与帮助
  ├─ cli/main.ts + cli/terminal.ts          stdin/stdout、命令、停止
  └─ cli/session.ts                        模型、工具、上下文、会话装配
       └─ packages/agent/src/harness/agent-harness.ts
            └─ packages/agent/src/agent-loop.ts
```

CLI 只装配 `read / bash / edit / write`，复用现有工具、资源发现和系统提示词。
模型解析暂时复用 `src/acp/models.ts`（只是共享模块放在这个目录，**不启动 ACP 适配器**）。
无 Electron、kernel host、UI、硬件引擎或工具链自动安装，也没有增加依赖。
工具按本机用户权限运行，**这不是沙箱**；bash 仍然能运行机器上已有的命令。

这一版刻意**没有自动压缩、自动重试、操作恢复或新状态机**。
它先提供一个可日常使用的验收入口；之后替换内核时保留终端层，改 `cli/session.ts` 的接缝。
不要为了升级内核，先复制一套桌面宿主策略到 CLI。

离线测试（假模型 + 真 Harness + 真文件/进程工具，不使用 key 或硬件）：

```bash
bun test --cwd packages/coding-agent test/cli.test.ts test/models.test.ts
bun run typecheck --force
```

## 多台电脑开发

用同一个分支传递**代码**；worktree 只是单机并行工作的便利，不负责跨机同步。

本机做好一个可验收的小步后，检查差异、提交并推送：

```bash
git diff
# 确认后 git add / git commit
git push -u origin feature/core-cli
```

另一台机器（先确保原工作已保存）：

```bash
git fetch origin
git switch --track origin/feature/core-cli  # 首次
# 已有本地分支则 git switch feature/core-cli && git pull --ff-only
bun install --frozen-lockfile
bun run cli --help
```

不要两台机器同时改完直接盲目 push；切换机器前先提交/推送，另一台先拉取。
API key、工具链、本机工程路径和 CLI 会话不由 Git 自动同步，分别在每台机器配置。
