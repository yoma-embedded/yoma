# 上游基线与同步流程

上游：<https://github.com/earendil-works/pi>。**当前完整 commit、包版本和文件 SHA-256，以 `upstream-lock.json` 为准。** 首次复制基线为 `9767ba275`（0.85.1）。

## 三个命令各做什么

| 命令 | 用途 | 是否改文件 |
| --- | --- | --- |
| `npm run upstream:check` | 检查本地受保护文件与锁定清单是否一致 | 否，完全离线 |
| `npm run upstream:diff` | 取回上游、验证旧基线，再预览增删改与包配置变化 | 否（只写镜像缓存） |
| `npm run upstream:update -- --packages-reviewed <完整SHA>` | 同步受管理文件，最后更新锁定清单 | 是 |

**来源是上游仓库本身，不是某台机器上的某个目录。** 不给 `--source` 时，工具按 `upstream-lock.json` 里的
`repository` 在 `.upstream-cache/pi.git` 维护一份裸镜像并 `fetch`（该目录已进 `.gitignore`，删掉只是丢缓存，
下次自己重新拉）。换一台机器、换一个同事、在 CI 里，同一条命令都跑得起来，而且结果只由"解析出来的
那个完整 commit"决定——而不是由"那台机器旁边那个 pi 检出当时是什么状态"决定。

联网只是把 Git 对象取回来，安全性没有变松：对象是内容寻址的。同步仍然只读一个解析好的完整 commit、
仍然用旧 commit 的 Git 对象核对本地基线、仍然逐文件比 sha256。改了任何一个字节，sha 就对不上。
锁里的 `repository` 会被交给 `git clone`，所以按白名单只认 `https://` 与 `file:///`（挡 `ext::` 这类能借
Git 传输层执行命令的地址）。

`upstream:check` 通过，只表示仍符合已经锁定的版本，不能说明没有新的上游提交。

`--source <本地Git仓库>` 保留给两种情况：完全离线，或者要同步一份还没推上去的本地检出（自己的分支）。那条路一个字节都不下载。`--offline` 表示用已有镜像、不 fetch。`--ref` 默认 HEAD，即镜像里上游默认分支的最新提交，也可以给分支、tag 或 commit。先预览，再将输出的完整 SHA 交给 update，确保两次使用同一提交。工具不改变任何 pi 检出，也不自动创建提交。

## 平时按这个顺序更新

1. 执行 `npm run upstream:check`，确认当前受保护文件仍符合旧基线。
2. 执行 `npm run upstream:diff`，工具自己取回上游，列出受管理文件的变化与上游包配置变化。
3. 上游 package.json 有变化时先适配本地依赖（见下节），`npm install` 重新安装。
4. 执行 `npm run upstream:update -- --packages-reviewed <预览中的完整SHA>`。
5. 执行 `npx turbo typecheck --force`、`npm test`，以及 desktop 的七道闸门。API 有变化时，在消费者中适配后再验证。
6. 将本次源码、锁定清单、必要配置及测试改动一并保存到自己的 Git 提交。文档、CLI 与其他本地文件的改动应分别核对。

版本字符串没有变化也可能有新的 commit。本次 EventStream 优化仍标为 0.85.1，准确基线要看完整 commit。

## 自动同步的范围

以下目录中的 Git 跟踪文件由工具整体管理，新增和删除也会同步：

- `packages/ai/src`
- `packages/agent/src`
- `packages/agent/test`
- `packages/chord/src`
- `packages/telemetry/src`

另有两个明确选择的上游文件：

- `packages/agent/scripts/generate-telemetry-docs.ts`
- `packages/ai/test/event-stream.test.ts`

不整体复制 AI 的 provider 测试，以免默认测试意外调用真实服务。每次上游改动引入新的相关测试时，要明确选择文件、补入同步范围和 Vitest include；自动复制源码不等于测试范围会自动扩展。

