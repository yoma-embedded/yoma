import type { FilePart } from "@yoma-desktop/kernel"

export function attached(part: FilePart) {
  return part.url.startsWith("data:")
}

export function kind(part: FilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}
