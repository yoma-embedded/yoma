/**
 * 给一个不认中止信号的 promise 加上"用户点了停止就立刻结算"。
 *
 * node:fs 的 readdir / lstat 都不收 AbortSignal,而它们在死掉的网络盘(Windows 上服务器关机的
 * 映射盘、拔掉的 U 盘)上会在 libuv 线程池里堵几十秒到几分钟。没有子进程可杀、没有超时可等,
 * 于是"点停止没反应",整轮卡到操作系统自己放弃。这里不取消底层调用(做不到),只让工具的
 * promise 先按中止结算 —— 那次系统调用之后自己完成、自己被丢掉。
 */

export function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new Error(message))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(message))
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}
