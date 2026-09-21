/**
 * 退出之前请渲染器把攒着的持久化改动交出来。
 *
 * 渲染器的持久化是攒批的(app 的 namespace-storage.ts),落盘边界是 pagehide。正常关窗 / 退出会走到 pagehide;
 * **relaunch 不会** —— 它是 `app.exit(0)`,不发 before-quit、不关窗口,页面什么事件都收不到,最后那一批就丢了
 * (而"重启以应用"恰恰常常紧跟在用户刚改完一个设置之后)。所以 exit 之前显式问一声、等回执;渲染器挂了或
 * 卡死了就等到超时为止,不能让一个不回话的页面挡住重启。
 */

export type FlushWindow = {
  /** 页面还活着、能回话。 */
  alive(): boolean
  send(channel: "storage-flush"): void
  /** 这个回执是不是这个窗口发来的。 */
  owns(sender: unknown): boolean
}

export type FlushIpc = {
  on(channel: "storage-flushed", listener: (event: { sender: unknown }) => void): void
  off(channel: "storage-flushed", listener: (event: { sender: unknown }) => void): void
}

export function flushRendererStorage(windows: FlushWindow[], ipc: FlushIpc, timeoutMs = 1000): Promise<void> {
  const waits = windows
    .filter((win) => win.alive())
    .map(
      (win) =>
        new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer)
            ipc.off("storage-flushed", onAck)
            resolve()
          }
          const onAck = (event: { sender: unknown }) => {
            if (win.owns(event.sender)) finish()
          }
          const timer = setTimeout(finish, timeoutMs)
          ipc.on("storage-flushed", onAck)
          win.send("storage-flush")
        }),
    )
  return Promise.all(waits).then(() => undefined)
}
