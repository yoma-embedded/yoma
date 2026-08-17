import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"

const channels = [
  { channel: "dev", appId: "com.yoma.desktop.dev" },
  { channel: "beta", appId: "com.yoma.desktop.beta" },
  { channel: "prod", appId: "com.yoma.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.YOMA_CHANNEL
    process.env.YOMA_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.YOMA_CHANNEL
    else process.env.YOMA_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
  })
}

test("没有 Apple 公证凭据时降级为不公证、dmg 不签名,而不是让打包失败", async () => {
  const saved = {
    APPLE_ID: process.env.APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    APPLE_KEYCHAIN_PROFILE: process.env.APPLE_KEYCHAIN_PROFILE,
  }
  delete process.env.APPLE_ID
  delete process.env.APPLE_APP_SPECIFIC_PASSWORD
  delete process.env.APPLE_KEYCHAIN_PROFILE

  const module = await import("./electron-builder.config.ts?nocreds=1")
  const config = module.default as Configuration

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  expect(config.mac?.notarize).toBe(false)
  expect(config.dmg?.sign).toBe(false)
})

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.YOMA_CHANNEL
  process.env.YOMA_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.YOMA_CHANNEL
  else process.env.YOMA_CHANNEL = previous

  expect(config.deb?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`)
  expect(config.rpm?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode.desktop %U")
  expect(desktop).toContain("Icon=ai.opencode.desktop")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
})
