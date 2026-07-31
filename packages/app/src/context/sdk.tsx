import { createSimpleContext } from "@yoma-desktop/ui/context"
import { type Accessor, createMemo } from "solid-js"
import { useKernel } from "./kernel"

/**
 * 目录作用域的数据句柄。
 *
 * 以前这是 `ServerSDK.ensureDirSdkContext(directory)`:每个目录一个**独立的
 * HTTP client**(baseUrl 相同,但 `directory` 被烘进每个请求的 query string),
 * 外加一个只收该目录事件的 emitter。
 *
 * 内核这边两件事都没了:
 *  - client 是进程级单例,`directory` 只是某些方法的一个普通参数;
 *  - 事件不带 directory 维度,订阅者自己按 `sessionID` 反查。
 *
 * 所以这里剩下的只是"当前路由指向哪个工作目录"这一个事实,加上单例 client 和
 * 事件总线的直通。保留 accessor 形状是因为 `directory` 确实会随路由变化。
 */
export type DirectorySDK = {
  directory: string
  client: ReturnType<typeof useKernel>["client"]
  event: ReturnType<typeof useKernel>["event"]
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { directory: string | Accessor<string> }) => {
    const kernel = useKernel()
    return createMemo<DirectorySDK>(() => ({
      directory: typeof props.directory === "function" ? props.directory() : props.directory,
      client: kernel.client,
      event: kernel.event,
    }))
  },
})
