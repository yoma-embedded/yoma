/**
 * 左侧栏一行的样子(新对话 / 手册库 / 调试台 / 仪器)。侧栏与画进侧栏的仪器入口共用,两边长得不一样就是 bug。
 * 悬浮与选中都用**叠加层**而不是 bg-layer-*:浅色主题下 bg-layer-01 与侧栏自己的底色 bg-deep
 * 同为 grey-100(theme.css),拿它当 hover 等于什么都没画。
 */
export const SIDEBAR_ROW =
  "group flex h-8 w-full min-w-0 items-center gap-2 rounded-[7px] px-2 text-left text-[13px] transition-colors [font-weight:500]"
export const SIDEBAR_ROW_IDLE =
  "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-base focus-visible:outline-none"
export const SIDEBAR_ROW_ACTIVE = "bg-v2-overlay-simple-overlay-pressed text-v2-text-text-base"
