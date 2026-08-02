import type { Part, TextPart } from "@yoma-desktop/kernel"
import type { ImageAttachmentPart, Prompt } from "@/context/prompt"

function textPartValue(parts: Part[]) {
  const candidates = parts.filter((part): part is TextPart => part.type === "text").filter((part) => !part.synthetic)
  return candidates.reduce((best: TextPart | undefined, part) => {
    if (!best) return part
    if (part.text.length > best.text.length) return part
    return best
  }, undefined)
}

/**
 * Extract prompt content from message parts for restoring into the prompt input.
 *
 * The kernel view model keeps no mention offsets on parts (no `FilePart.source`, no agent
 * parts), so a restored prompt is plain text plus whatever attachments came back as
 * `data:` URLs — inline file pills cannot be reconstructed and are not faked.
 */
export function extractPromptFromParts(parts: Part[], opts?: { attachmentName?: string }): Prompt {
  const textPart = textPartValue(parts)
  const text = textPart?.text ?? ""
  const attachmentName = opts?.attachmentName ?? "attachment"

  const images: ImageAttachmentPart[] = []
  for (const part of parts) {
    if (part.type !== "file") continue
    if (!part.url.startsWith("data:")) continue
    images.push({
      type: "image",
      id: part.id,
      filename: part.filename ?? attachmentName,
      mime: part.mime,
      dataUrl: part.url,
    })
  }

  const result: Prompt = [{ type: "text", content: text, start: 0, end: text.length }]
  if (images.length === 0) return result
  return [...result, ...images]
}
