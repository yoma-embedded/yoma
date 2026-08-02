import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest } from "@yoma-desktop/kernel"
import { useParams } from "@solidjs/router"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { sessionPermissionRequest } from "./session-request-tree"

/**
 * 组合区状态。
 *
 * my-pi 没有 ask-user、也没有 todowrite,所以这里只剩权限门一件事 ——
 * 原来的 question dock / todo dock（含开合动画的定时器状态机）整体删掉。
 */
export function createSessionComposerController() {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()
  const permission = usePermission()

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sync().data.permission, params.id, (item) => {
      return !permission.autoResponds(item, sdk().directory)
    })
  })

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!permissionRequest()
  })

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (store.responding === perm.id) return

    setStore("responding", perm.id)
    sdk()
      .client.permission.respond(perm.id, response)
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  return {
    blocked,
    permissionRequest,
    permissionResponding,
    decide,
  }
}

export type SessionComposerController = ReturnType<typeof createSessionComposerController>
