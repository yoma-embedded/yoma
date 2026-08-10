import type { Message, Part, Session, SessionStatus, VcsInfo } from "@yoma-desktop/kernel"
import { NormalizedProviderListResponse } from "@yoma-desktop/session-ui/context"

/**
 * 工作目录信息。
 *
 * 原来是后端 /path 路由返回的对象(带 project/worktree/state 等)。my-pi 里一个会话就是
 * 一个 cwd,没有 project 层级,所以这里收窄成"当前目录"这一件事,并且由前端自己知道 ——
 * 不需要往内核要。
 */
export type Path = {
  directory: string
}

/**
 * 应用配置。
 *
 * opencode 的 config 是后端下发的(provider 设置、agent 定义、MCP 服务器…)。
 * my-pi 没有配置服务,所以这里是空对象;这个类型保留是为了让还在读 config 的调用点
 * 先编译过去,收尾时逐个清掉。
 */
export type Config = Record<string, never>
import type { Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

export type State = {
  status: "loading" | "partial" | "complete"
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider_ready: boolean
  provider: NormalizedProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_working(id: string): boolean
  vcs: VcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta: {
    [partID: string]: string
  }
}

export type VcsCache = {
  store: Store<{ value: VcsInfo | undefined }>
  setStore: SetStoreFunction<{ value: VcsInfo | undefined }>
  ready: Accessor<boolean>
}

export type MetaCache = {
  store: Store<{ value: ProjectMeta | undefined }>
  setStore: SetStoreFunction<{ value: ProjectMeta | undefined }>
  ready: Accessor<boolean>
}

export type IconCache = {
  store: Store<{ value: string | undefined }>
  setStore: SetStoreFunction<{ value: string | undefined }>
  ready: Accessor<boolean>
}

export type ChildOptions = {
  bootstrap?: boolean
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_RECENT_WINDOW = 4 * 60 * 60 * 1000
export const SESSION_RECENT_LIMIT = 50
