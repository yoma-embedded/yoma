// Node 专用入口:根入口(index.ts)保持浏览器安全,凡碰 node:fs/child_process 的
// 实现只从这里走。import "@yoma/my-pi/node" 即可同时拿到全部核心导出。
/**
 * 职责:整套内核对外的两个入口之一 —— Node 专用入口。
 * 全景位置:与浏览器安全的 index.ts 并列,是「入口二分」的 Node 侧半片(全景篇 §2.2)。
 * 任何实现碰了 node:fs / node:child_process 的模块都只从这里转发出去,
 * 使 index.ts 保持零 Node API 依赖、可以被打进浏览器 bundle。
 * 对应学习文档:docs/learn/agent/node.md
 * 分节索引:
 *   §1 NodeExecutionEnv 出口 —— 唯一比 index.ts 多出来的东西
 *   §2 index.ts 转发 —— 把浏览器安全入口的全部导出原样带出来
 */
// ── §1 NodeExecutionEnv 出口 ──────────────────────────────────────────────
// NodeExecutionEnv 是 ExecutionEnv(FileSystem + Shell,定义见 harness/types.ts)
// 在 Node 运行时下的唯一实现,harness 用它来真正碰文件系统与起子进程。
// 它不在 index.ts 里导出,是因为它的实现文件(harness/env/nodejs.ts)整块
// import 了 node:child_process / node:fs / node:os —— 这条 import 链一旦
// 出现在浏览器安全入口上,index.ts 就再也不能被打进浏览器 bundle。
export { NodeExecutionEnv } from "./harness/env/nodejs.ts";
// ── §2 index.ts 转发 ──────────────────────────────────────────────────────
// 把浏览器安全入口的全部导出原样带出来,这样只 import "@yoma/my-pi/node" 的
// Node 调用方(比如 coding-agent 的 ACP 适配器与几乎所有测试)不必再额外
// import "@yoma/my-pi" 拼两份导出。index.ts 里那份 export * 的白名单例外
// (compaction 两个模块具名导出)对这里同样生效,不再重复一遍。
export * from "./index.ts";