CLI、examples、本地 package.json、构建配置、自己的文档不属于自动同步范围。首次复制的上游 README、CHANGELOG、agent 文档和 LICENSE 也不在源码哈希清单里；有相关变化时单独审阅更新。运行测试需要的文档依赖若改变，也要一并适配。

## 遇到本地改动时

工具先验证旧清单及所有受保护文件，发现内容变化、文件丢失或未锁定的新增文件会停止，不会直接重算哈希将修改后的副本当成上游。

同步时还会从 pi 的旧 commit 读取 Git 对象，核对 Git 文件清单确实来自那个提交。即使这些源码文件和 lock 同时被改写，也不能通过同步工具的旧基线验证。生成数据不在 Git 中，按下面单独说明的快照来源处理。

需要自己维护的适配应放在 CLI 或包配置。确实要修改核心时，应明确建立自有补丁管理流程；这个工具目前负责原样同步，不自动解决源码冲突。

更新内容来自已解析的固定 Git commit，忽略 pi 工作树中的未提交修改与未跟踪文件。工具会拒绝越界路径和不支持的文件类型，并在写入前再次检查本地基线。

多文件同步不是文件系统级原子事务。工具先准备目标内容，最后写锁；若写入途中发生磁盘错误，旧锁不会被提前推进，应检查具体差异并恢复本次未完成写入，再重试。

## 上游 package.json 改变时

本工程的 package.json 是源码运行所需的适配，不能被上游发布配置直接覆盖。因此工具会比较四个上游包的新旧 package.json；发生变化时，预览会列出，普通 update 会停止。

处理方式是先审阅上游配置差异，适配本地依赖、catalog、exports 或运行环境要求；依赖变化时重新安装并保存 package-lock.json。完成审阅后，用预览中的完整目标 SHA 明确标记这次配置已核对：

```sh
npm run upstream:update -- --packages-reviewed <同一个完整SHA>
```

`--packages-reviewed` 只表示调用者已负责核对该提交的配置，不会替调用者自动改好 package.json，也不跳过类型检查与行为测试。

## 模型目录 JSON 是单独的生成快照

`packages/ai/src/providers/data/` 被 pi 的 Git 忽略，但源码运行时需要它。最初的 396 文件清单实际包含 356 个 Git 文件和 40 个生成数据文件；本次把原始哈希分列为 `sha256` 与 `generatedSnapshot.sha256`，没有重算哈希来接受数据修改。

- Git 文件能和指定 commit 的原始 blob 对照。
- 生成数据只对照单独锁定的快照哈希，不能宣称来自某个 Git commit，也不由这个工具保证是最新模型目录。
- 普通同步保留这份数据，既不删除，也不从 pi 工作树偷偷复制。数据与它的快照清单仍需像其他配置一样通过版本控制审阅。
- 如果目标 commit 开始跟踪同一个生成数据路径，工具会拒绝自动交接，以免覆盖已有快照。

如果上游 `models.generated.ts` 或 provider 的 `.models.ts` 结构变化，工具要求先验证现有快照兼容，或另行生成匹配的数据。确实刷新快照时，应在独立目录使用上游生成和校验流程，审阅数据差异后，更新本工程数据文件及 `generatedSnapshot` 的哈希；保留原 Git commit 与 Git 文件哈希，重新预览。

