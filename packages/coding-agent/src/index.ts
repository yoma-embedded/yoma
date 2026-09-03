// yoma 的应用层:工具集 + 工具链解析。
// 内核(循环 / harness / 会话树 / 压缩)在 @yoma/agent,本包只做"编码 agent"这一种应用。
// ACP 适配器**不**从这里导出 —— 它是 bin 入口 ./acp.ts,免得把 @agentclientprotocol/sdk
// 拖进每个 import 本包的宿主(桌面端内核就是被整个 inline 进 kernel.js 的那一个)。
export * from "./core/examples/index.ts";
export * from "./core/tools/engines.ts";
export * from "./core/tools/index.ts";
export * from "./core/toolchain/index.ts";
// 逻辑分析仪的纯模块(.dsl / 边沿 / 注解 / 事务模型),给 kernel host 的 la.view 用;命名空间导出不污染包根。
export * as la from "./core/la/index.ts";
// 示波器的纯模块(SCPI 传输 / preamble / 统计 / 落盘),同样命名空间导出。
export * as scope from "./core/scope/index.ts";
