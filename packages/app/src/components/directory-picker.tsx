import { usePlatform } from "@/context/platform"

/**
 * 「打开文件夹」背后的唯一一条路:系统原生选择框。
 *
 * 原来这里有分流:desktop + 本地服务器走原生,其它情况弹一个自己画的应用内目录浏览器
 * (爬远端服务器的目录树)。远端服务器这个概念没了 —— 内核是进程内的,用户看的就是本机
 * 文件系统 —— 那条分支在真机上永不执行,连带 933 行对话框一起删掉了。
 *
 * web host(dev:web)没有 openDirectoryPickerDialog:那里没有原生对话框也没有远端可爬,
 * 于是直接回 null,调用点本来就在处理"用户取消"。
 */
export function useDirectoryPicker() {
  const platform = usePlatform()

  return (input: { title?: string; multiple?: boolean; onSelect: (result: string | string[] | null) => void }) => {
    const open = platform.platform === "desktop" ? platform.openDirectoryPickerDialog : undefined
    if (!open) {
      input.onSelect(null)
      return
    }
    void open({ title: input.title, multiple: input.multiple }).then(input.onSelect)
  }
}
