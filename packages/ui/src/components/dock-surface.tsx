import { type ComponentProps, splitProps } from "solid-js"

export interface DockTrayProps extends ComponentProps<"div"> {
  /** 把哪一边嵌进相邻的面(`bottom` = 底边嵌进输入框:负边距 + 该侧不倒角)。 */
  attach?: "none" | "top" | "bottom"
}

export function DockShell(props: ComponentProps<"div">) {
  const [split, rest] = splitProps(props, ["children", "class", "classList"])
  return (
    <div
      {...rest}
      data-dock-surface="shell"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </div>
  )
}

export function DockShellForm(props: ComponentProps<"form">) {
  const [split, rest] = splitProps(props, ["children", "class", "classList"])
  return (
    <form
      {...rest}
      data-dock-surface="shell"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </form>
  )
}

export function DockTray(props: DockTrayProps) {
  const [split, rest] = splitProps(props, ["attach", "children", "class", "classList"])
  return (
    <div
      {...rest}
      data-dock-surface="tray"
      data-dock-attach={split.attach || "none"}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </div>
  )
}
