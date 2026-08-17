# 贡献

```bash
bun install          # Bun 1.3.14，见根 package.json 的 packageManager
bun typecheck
bun test
bun dev:desktop      # 改内核源码没有热更新，要重启这次命令
```

架构、接缝和会踩的坑见 `CLAUDE.md`。包级规则在 `packages/app/AGENTS.md` 和 `packages/desktop/AGENTS.md`。

引擎（网表 / STM32 配置）需要 `bun engines/build.ts`。STM32 HAL（`engines/stm32-config-kernel/data/fw/`）不在库里，跑编译门禁测试先 `tools/fetch-fw.ps1`。
