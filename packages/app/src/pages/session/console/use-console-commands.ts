/**
 * 底部控制台的命令。
 *
 * `Mod+J` 是 VS Code 的 bottom panel、也是 CLion / Keil 那一排工具窗口的肌肉记忆。
 * 查过全仓已注册的 17 个键位(`mod+[` `mod+]` `mod+b` `mod+k` `mod+w` `mod+\` `ctrl+l` …),
 * `mod+j` 是空的。
 *
 * 逐台仪器那几条**从注册表生成**,不是写死的三行:加一台文本流仪器(将来的上位机控制台)
 * 之后,命令面板里自动多一条"控制台:上位机",这里一个字都不用改。
 */
import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { INSTRUMENTS, benchPins, isVisible } from "../bench/instruments"
import { useBenchStatus } from "../bench/use-bench-status"
import { EMPTY_BENCH_DISK } from "../bench/instruments"
import { consoleUI } from "./console-state"

export function useConsoleCommands() {
  const command = useCommand()
  const language = useLanguage()
  const sdk = useSDK()
  const status = useBenchStatus()

  const category = () => language.t("command.category.view")

  /**
   * 判"该不该先钉住"时**只看 transcript,不看磁盘**:命令注册在会话页的最外层,
   * 而磁盘探测住在 BenchProvider 里(那是给面板用的)。多钉一次的代价是 localStorage 里
   * 多一条记录,少钉一次的代价是"点了命令,控制台闪一下又空了"。
   */
  const ctx = () => ({ status: status(), disk: EMPTY_BENCH_DISK, pinned: benchPins.all() })

  command.register("session-console", () => {
    const options: CommandOption[] = [
      {
        id: "console.toggle",
        title: language.t("session.console.toggle"),
        category: category(),
        keybind: "mod+j",
        disabled: !sdk().directory,
        onSelect: () => consoleUI.toggle(),
      },
    ]

    for (const instrument of INSTRUMENTS) {
      if (instrument.surface !== "text") continue
      options.push({
        id: `console.${instrument.id}`,
        title: language.t("session.console.show", {
          name: language.t(instrument.labelKey as Parameters<typeof language.t>[0]),
        }),
        category: category(),
        disabled: !sdk().directory,
        onSelect: () => {
          if (!isVisible(instrument, ctx())) benchPins.pin(instrument.id)
          consoleUI.open(instrument.id)
        },
      })
    }

    return options
  })
}
