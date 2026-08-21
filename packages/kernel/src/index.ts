/**
 * `@yoma-desktop/kernel` 的浏览器安全入口。
 *
 * 这里只有视图模型、协议和客户端 —— 绝不 import `@yoma/agent`、`node:*` 或 Electron。
 * 碰内核的一切都在 `./host`,那半边只跑在 utilityProcess 里。
 */
export * from "./types.ts"
export * from "./protocol.ts"
export * from "./mailbox-view.ts"
export * from "./client.ts"
export * from "./ids.ts"
export * from "./thinking.ts"
export * from "./la-codec.ts"
