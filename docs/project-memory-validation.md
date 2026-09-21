# 工程档案与记忆：本次验证记录

本地 `develop`，macOS，2026-09-21。使用隔离临时工程和假模型；未使用真实硬件或模型 API，未重启用户正在运行的应用。

> 后续按用户要求移除了「工程与记忆」设置页、专属文案和页面测试，保留对话中的工程配置与记忆能力。下面的页面测试记录仅描述移除前的验证。

## 已通过

- `npx turbo typecheck --force`：11/11；根 `npx tsgo --noEmit -p tsconfig.json` 通过。
- `npm run lint`：0 errors，仓库现有 98 warnings。
- 上游哈希检查：413 个源码/测试文件与 41 个生成数据快照一致。
- 功能和相关回归：11 文件、142 项通过，2 项 Windows 专用用例在 macOS 跳过；新增工具清单断言更新后另有 23 项通过。
- 覆盖了工程识别、跨会话注入、真实 agent 工具保存、同进程/跨进程写冲突、停用与删除、坏文件保护、目录隔离、构建失败/取消/引号路径/固件 hash，以及设置页编辑、刷新保留草稿和错误处理。
- 最终 `npm run build:desktop` 通过；产物内核冒烟通过，包含 22 个工具装配面、USB 模块与 6 个必需引擎（无仪器访问）。逻辑分析仪二进制本机缺失，既有冒烟按其规则跳过。
- 真 Electron utilityProcess + MessagePort 验证通过；已增加工程识别、档案/记忆保存、构建检查和忘记的往返测试。
- 真实 renderer + preload/contextBridge 的既有端到端测试通过。

## 全量回归的剩余项

全量 `npm test` 初跑：3534 passed / 5 failed / 28 skipped。新增工具带来的旧清单断言已更新并复跑通过；GDB、工具链版本探测和目录选择的三项并发超时/探测失败串行复跑通过。

仍有一项与本次改动无关的本机环境断言失败：`packages/kernel/src/host/toolchain.test.ts` 的无效 `IDF_PATH` 用例期望 `missing`，实际回退到已安装的 `/Users/ben/esp/esp-idf`，返回 `source: well-known, status: configured`。未改变工具链发现行为或此用例。

## 性能与平台范围

仓库要求的生产 timeline benchmark 已尝试，但对应 Playwright 场景文件未包含在当前检出中，报告 `No tests found`，因此没有可报告的生产帧率基线。已有性能辅助用例前后均为 8 文件 / 15 项通过，这不能替代帧率对比。新增记忆上下文每轮只读小文件并注入最近 6 条摘要；工程描述文件扫描只在显式检查工程时执行。

Windows 的命令调用按 Node 的 `cmd.exe /d /s /c` 引号规则实现，并有可在 Windows CI 运行的引号/中文路径、取消和保存测试。本次未运行 Windows 真机或固件上板验收。
