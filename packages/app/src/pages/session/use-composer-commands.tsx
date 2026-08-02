import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { useSessionLayout } from "./session-layout"
import { createSessionOwnership } from "./session-ownership"

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useComposerCommands = () => {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const { sessionKey } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const modelCommand = withCategory(language.t("command.category.model"))

  const chooseModel = async () => {
    const owner = sessionOwnership.capture()
    const { DialogSelectModel } = await import("@/components/dialog-select-model")
    owner.run(() => {
      void dialog.show(() => <DialogSelectModel model={local.model} />)
    })
  }

  command.register("composer", () => [
    modelCommand({
      id: "model.choose",
      title: language.t("command.model.choose"),
      description: language.t("command.model.choose.description"),
      keybind: "mod+'",
      slash: "model",
      onSelect: chooseModel,
    }),
    modelCommand({
      id: "model.variant.cycle",
      title: language.t("command.model.variant.cycle"),
      description: language.t("command.model.variant.cycle.description"),
      keybind: "shift+mod+d",
      onSelect: () => local.model.variant.cycle(),
    }),
  ])
}
