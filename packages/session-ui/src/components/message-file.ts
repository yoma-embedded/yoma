import type { FilePart } from "@yoma-desktop/kernel"

export function attached(part: FilePart) {
  return part.url.startsWith("data:")
}

export function inline(part: FilePart) {
  if (attached(part)) return false
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

export function kind(part: FilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}
