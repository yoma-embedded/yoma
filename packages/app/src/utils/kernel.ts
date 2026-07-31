/**
 * 进程内内核的**唯一**客户端。
 *
 * 顶替原来的 `utils/server.ts`(`createSdkForServer`):没有 baseUrl、没有 Basic auth、
 * 没有多服务器 —— 一个 Electron 进程里只有一个内核,传输是 preload 通过 contextBridge
 * 暴露的 `window.api.kernel`(形状就是 `KernelTransport`)。
 *
 * 两个刻意的设计:
 *
 * 1. **模块级 const 单例**,不是工厂。调用点写 `kernel.session.list({ directory })`,
 *    和原来的 `sdk.session.list(...)` 只差一个 import 说明符。
 * 2. **传输是懒解析的**。`createKernelClient` 本身不碰 transport(只是闭包),但
 *    `window.api` 在 web host 和 bun 单测里根本不存在;如果在模块求值时就去读它,
 *    任何间接 import 到本文件的测试都会在 import 阶段炸掉。所以这里包一层转发,
 *    真正取 `window.api.kernel` 推迟到第一次 request/subscribe。
 */

import { createKernelClient, type KernelEvent, type KernelTransport } from "@yoma-desktop/kernel"

const UNAVAILABLE =
  "内核通道不可用:window.api.kernel 缺失。桌面端由 preload 注入;web host(dev:web)目前没有内核传输。"

/**
 * 不 `declare global` 声明 window.api —— packages/desktop 的 `src/renderer/env.d.ts`
 * 已经把它声明成完整的 ElectronAPI,这里再声明一遍形状不同的会和它打架。
 */
function lookup(): KernelTransport | undefined {
  return (globalThis as { api?: { kernel?: KernelTransport } }).api?.kernel
}

function required(): KernelTransport {
  const transport = lookup()
  if (!transport) throw new Error(UNAVAILABLE)
  return transport
}

/** 内核是否已经接上。web host / 单测里为 false。 */
export function kernelAvailable() {
  return lookup() !== undefined
}

const transport: KernelTransport = {
  request(method: string, params: unknown) {
    // request 是 async 边界,把缺失变成 rejection 而不是同步抛,调用点的错误处理才统一。
    try {
      return required().request(method, params)
    } catch (error) {
      return Promise.reject(error)
    }
  },
  subscribe(handler: (events: KernelEvent[]) => void) {
    return required().subscribe(handler)
  },
}

/** 全应用唯一的内核客户端。 */
export const kernel = createKernelClient(transport)
