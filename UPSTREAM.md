# 上游基线与同步流程

上游：<https://github.com/earendil-works/pi>。**当前完整 commit、包版本和文件 SHA-256，以 `upstream-lock.json` 为准。** 首次复制基线为 `9767ba275`（0.85.1）。

## 三个命令各做什么

| 命令 | 用途 | 是否改文件 |
| --- | --- | --- |
| `npm run upstream:check` | 检查本地受保护文件与锁定清单是否一致 | 否，无需 pi 在旁边 |
| `npm run upstream:diff -- --source ../pi --ref HEAD` | 验证旧基线，再预览选定上游提交的增删改与包配置变化 | 否 |
| `npm run upstream:update -- --source ../pi --ref <完整SHA>` | 同步受管理文件，最后更新锁定清单 | 是 |

`upstream:check` 通过，只表示仍符合已经锁定的版本，不能说明没有新的上游提交。

`--source` 指向本机 pi Git 仓库；相对路径按当前工作目录解析。`--ref` 可以是它已有的分支、tag 或 commit。先预览，再将输出的完整 SHA 交给 update，确保两次使用同一提交。工具自身不联网，不改变 pi 检出，也不自动创建提交。

## 平时按这个顺序更新

1. 更新本机 pi 检出，拿到希望跟随的上游提交。不要自动覆盖 pi 工作树中的个人修改。
2. 在 yoma-core 根目录执行 `npm run upstream:check`，确认当前受保护文件仍符合旧基线。
3. 执行 `npm run upstream:diff -- --source ../pi --ref HEAD`，查看受管理文件的变化与上游包配置变化。
4. 执行 `npm run upstream:update -- --source ../pi --ref <预览中的完整SHA>`。
5. 执行 `npm run typecheck`、`npm test`。API 有变化时，在 CLI 等消费者中适配后再验证。
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
npm run upstream:update -- --source ../pi --ref <完整SHA> --packages-reviewed <同一个完整SHA>
```

`--packages-reviewed` 只表示调用者已负责核对该提交的配置，不会替调用者自动改好 package.json，也不跳过类型检查与行为测试。

## 模型目录 JSON 是单独的生成快照

`packages/ai/src/providers/data/` 被 pi 的 Git 忽略，但源码运行时需要它。最初的 396 文件清单实际包含 356 个 Git 文件和 40 个生成数据文件；本次把原始哈希分列为 `sha256` 与 `generatedSnapshot.sha256`，没有重算哈希来接受数据修改。

- Git 文件能和指定 commit 的原始 blob 对照。
- 生成数据只对照单独锁定的快照哈希，不能宣称来自某个 Git commit，也不由这个工具保证是最新模型目录。
- 普通同步保留这份数据，既不删除，也不从 pi 工作树偷偷复制。数据与它的快照清单仍需像其他配置一样通过版本控制审阅。
- 如果目标 commit 开始跟踪同一个生成数据路径，工具会拒绝自动交接，以免覆盖已有快照。

如果上游 `models.generated.ts` 或 provider 的 `.models.ts` 结构变化，工具要求先验证现有快照兼容，或另行生成匹配的数据。确实刷新快照时，应在独立目录使用上游生成和校验流程，审阅数据差异后，更新本工程数据文件及 `generatedSnapshot` 的哈希；保留原 Git commit 与 Git 文件哈希，重新预览。

完成数据兼容性检查后，用精确目标 SHA 标记该次审阅：

```sh
npm run upstream:update -- --source ../pi --ref <完整SHA> --model-data-reviewed <同一个完整SHA>
```

该标记不会执行生成器或自动验证模型价格、地址等元数据。生成脚本或上游数据源的变化仍需要单独关注；必要时可以与 `--packages-reviewed` 一起传入。

## 本地配置差异

- yoma 是 npm workspace,四个上游包(`packages/{ai,agent,chord,telemetry}`)保留上游包名,源码 import 不改。
- 上游包标记 private,exports 指向本地 `src/*.ts`,不依赖 dist;桌面端打包时由 electron-vite 把它们 inline 进内核 bundle。
- 内部依赖写 `"*"` 走 workspace 链接,外部版本在各包 package.json 里写死字面量,由 package-lock.json 固定。
- 显式声明 pi-ai 源码直接使用的 `@smithy/types` 并固定为 4.14.2。上游原仓的 hoist 隐式提供它;独立安装需要明确声明。provider 源码未改。
- 四个上游包用 `tsconfig.node.json`(pi 形状)做类型检查;每包各有 vitest.config.ts,保留选定的上游测试原文。默认测试使用离线模型和临时文件。
- `packages/agent-legacy` 是 2025 年从 pi `f8f75544b` 派生、自行维护的旧 harness,不受本工具管理;kernel 切到新 core 后删除。

## 这次验证

2026-09-09 从独立仓 yoma-core 搬入 yoma monorepo:`packages/agent/{src,test}`、同步脚本、锁文件原样迁入,`npm run upstream:check` 在 yoma 内全部通过;yoma 原有的 ai/chord/telemetry 已与 `b2602be77` 逐字节一致,无需再同步。

2026-09-08 从 `9767ba275` 同步到 `b2602be77`：更新 EventStream 事件队列实现，新增对应的 5 个上游回归测试，并单独更新 AI CHANGELOG。Harness 源码及依赖配置没有上游变化。

验证范围为上游一致性、同步保护测试、类型检查，以及原有 Harness/CLI 和新增事件队列的离线测试。真实 provider、Windows 和任意硬件副作用的崩溃恢复不在本次验证范围内。
