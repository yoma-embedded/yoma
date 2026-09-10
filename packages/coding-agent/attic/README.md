# attic —— 2026-09-10 退役的工具实现

2026-09-10 工具归零时从 `src/core/tools/` 与 `test/` 整体搬来,只作参考。
不在 tsconfig 的 include(`src/**`、`test/**`)、vitest 的 include(`test/**`)与 oxlint 的扫描面里,
因此既不编译也不跑;里面仍然 import 已删除的 `@yoma/agent`,这是预期的。
重写按一个目录一个工具来:读 `attic/tools/<name>.ts` 加 `attic/test/<name>.test.ts`,
在 `src/tools/<name>/` 里按内核(`@earendil-works/pi-agent-core`)的工具接口重写。
