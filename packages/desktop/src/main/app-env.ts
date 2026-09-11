/**
 * 主进程的环境修补。
 *
 * 曾经同目录下有个 server.ts,装着 HTTP sidecar 的全部(选空闲端口、随机密码、
 * fork utilityProcess 跑 opencode 的服务端 bundle、健康轮询),以及 electron-store 里的
 * "默认服务器"偏好。那条路径已经整个拆除 —— renderer 通过 MessagePort 直连内核
 * utilityProcess(见 main/kernel.ts),没有端口、没有密码、没有 CORS、没有健康探测,
 * 也没有"连哪台服务器"这回事。剩下的只有这一件与服务端无关的小事:PATH。
 */

import { app } from "electron"
import { delimiter, join } from "node:path"

/**
 * macOS 上从 Finder 启动的 app 拿不到用户 shell 的 PATH,于是 git / cargo / openocd
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
