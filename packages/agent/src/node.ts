// Node 专用入口:根入口(index.ts)保持浏览器安全,凡碰 node:fs/child_process 的
// 实现只从这里走。import "@yoma/agent/node" 即可同时拿到全部核心导出。
export { NodeExecutionEnv } from "./harness/env/nodejs.ts";
export * from "./index.ts";
