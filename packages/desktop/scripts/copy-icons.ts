import { cpSync, rmSync } from "node:fs"
import type { Channel } from "./utils"

export function copyIcons(channel: Channel): void {
  const src = `./icons/${channel}`
  const dest = "resources/icons"
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  console.log(`Copied ${channel} icons from ${src} to ${dest}`)
}
