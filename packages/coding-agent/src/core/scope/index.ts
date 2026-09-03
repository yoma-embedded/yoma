/**
 * 示波器核心库的 barrel。以命名空间导出(`export * as scope`),免得 waveStats / si 这类名字污染包根。
 */
export * from "./analyze.ts";
export * from "./preamble.ts";
export * from "./scpi.ts";
export * from "./siglent.ts";
export * from "./store.ts";
