import { createMemo, type Accessor } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useNotification } from "@/context/notification"

export function useSessionTabAvatarState(directory: Accessor<string>, sessionId: Accessor<string>) {
  const globalSync = useServerSync()
  const notification = useNotification()
  const unread = createMemo(() => notification.session.unseenCount(sessionId()) > 0)
  const loading = createMemo(() => globalSync().session.data.session_working(sessionId()))
  return { unread, loading }
}
