#!/usr/bin/env bun
/**
 * 信箱守护的进程薄壳:`<node|bun> mailbox-host <config.json>`。
 *
 * 打包态由 esbuild 出成 `out/main/mailbox-host.mjs`,桌面端 main 用
 * ELECTRON_RUN_AS_NODE 起它;开发态 bun 直跑本文件效果相同。逻辑全部在
 * host.ts(可测);这里只做三件事:读配置、把事件写成 stdout 的 `@@event` 行、
 * 把结果变成退出码。抛出来的错误也走 done 事件 —— 让 main 永远有一条
 * 结构化的"它为什么死了",而不是只有一截 stderr。
 */

import { readJsonFile } from "../fsx.ts"
import { runMailboxHost, type MailboxHostConfig, type MailboxHostEvent } from "./host.ts"

const configFile = process.argv[2]
if (!configFile) {
  console.error("用法: mailbox-host <config.json>")
  process.exit(2)
}

const emit = (event: MailboxHostEvent) => {
  process.stdout.write(`@@event ${JSON.stringify(event)}\n`)
}

const exitCode = await runMailboxHost(await readJsonFile<MailboxHostConfig>(configFile), emit).catch((error) => {
  emit({ type: "done", exitCode: 1, detail: (error as Error).message })
  return 1
})
process.exit(exitCode)
