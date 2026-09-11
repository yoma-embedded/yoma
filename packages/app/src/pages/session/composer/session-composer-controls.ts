import { base64Encode } from "@yoma-desktop/util/encode"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Accessor, createMemo } from "solid-js"
import type { PromptInputControls } from "@/components/prompt-input"
import type { PromptProjectControls } from "@/components/prompt-project-selector"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useGlobal } from "@/context/global"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import type { QueryOptionsApi } from "@/context/server-sync"
import { useSDK } from "@/context/sdk"
import { useDrafts } from "@/context/drafts"
import { pathKey } from "@/utils/path-key"

export function createPromptInputController(input: {
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  queryOptions: Pick<QueryOptionsApi, "providers">
}) {
  const layout = useLayout()
  const local = useLocal()
  const sdk = useSDK()
  const view = layout.view(input.sessionKey)
  const globalProvidersQuery = createQuery(() => input.queryOptions.providers(null))
  const providersQuery = createQuery(() => input.queryOptions.providers(pathKey(sdk().directory)))

  return createMemo<PromptInputControls>(() => ({
    model: {
      selection: local.model,
      loading: providersQuery.isLoading || globalProvidersQuery.isLoading,
    },
    session: {
      id: input.sessionID(),
      tabs: layout.tabs(input.sessionKey),
      reviewPanel: view.reviewPanel,
    },
  }))
}

export function createPromptProjectControls() {
  const navigate = useNavigate()
  const layout = useLayout()
  const sdk = useSDK()
  const drafts = useDrafts()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [search] = useSearchParams<{ draftId?: string }>()
  const projects = createMemo(() => (search.draftId ? global.ctx.projects.list() : layout.projects.list()))

  const selectProject = (worktree: string) => {
    if (search.draftId) {
      global.ctx.projects.open(worktree)
      global.ctx.projects.touch(worktree)
      drafts.update(search.draftId, { directory: worktree })
      return
    }
    layout.projects.open(worktree)
    global.ctx.projects.touch(worktree)
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const addProject = (title: string) => {
    pickDirectory({
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: sdk().directory,
    select: selectProject,
    add: addProject,
  }))
}