2026-09-20（同步到 `d1230ea20` / 0.86.0）走的是"另行准备匹配数据"这条路，来源是**已发布的 npm 包**：新增的
`providers/radius.models.ts` import `./data/radius.json`，而这个文件在旧快照里不存在（生成数据不进上游 Git，
同步工具按设计不产生它），留着就是 typecheck 与运行期双双缺文件。`npm pack @earendil-works/pi-ai@0.86.0` 的
`dist/providers/data/` 是该版本 src 数据的逐字节副本（未变的文件与仓里原有的 `cmp` 一致，可自证），40 份数据
加一份 `.manifest.json` 整体替换，`generatedSnapshot.provenance` 写明来源，哈希按替换后的文件重算。
副作用要一并审阅：这等于把内建模型目录推进到 2026-09-19 那次生成——本次 27 份数据有变，DeepSeek 的
`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 合并为 `deepseek-flash`（V4.1 Flash，自带视觉、1M 上下文，
单价由 0.14/0.28 涨到 0.3/1.2），`deepseek-v4-pro` 单价由 0.435/0.87 改为 1.32/3.96，radius 第一次有了基线目录。
不要用手边 pi 检出的工作树凑这份数据：那是那台机器上次生成的结果，不对应任何提交。

完成数据兼容性检查后，用精确目标 SHA 标记该次审阅：

```sh
npm run upstream:update -- --model-data-reviewed <同一个完整SHA>
```

该标记不会执行生成器或自动验证模型价格、地址等元数据。生成脚本或上游数据源的变化仍需要单独关注；必要时可以与 `--packages-reviewed` 一起传入。

## 本地配置差异

- yoma 是 npm workspace,四个上游包(`packages/{ai,agent,chord,telemetry}`)保留上游包名,源码 import 不改。
- 上游包标记 private,exports 指向本地 `src/*.ts`,不依赖 dist;桌面端打包时由 electron-vite 把它们 inline 进内核 bundle。
- 内部依赖写 `"*"` 走 workspace 链接,外部版本在各包 package.json 里写死字面量,由 package-lock.json 固定。
- 显式声明 pi-ai 源码直接使用的 `@smithy/types` 并固定为 4.14.2。上游原仓的 hoist 隐式提供它;独立安装需要明确声明。provider 源码未改。
- 四个上游包用 `tsconfig.node.json`(pi 形状)做类型检查;每包各有 vitest.config.ts,保留选定的上游测试原文。默认测试使用离线模型和临时文件。
- `packages/agent-legacy`(2025 年从 pi `f8f75544b` 派生、自行维护的旧 harness)已于 2026-09-10 删除,`packages/kernel` 接 `packages/agent` 这份上游拷贝。

## 这次验证

2026-09-20 从 `ceea48f5d` 同步到 `d1230ea20`（0.85.1 → 0.86.0，97 个上游提交，范围内 97 个文件：
50 新增 / 46 修改 / 1 删除）。上游包配置只改了版本号与 agent 新增的 `./experimental/pico3` 导出，
没有新依赖；本地四个包的 version 跟着抬到 0.86.0，agent 的 exports 补了同一个入口。
生成数据整份换成 npm 包 0.86.0 的快照（见上一节）。

范围内的行为变化，消费端已适配：

- `Context` 现在要经 `normalizeContext()` 折成 `TranscriptContext` 才进 provider——系统提示词与工具
  声明住在转录的 system 消息里。`AgentHarness` 这条路不变（仍收 `systemPrompt` 选项，自己拼
  `AiContext`），但 faux provider 的响应回调收到的是 `TranscriptContext`，读提示词/工具要用
  `getCurrentSystemPrompt()` / `getCurrentTools()`；kernel 与 bench 的相关用例照此改。
- `Message` 多了 `SystemMessage`；harness 的转录不会自己长出这种消息（只有低层 `Agent` 循环会），
  投影器不受影响。
- `ToolResultMessage<TDetails>` / `AgentToolResult<T>` 现在要求 details 能 JSON 往返，
  `ToolCall.arguments` 收紧成 `JsonObject`——本仓 16 个工具的 details 全部通过，只有 bench 的
  faux 脚本类型跟着从 `Record<string, unknown>` 改成 `JsonObject`。
- `addedToolNames` / 延迟工具（`utils/deferred-tools.ts`）整套删除，本仓没有使用者。
- 目录刷新带来的两处连锁：bench 的 `DEFAULT_MODEL` 改成 `deepseek/deepseek-flash`（旧 id 已不在目录里），
  radius 现在能被 `configurableProviders()` 算进去（从前因为"目录要联网拉"被排除）。

验证范围:全量 3422 条测试(3368 通过 / 50 跳过)、11 个包 + 根 typecheck、lint(98 warnings / 0 errors,
多出来的那些全在新同步进来的 pico3 与 chord/delta 源码里),以及 desktop 的七道闸门
(build / smoke / e2e:ipc / e2e:renderer / smoke:mailbox / e2e:mailbox / e2e:paint)全绿。
唯一的红是 `toolchain.test.ts` 的「IDF_PATH 指着一个不是 IDF 根的目录不算数」,与本次同步无关:
那条用例没有隔离 well-known 档,开发机上真装了 ESP-IDF(`~/esp/esp-idf` 带 `tools/idf.py`)时
env 档如期落空之后 well-known 档会如实命中它,于是 status 是 configured。CI 上没有 IDF,所以是绿的。
真实 provider 调用、Windows、硬件副作用不在范围内。

## 上一次验证

2026-09-14 从 `b2602be77` 同步到 `ceea48f5d`(21 个范围内提交,47 个文件,7 新增 / 40 修改 / 0 删除)。
同一次改了同步工具本身:默认来源从"工程旁的 `../pi`"改成"按锁里的 repository 自建镜像"(见上文),
新增 5 条工具用例。依赖跟着上游走:typebox 1.3.7→1.3.27、@google/genai 1.52→2.21、http(s)-proxy-agent 7→9、
@anthropic-ai/sdk 0.123→0.124、@aws-sdk/client-bedrock-runtime 3.1048→3.1127、@smithy/node-http-handler 4.7.3→4.12.1、
esbuild 0.28.1→0.28.2、ignore 7.0.5→7.0.8(typebox 与 esbuild 在本仓自己的包里同步抬到同一版,避免一棵树两份)。

验证范围:全量 2217 条测试、根 typecheck、lint,以及 desktop 的七道闸门(build / smoke / e2e:ipc /
e2e:renderer / smoke:mailbox / e2e:mailbox / e2e:paint)全绿。真实 provider 调用、Windows、硬件副作用不在范围内。


2026-09-09 从独立仓 yoma-core 搬入 yoma monorepo:`packages/agent/{src,test}`、同步脚本、锁文件原样迁入,`npm run upstream:check` 在 yoma 内全部通过;yoma 原有的 ai/chord/telemetry 已与 `b2602be77` 逐字节一致,无需再同步。

2026-09-08 从 `9767ba275` 同步到 `b2602be77`：更新 EventStream 事件队列实现，新增对应的 5 个上游回归测试，并单独更新 AI CHANGELOG。Harness 源码及依赖配置没有上游变化。

验证范围为上游一致性、同步保护测试、类型检查，以及原有 Harness/CLI 和新增事件队列的离线测试。真实 provider、Windows 和任意硬件副作用的崩溃恢复不在本次验证范围内。

## Windows 测试夹具适配

`packages/agent/vitest.config.ts` 加载 `scripts/upstream-test-portability.ts`，仅在 Windows 对指定的上游测试模块做转换：JSONL 的 `/workspace` 及其编码目录换成带盘符的路径，Git Bash 的 `$PWD` 经 `cygpath` 输出原生路径，`session-test-utils` 的 afterEach 在 EPERM / EBUSY / ENOTEMPTY 时让出事件循环再删（timeout/abort 留下的 bash/sleep 还攥着目录；Node 的 `rmSync` retryDelay 并不真的等，与 `packages/kernel/test/cleanup.ts` 同一条）。源码和测试的磁盘文件仍按上游哈希锁定，断言不删、不跳过，生产模块不转换。上游改变夹具写法后须复核该适配；`scripts/test/upstream-test-portability.test.ts` 检查当前夹具与适配一致。
