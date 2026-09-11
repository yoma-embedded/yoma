# attic —— 2026-09-10 退役的工具实现

2026-09-10 工具归零时从当时的 `@yoma/coding-agent` 的 `src/core/tools/` 与 `test/` 整体搬来,
同日并包时随包落到 `packages/kernel/attic/`,只作参考。
不在 `packages/kernel/tsconfig.json` 的 include(`src`、`test`)、两份 vitest 的 include
(`src/**/*.test.ts` 与 `test/**/*.test.ts`)与 oxlint 的扫描面(`.oxlintrc.json` 的
`ignorePatterns` 列了 `packages/kernel/attic/**`)里,因此既不编译也不跑;
里面仍然 import 已删除的 `@yoma/agent`,相对路径 `../../src/core/*`、`../../src/index.ts` 也还是并包前的写法
(engines.ts 今天在 `src/host/domain/engines.ts`),这是预期的,别照抄。
重写按一个目录一个工具来:读 `attic/tools/<name>.ts` 加 `attic/test/<name>.test.ts`,
在 `packages/kernel/src/host/tools/<name>/` 里按内核(`@earendil-works/pi-agent-core`)的
工具接口重写 —— `contract.ts` 是浏览器安全的那一半(不许碰 node:* / electron / 发动机),
`session.ts` 是会话侧实现;边界由 `src/host/boundary.test.ts` 钉住。
