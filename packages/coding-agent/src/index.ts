// yoma 的应用层:工具链解析 + 示例语料 + 引擎辅助。
// 内核(循环 / harness / 会话树 / 压缩)在 @earendil-works/pi-agent-core,本包只做"编码 agent"这一种应用。
// 工具本身已于 2026-09-10 归零,旧实现留在 attic/tools/ 作重写参考(不编译、不跑),见 attic/README.md。
// ACP 适配器已于 2026-09 删除。
export * from "./core/examples/index.ts";
export * from "./core/engines.ts";
export * from "./core/toolchain/index.ts";
// 逻辑分析仪的纯模块(.dsl / 边沿 / 注解 / 事务模型),给 kernel host 的 la.view 用;命名空间导出不污染包根。
export * as la from "./core/la/index.ts";
// 示波器的纯模块(SCPI 传输 / preamble / 统计 / 落盘),同样命名空间导出。
export * as scope from "./core/scope/index.ts";
