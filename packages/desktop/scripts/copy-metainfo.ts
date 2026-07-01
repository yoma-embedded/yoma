import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "com.yoma.desktop" : `com.yoma.desktop.${channel}`
const productName = channel === "prod" ? "Yoma" : `Yoma ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `AI coding agent desktop${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="com.yoma">
    <name>Yoma</name>
  </developer>

  <description>
    <p>
      Yoma is a customizable AI coding agent desktop app, built on the opencode server.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="homepage">https://github.com/yoma-embedded/yoma-desktop</url>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
