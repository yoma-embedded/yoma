/**
 * 把 composer 里的一串 Prompt 片段编成内核要的 `PromptInput`。
 *
 * 相对 opencode 少了三样东西,都是内核里根本不存在的:
 *   - **agent part** —— 没有 @agent 提及,也没有 persona;
 *   - **file part 的 source** —— 内核只收 `{ mime, url, filename }`,不收提及在原文里的偏移量;
 *   - **text part 的 metadata / ignored** —— 于是行内评论不再是一条带结构化 metadata 的
 *     synthetic part,而是直接拼进正文。渲染端读不到 metadata 了,拼进正文是唯一诚实的做法。
 *
 * 返回两样:发给内核的 `input`,和乐观插入 transcript 的 `optimisticParts`。两者刻意保持
 * 同构(一条 text + 若干 file),这样真实的 message.updated 回来替换时不会跳。
 */

import { getFilename } from "@yoma-desktop/util/path"
import type { Part, PromptInput } from "@yoma-desktop/kernel"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type { FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { Identifier } from "@/utils/id"
import { formatCommentNote } from "@/utils/comment-note"

type RequestFile = { mime: string; url: string; filename?: string }

type ContextFile = {
  key: string
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

type BuildRequestPartsInput = {
  prompt: Prompt
  context: ContextFile[]
  images: ImageAttachmentPart[]
  text: string
  messageID: string
  sessionID: string
  sessionDirectory: string
}

const absolute = (directory: string, path: string) => {
  if (path.startsWith("/")) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return path
  if (path.startsWith("\\\\") || path.startsWith("//")) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""

const mention = /(^|[\s([{"'])@(\S+)/g

const parseCommentMentions = (comment: string) => {
  return Array.from(comment.matchAll(mention)).flatMap((match) => {
    const path = (match[2] ?? "").replace(/[.,!?;:)}\]"']+$/, "")
    if (!path) return []
    return [path]
  })
}

const isFileAttachment = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"

export function buildRequestParts(input: BuildRequestPartsInput) {
  const files = input.prompt.filter(isFileAttachment).map((attachment) => {
    const path = absolute(input.sessionDirectory, attachment.path)
    return {
      mime: attachment.mime ?? "text/plain",
      url: attachment.url ?? `file://${encodeFilePath(path)}${fileQuery(attachment.selection)}`,
      filename: attachment.filename ?? getFilename(attachment.path),
    } satisfies RequestFile
  })

  const used = new Set(files.map((part) => part.url))
  const notes: string[] = []

  const context = input.context.flatMap((item) => {
    const path = absolute(input.sessionDirectory, item.path)
    const url = `file://${encodeFilePath(path)}${fileQuery(item.selection)}`
    const comment = item.comment?.trim()
    if (!comment && used.has(url)) return []
    used.add(url)

    const filePart = {
      mime: "text/plain",
      url,
      filename: getFilename(item.path),
    } satisfies RequestFile

    if (!comment) return [filePart]

    notes.push(formatCommentNote({ path: item.path, selection: item.selection, comment }))

    const mentions = parseCommentMentions(comment).flatMap((mentioned) => {
      const mentionURL = `file://${encodeFilePath(absolute(input.sessionDirectory, mentioned))}`
      if (used.has(mentionURL)) return []
      used.add(mentionURL)
      return [
        {
          mime: "text/plain",
          url: mentionURL,
          filename: getFilename(mentioned),
        } satisfies RequestFile,
      ]
    })

    return [filePart, ...mentions]
  })

  const images = input.images.map((attachment) => {
    return {
      mime: attachment.mime,
      url: attachment.dataUrl,
      filename: attachment.sourcePath ?? attachment.filename,
    } satisfies RequestFile
  })

  const requestFiles = [...files, ...context, ...images]
  const text = [input.text, ...notes].filter((value) => value.length > 0).join("\n\n")

  const promptInput: PromptInput = {
    text,
    messageID: input.messageID,
    ...(requestFiles.length > 0 ? { files: requestFiles } : {}),
  }

  const optimisticParts: Part[] = [
    {
      id: Identifier.ascending("part"),
      type: "text",
      text,
      sessionID: input.sessionID,
      messageID: input.messageID,
    },
    ...requestFiles.map(
      (file): Part => ({
        id: Identifier.ascending("part"),
        type: "file",
        mime: file.mime,
        url: file.url,
        filename: file.filename,
        sessionID: input.sessionID,
        messageID: input.messageID,
      }),
    ),
  ]

  return { input: promptInput, optimisticParts }
}
