/**
 * 压测页面的会话地址。原来是 `/server/<base64(http://host:port)>/session/<id>` —— 多服务器
 * 时代要把"哪台服务器"编进路径;现在一个进程里只有一个内核,会话 id 自己就是地址。
 * (`PLAYWRIGHT_SERVER_HOST/PORT` 还留着,但只给 playwright.config 的 baseURL 用。)
 */
export function stressSessionHref(sessionID: string) {
  return `/session/${sessionID}`
}
