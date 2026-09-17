/**
 * 示波器核心库的 barrel。以命名空间导出(`export * as scope`),免得 waveStats / si 这类名字污染包根。
 *
 * 分层:driver.ts(接口与地址)→ registry.ts(驱动表、自动识别)→ siglent.ts / demo.ts(驱动)→ scpi.ts(传输)。
 */
export * from "./analyze.ts";
export * from "./demo.ts";
export * from "./driver.ts";
export * from "./limits.ts";
export * from "./preamble.ts";
export * from "./registry.ts";
export * from "./scpi.ts";
export * from "./siglent.ts";
export * from "./store.ts";
