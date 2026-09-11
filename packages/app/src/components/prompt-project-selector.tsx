import { createSignal, For, Show, splitProps, type Accessor, type ComponentProps } from "solid-js"
import { DropdownMenu } from "@yoma-desktop/ui/dropdown-menu"
import { Icon } from "@yoma-desktop/ui/icon"
import { Icon as IconV2 } from "@yoma-desktop/ui/v2/icon"
import { ProjectAvatar } from "@yoma-desktop/ui/v2/project-avatar-v2"
import { getProjectAvatarVariant } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { displayName } from "@/pages/layout/helpers"
import { pathKey } from "@/utils/path-key"

/**
 * 草稿页左下角那个「这次会话开在哪个工程目录」的控件。
 *
 * 原来 549 行,因为它同时处理多服务器(PromptProject.server、按服务器分组的二级菜单、
 * 把服务器编进 projectKey)、搜索框和一整套自己实现的键盘导航,还要挑工程头像配色。
 * 多服务器一拆,剩下的职责就三件:显示当前目录名、列最近打开过的工程、一个「添加工程…」
 * 直接开系统原生目录选择框。键盘导航交回 DropdownMenu 自己的实现。
 */
export type PromptProject = {
  name?: string
  worktree: string
  /** 只有本地覆盖:内核的项目记录里没有图标。override 是一个 data: URL。 */
  icon?: { color?: string; override?: string }
}

export type PromptProjectControls = {
  available: PromptProject[]
  directory: string
  select: (worktree: string) => void
  add: (title: string) => void
}

export function createPromptProjectController(input: {
  controls: Accessor<PromptProjectControls>
  onDone: () => void
}) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)

  const selected = () => {
    const key = pathKey(input.controls().directory)
    return input.controls().available.find((project) => pathKey(project.worktree) === key)
  }

  return {
    selected,
    projects: () => input.controls().available,
    projectKey: (project: PromptProject) => `project:${encodeURIComponent(project.worktree)}`,
    open,
    labels: {
      add: () => language.t("session.new.project.add"),
      new: () => language.t("session.new.project.new"),
    },
    setOpen(next: boolean) {
      setOpen(next)
      if (!next) input.onDone()
    },
    add() {
      setOpen(false)
      input.controls().add(language.t("command.project.open"))
    },
    select(project: PromptProject) {
      if (pathKey(project.worktree) !== pathKey(selected()?.worktree ?? "")) {
        input.controls().select(project.worktree)
      }
      setOpen(false)
      input.onDone()
    },
  }
}

export type PromptProjectController = ReturnType<typeof createPromptProjectController>

export function PromptProjectSelector(props: {
  controller: PromptProjectController
  placement?: "bottom" | "bottom-start"
}) {
  const selectedValue = () => {
    const project = props.controller.selected()
    return project ? props.controller.projectKey(project) : undefined
  }

  return (
    <DropdownMenu
      open={props.controller.open()}
      placement={props.placement ?? "bottom"}
      gutter={4}
      modal={false}
      onOpenChange={(open) => props.controller.setOpen(open)}
    >
      <DropdownMenu.Trigger as={ProjectTrigger} controller={props.controller} />
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          id="prompt-project-menu"
          class="w-[243px] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none [&[data-closed]]:!animate-none"
        >
          <Show when={props.controller.projects().length > 0}>
            <div class="flex flex-col p-0.5">
              <DropdownMenu.RadioGroup value={selectedValue()}>
                <For each={props.controller.projects()}>
                  {(project) => <ProjectItem project={project} controller={props.controller} />}
                </For>
              </DropdownMenu.RadioGroup>
            </div>
            <div class="h-px bg-v2-border-border-muted" />
          </Show>
          <div class="flex flex-col p-0.5">
            <DropdownMenu.Item
              class="h-7 gap-2 rounded-sm px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base data-[highlighted]:!bg-v2-overlay-simple-overlay-hover"
              onSelect={() => props.controller.add()}
            >
              <Icon name="plus" size="small" />
              <DropdownMenu.ItemLabel class="min-w-0 flex-1 truncate leading-5">
                {props.controller.labels.add()}
              </DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export function PromptProjectAddButton(props: { controller: PromptProjectController }) {
  return (
    <button
      data-action="prompt-project"
      type="button"
      class="flex h-7 min-w-0 max-w-[160px] items-center gap-1.5 rounded-sm px-2 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
      onClick={() => props.controller.add()}
    >
      <Icon name="folder-add-left" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      <span class="min-w-0 truncate leading-5">{props.controller.labels.new()}</span>
    </button>
  )
}

function ProjectTrigger(props: ComponentProps<"button"> & { controller: PromptProjectController }) {
  const [local, rest] = splitProps(props, ["controller", "class", "classList", "onClick"])
  const project = () => local.controller.selected()
  return (
    <button
      {...rest}
      data-action="prompt-project"
      type="button"
      class="flex h-7 min-w-0 max-w-[203px] items-center gap-1.5 rounded-sm px-1.5 transition-colors focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
      classList={{
        ...local.classList,
        "hover:bg-v2-overlay-simple-overlay-hover": !local.controller.open(),
        "bg-v2-overlay-simple-overlay-pressed": local.controller.open(),
        "text-v2-text-text-muted": local.controller.open(),
      }}
      onClick={local.onClick ?? (() => local.controller.setOpen(true))}
    >
      <Icon name="folder-add-left" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      <span class="min-w-0 truncate leading-5">
        {project() ? displayName(project()!) : local.controller.labels.new()}
      </span>
      <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
    </button>
  )
}

function ProjectItem(props: { project: PromptProject; controller: PromptProjectController }) {
  const key = () => props.controller.projectKey(props.project)
  return (
    <DropdownMenu.RadioItem
      id={key()}
      value={key()}
      data-option-key={key()}
      class="h-7 gap-2 rounded-sm px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base data-[highlighted]:!bg-v2-overlay-simple-overlay-hover"
      style={{
        "font-family": "var(--v2-font-family-sans)",
        "font-size": "13px",
        "font-weight": 440,
        "line-height": "20px",
        "letter-spacing": "-0.04px",
        color: "var(--v2-text-text-base)",
        padding: "0 12px",
      }}
      closeOnSelect
      onSelect={() => props.controller.select(props.project)}
    >
      <ProjectAvatar
        fallback={displayName(props.project)}
        src={props.project.icon?.override}
        variant={getProjectAvatarVariant(props.project.icon?.color)}
      />
      <DropdownMenu.ItemLabel class="min-w-0 truncate leading-5">{displayName(props.project)}</DropdownMenu.ItemLabel>
      <DropdownMenu.ItemIndicator style={{ width: "14px", height: "14px", right: "12px" }}>
        <IconV2 name="check" size="small" class="shrink-0 text-v2-icon-icon-base" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  )
}
