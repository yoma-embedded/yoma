import type { ImageAttachmentPart, Prompt } from "@/context/prompt"

/** 撤回成功的一条排队消息:内核交回的原文与图片(`session.cancelQueued`)。 */
export type RetractedMessage = {
  entryId: string
  text: string
  files?: Array<{ mime: string; url: string }>
}

/**
 * 撤回的排队消息拼回输入框。照 CC(`popAllEditable`):排队的原文在前、输入框里正在打的在后,中间换行;
 * 图片同理,撤回的在前。光标停在撤回那段的末尾 —— 要改的是它。
 *
 * 内核交回的是送出去的那段正文:@ 提及的文件药丸早已展开成正文,重建不出来,也不假装(同 `extractPromptFromParts`)。
 */
export function prependRetracted(current: Prompt, retracted: readonly RetractedMessage[]) {
  const text = retracted
    .map((item) => item.text)
    .filter((item) => item.length > 0)
    .join("\n")
  const images = retracted.flatMap((item) =>
    (item.files ?? []).map(
      (file, index): ImageAttachmentPart => ({
        type: "image",
        id: `retracted:${item.entryId}:${index}`,
        filename: `image-${index + 1}.${file.mime.split("/")[1] ?? "png"}`,
        mime: file.mime,
        dataUrl: file.url,
      }),
    ),
  )
  const typed = current.filter((part) => part.type !== "image")
  const kept = current.filter((part): part is ImageAttachmentPart => part.type === "image")

  if (!typed.some((part) => part.content.length > 0)) {
    return {
      prompt: [{ type: "text", content: text, start: 0, end: text.length }, ...images, ...kept] as Prompt,
      cursor: text.length,
    }
  }
  if (!text) return { prompt: [...typed, ...images, ...kept] as Prompt, cursor: 0 }

  const head = `${text}\n`
  const shifted = typed.map((part) => ({ ...part, start: part.start + head.length, end: part.end + head.length }))
  const [first, ...rest] = shifted
  const lead: Prompt =
    first?.type === "text"
      ? [{ ...first, content: head + first.content, start: 0 }]
      : [{ type: "text", content: head, start: 0, end: head.length }, ...(first ? [first] : [])]
  return { prompt: [...lead, ...rest, ...images, ...kept], cursor: text.length }
}
