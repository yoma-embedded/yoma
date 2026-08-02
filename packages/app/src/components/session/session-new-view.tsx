import { Show, createMemo } from "solid-js"
import { DateTime } from "luxon"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { Icon } from "@yoma-desktop/ui/icon"
import { Mark } from "@yoma-desktop/ui/logo"
import { getDirectory, getFilename } from "@yoma-desktop/util/path"

const ROOT_CLASS = "size-full flex flex-col"

/**
 * 一个项目就是一个工作目录 —— 内核没有 worktree / sandbox 两层结构,
 * 所以原来的 main/sandbox/create 工作区切换整块删掉,只留当前 git 分支。
 */
export function NewSessionView() {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()

  const projectRoot = createMemo(() => sync().project?.directory ?? sdk().directory)
  const branch = createMemo(() => sync().data.vcs?.branch)

  return (
    <div class={ROOT_CLASS}>
      <div class="h-12 shrink-0" aria-hidden />
      <div class="flex-1 px-6 pb-30 flex items-center justify-center text-center">
        <div class="w-full max-w-200 flex flex-col items-center text-center gap-4">
          <div class="flex flex-col items-center gap-6">
            <Mark class="w-10" />
            <div class="text-20-medium text-text-strong">{language.t("session.new.title")}</div>
          </div>
          <div class="w-full flex flex-col gap-4 items-center">
            <div class="flex items-start justify-center gap-3 min-h-5">
              <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {getDirectory(projectRoot())}
                <span class="text-text-strong">{getFilename(projectRoot())}</span>
              </div>
            </div>
            <Show when={branch()}>
              {(value) => (
                <div class="flex items-start justify-center gap-1.5 min-h-5">
                  <Icon name="branch" size="small" class="mt-0.5 shrink-0" />
                  <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                    {value()}
                  </div>
                </div>
              )}
            </Show>
            <Show when={sync().project}>
              {(project) => (
                <div class="flex items-start justify-center gap-3 min-h-5">
                  <div class="text-12-medium text-text-weak leading-5 min-w-0 max-w-160 break-words text-center">
                    {language.t("session.new.lastModified")}&nbsp;
                    <span class="text-text-strong">
                      {DateTime.fromMillis(project().lastOpened)
                        .setLocale(language.intl())
                        .toRelative()}
                    </span>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
