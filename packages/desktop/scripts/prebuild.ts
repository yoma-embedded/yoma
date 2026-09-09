import { copyIcons } from "./copy-icons"
import { writeMetainfo } from "./copy-metainfo"
import { resolveChannel } from "./utils"

const channel = resolveChannel()
copyIcons(channel)
writeMetainfo(channel)

// 后端内核是 ../yoma 的源码,由 electron-vite 在构建期 inline 进 out/main/kernel.js
// (见 packages/kernel/kernel-alias.ts)。这里不需要准备任何后端产物。
