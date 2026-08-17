# 安全

## 这是一个能碰硬件的 agent

Yoma 没有权限确认。agent 想调什么工具就调：烧录、gdb、跑命令、改文件。约束它能做什么的是**这台机器上有什么**（探针、工具链、工程目录），不是弹窗。

只在你信任的本机上用。不要对着生产板、不要对着别人的仓库、不要在共享账号里开着它过夜。

同机的交互会话和调试台可以同时抢探针，报错有时会像「没插板子」。先看是不是另一个会话占着。

## 数据手册服务器

没有内置服务器。只有你自己配了 `YOMA_DATASHEET_SERVER`（环境变量或 `~/.yoma/.env`），手册工具才会去访问那个地址。

## 报告漏洞

请用 GitHub 的 [private vulnerability report](https://github.com/yoma-embedded/yoma-pi/security/advisories/new)，不要开公开 issue 贴密钥、凭据或可利用的细节。
