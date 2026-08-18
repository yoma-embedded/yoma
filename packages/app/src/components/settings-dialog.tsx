import { onCleanup } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useDialog } from "@yoma-desktop/ui/context/dialog"

export function useSettingsDialog() {
  const dialog = useDialog()
  let run = 0
  let dead = false

  onCleanup(() => {
    dead = true
  })

  // initialTab 打开到指定标签(如预检横幅的"去配置"直达工具链页)。typeof 守卫是
  // 承重的:大量调用点把返回的函数直接当 onClick/onSelect 用,第一个参数是事件对象。
  return (initialTab?: unknown) => {
    const tab = typeof initialTab === "string" ? initialTab : undefined
    const current = ++run
    void import("@/components/settings-v2").then((module) => {
      if (dead || run !== current) return
      void dialog.show(() => <module.DialogSettings initialTab={tab} />)
    })
  }
}

export function useSettingsCommand() {
  const command = useCommand()
  const language = useLanguage()
  const show = useSettingsDialog()

  command.register("settings", () => [
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      keybind: "mod+comma",
      onSelect: show,
    },
  ])

  return show
}
