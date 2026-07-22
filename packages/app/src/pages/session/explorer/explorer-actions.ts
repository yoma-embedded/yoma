/**
 * 资源管理器动作层：保存 / 重新加载 / 新建文件 / 复制路径 / 树中定位。
 * 写盘走 desktop 的 write-file IPC（platform.writeTextFile，web 端不可用）。
 */
import type { useFile } from "@/context/file"
import type { useLanguage } from "@/context/language"
import type { Platform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import { ancestorDirs, serializeEol, type ExplorerScope } from "./explorer-state"

type FileContext = ReturnType<typeof useFile>
type Language = ReturnType<typeof useLanguage>

export type ExplorerActions = ReturnType<typeof createExplorerActions>

/** 工作区相对路径 → 绝对路径（分隔符跟随根目录风格） */
export function joinWorkspacePath(root: string, path: string): string {
  const windows = root.includes("\\") || /^[A-Za-z]:/.test(root)
  const rel = windows ? path.replace(/\//g, "\\") : path
  const sep = windows ? "\\" : "/"
  const base = root.replace(/[\\/]+$/, "")
  return `${base}${sep}${rel.replace(/^[\\/]+/, "")}`
}

/** 新建文件输入清洗：统一 "/"、去掉首尾分隔符；非法（空 / ".."）返回 undefined */
export function normalizeNewFilePath(input: string): string | undefined {
  const value = input.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "")
  if (!value) return undefined
  const parts = value.split("/")
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined
  return value
}

export function createExplorerActions(input: {
  scope: () => ExplorerScope
  directory: () => string
  file: FileContext
  platform: Platform
  language: Language
}) {
  const { file, platform, language } = input

  const save = async (path: string) => {
    const scope = input.scope()
    const buffer = scope.buffer(path)
    if (!buffer || buffer.saving || !buffer.dirty) return
    const textAtSave = buffer.text
    const eol = buffer.eol
    scope.savingStart(path)
    try {
      const write = platform.writeTextFile
      if (!write) throw new Error(language.t("explorer.saveUnsupported"))
      await write({ root: input.directory(), path, content: serializeEol(textAtSave, eol) })
      scope.savingDone(path, textAtSave, true)
      // 服务器端 watcher 一般会自行失效，这里强刷一次保证各视图（diff/文件页签）立即一致
      void file.load(path, { force: true })
    } catch (error) {
      scope.savingDone(path, textAtSave, false)
      showToast({
        variant: "error",
        title: language.t("explorer.saveError.title"),
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const saveAll = async () => {
    const scope = input.scope()
    for (const path of scope.dirtyPaths()) await save(path)
  }

  const reload = (path: string) => {
    input.scope().discard(path)
    void file.load(path, { force: true })
  }

  /** 新建空文件（已存在则失败），返回工作区相对路径 */
  const createFile = async (rawPath: string) => {
    const rel = normalizeNewFilePath(rawPath)
    if (!rel) throw new Error(language.t("explorer.newFile.invalid"))
    const write = platform.writeTextFile
    if (!write) throw new Error(language.t("explorer.saveUnsupported"))
    await write({ root: input.directory(), path: rel, content: "", exclusive: true })

    // 新路径可能引入全新目录：已加载的祖先层级（含根）都要重刷，
    // 否则新目录不会插进父级的 children，整棵新子树在树里不可见
    const dirs = ancestorDirs(rel)
    for (const dir of ["", ...dirs]) {
      if (file.tree.state(dir)?.loaded) void file.tree.refresh(dir)
    }
    for (const dir of dirs) file.tree.expand(dir)
    return rel
  }

  const copyPath = (path: string, options?: { relative?: boolean }) => {
    const value = options?.relative ? path : joinWorkspacePath(input.directory(), path)
    void navigator.clipboard?.writeText(value)
  }

  const revealInTree = (path: string) => {
    const scope = input.scope()
    scope.setTreeVisible(true)
    for (const dir of ancestorDirs(path)) file.tree.expand(dir)
  }

  return { save, saveAll, reload, createFile, copyPath, revealInTree }
}
