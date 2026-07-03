import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      {/* "yoma" wordmark, centered in the original 234×42 box — same blocky pixel style as the opencode mark */}
      <g>
        <path d="M63 12H69V18H63ZM69 12H75V18H69Z" fill="var(--icon-weak-base)" />
        <path d="M57 6H63V12H57ZM75 6H81V12H75ZM57 12H63V18H57ZM75 12H81V18H75ZM57 18H63V24H57ZM63 18H69V24H63ZM69 18H75V24H69ZM75 18H81V24H75ZM75 24H81V30H75ZM63 30H69V36H63ZM69 30H75V36H69ZM75 30H81V36H75Z" fill="var(--icon-base)" />
        <path d="M93 18H99V24H93ZM99 18H105V24H99ZM93 24H99V30H93ZM99 24H105V30H99Z" fill="var(--icon-weak-base)" />
        <path d="M87 6H93V12H87ZM93 6H99V12H93ZM99 6H105V12H99ZM105 6H111V12H105ZM87 12H93V18H87ZM105 12H111V18H105ZM87 18H93V24H87ZM105 18H111V24H105ZM87 24H93V30H87ZM105 24H111V30H105ZM87 30H93V36H87ZM93 30H99V36H93ZM99 30H105V36H99ZM105 30H111V36H105Z" fill="var(--icon-base)" />
        <path d="M123 24H129V30H123ZM123 30H129V36H123ZM135 24H141V30H135ZM135 30H141V36H135Z" fill="var(--icon-weak-base)" />
        <path d="M117 6H123V12H117ZM123 6H129V12H123ZM129 6H135V12H129ZM135 6H141V12H135ZM141 6H147V12H141ZM117 12H123V18H117ZM129 12H135V18H129ZM141 12H147V18H141ZM117 18H123V24H117ZM129 18H135V24H129ZM141 18H147V24H141ZM117 24H123V30H117ZM129 24H135V30H129ZM141 24H147V30H141ZM117 30H123V36H117ZM129 30H135V36H129ZM141 30H147V36H141Z" fill="var(--icon-strong-base)" />
        <path d="M159 24H165V30H159ZM165 24H171V30H165Z" fill="var(--icon-weak-base)" />
        <path d="M153 6H159V12H153ZM159 6H165V12H159ZM165 6H171V12H165ZM171 6H177V12H171ZM171 12H177V18H171ZM153 18H159V24H153ZM159 18H165V24H159ZM165 18H171V24H165ZM171 18H177V24H171ZM153 24H159V30H153ZM171 24H177V30H171ZM153 30H159V36H153ZM159 30H165V36H159ZM165 30H171V36H165ZM171 30H177V36H171Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
