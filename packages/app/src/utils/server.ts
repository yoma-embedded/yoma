/**
 * 内核客户端的构造入口。
 *
 * 文件名还叫 server 是刻意的:它原来导出 `createSdkForServer`,全应用几百处调用点通过
 * context/sdk.tsx 间接依赖它的返回值形状。**把内脏换掉而不是把文件删掉**,迁移就不会
 * 一次性炸出上百个"模块找不到",可以一个目录一个目录地收敛。改名留到收尾。
 *
 * 换掉之后没有 baseUrl、没有 Basic auth、没有 CORS —— 一个 Electron 进程里只有一个内核,
 * 传输是 preload 暴露的 window.api.kernel(形状就是 KernelTransport)。
 */

import { kernel } from "@/utils/kernel"

/**
 * 返回全应用唯一的内核客户端。
 *
 * 参数保留但被忽略 —— 调用点还在传 ServerConnection,收尾时一并清掉。
 * **不按 server 分实例**:内核是进程内单例,分实例只会造出多份互相看不见的事件流。
 */
export function createSdkForServer(_config?: unknown) {
  return kernel
}

export type Sdk = typeof kernel

