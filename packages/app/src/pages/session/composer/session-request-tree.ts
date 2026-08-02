import type { PermissionRequest } from "@yoma-desktop/kernel"

/**
 * my-pi 里一个会话没有子会话(没有子代理),所以权限请求只可能挂在当前会话上 ——
 * 不再需要沿 parentID 树往下找。
 */
export function sessionPermissionRequest(
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include: (item: PermissionRequest) => boolean = () => true,
) {
  if (!sessionID) return
  return request[sessionID]?.find(include)
}
