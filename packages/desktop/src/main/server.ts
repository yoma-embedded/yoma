/**
 * 曾经这里是 HTTP sidecar 的全部:选空闲端口、随机密码、fork utilityProcess 跑
 * opencode 的服务端 bundle、健康轮询。**那条路径已经整个拆除** —— renderer 现在通过
 * MessagePort 直连内核 utilityProcess(见 main/kernel.ts),没有端口、没有密码、
 * 没有 CORS、没有健康探测,也不再依赖兄弟仓 ../yoma 的构建产物。
 *
 * 文件保留下来的只有三个和服务端无关的小东西:electron-store 里的"默认服务器"偏好
 * (ServerConnection 概念清除后一并删)和 PATH 修正。
 */

import { app } from "electron"
import Store from "electron-store"
import { delimiter, join } from "node:path"

const store = new Store<{ defaultServerUrl: string | null }>({ name: "servers" })

export function getDefaultServerUrl(): string | null {
  return store.get("defaultServerUrl") ?? null
}

export function setDefaultServerUrl(url: string | null): void {
  if (url === null) store.delete("defaultServerUrl")
  else store.set("defaultServerUrl", url)
}

/**
 * macOS 上从 Finder 启动的 app 拿不到用户 shell 的 PATH,于是 git / cargo / probe-rs
 * 这些都找不到。内核的工具全是 spawn 外部可执行文件,所以这一条比以前更要紧。
 */
export function preferAppEnv(userDataPath: string): void {
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(app.getPath("home"), ".cargo", "bin"),
    join(app.getPath("home"), ".bun", "bin"),
    join(app.getPath("home"), ".local", "bin"),
    join(userDataPath, "bin"),
  ]
  const current = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  for (const dir of extra) if (!current.includes(dir)) current.push(dir)
  process.env.PATH = current.join(delimiter)
}
