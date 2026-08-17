// yoma 的应用层:工具集 + 工具链解析。
// 内核(循环 / harness / 会话树 / 压缩)在 @yoma/agent,本包只做"编码 agent"这一种应用。
// ACP 适配器**不**从这里导出 —— 它是 bin 入口 ./acp.ts,免得把 @agentclientprotocol/sdk
// 拖进每个 import 本包的宿主(桌面端内核就是被整个 inline 进 kernel.js 的那一个)。
export * from "./core/examples/index.ts";
export * from "./core/tools/engines.ts";
export * from "./core/tools/index.ts";
export * from "./core/toolchain/index.ts";
