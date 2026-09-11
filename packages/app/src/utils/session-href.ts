/**
 * 会话路由只有一个形状。
 *
 * 以前是 `/server/<base64(serverKey)>/session/<id>` —— 多服务器时代要把"哪台服务器"
 * 编进路径里。一个进程里只有一个内核,服务器段整个消失,会话 id 自己就是全局唯一的地址。
 * 旧形状(以及更早的 `/<base64(dir)>/session/<id>`)在 app.tsx 里留了重定向,
 * 桌面端记着的上次路由才不会开在一个 404 上。
 */
export const sessionHref = (sessionID: string) => `/session/${sessionID}`
