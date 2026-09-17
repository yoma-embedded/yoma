import { existsSync } from "node:fs"
import { expect, test } from "vitest"
import type { Configuration } from "electron-builder"

const channels = [
  { channel: "dev", appId: "com.yoma.desktop.dev" },
  { channel: "beta", appId: "com.yoma.desktop.beta" },
  { channel: "prod", appId: "com.yoma.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.YOMA_CHANNEL
    process.env.YOMA_CHANNEL = channel.channel

    const module = await import(/* @vite-ignore */ (`./electron-builder.config.ts?channel=${channel.channel}` as string))
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.YOMA_CHANNEL
    else process.env.YOMA_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    // "只通知"更新器打开的发布页与 publish 指的必须是同一个仓库;dev 渠道两样都没有。
    const releaseRepo = (config.extraMetadata as { yoma?: { releaseRepo?: string } }).yoma?.releaseRepo
    const publish = config.publish as { owner?: string; repo?: string } | undefined
    expect(releaseRepo).toBe(publish ? `https://github.com/${publish.owner}/${publish.repo}` : undefined)
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

  const module = await import(/* @vite-ignore */ ("./electron-builder.config.ts?nocreds=1" as string))
  const config = module.default as Configuration

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  expect(config.mac?.notarize).toBe(false)
  expect(config.dmg?.sign).toBe(false)
})

test("electronDist 要么不设、要么指向真实存在的目录", async () => {
  // 写死成 packages/desktop/node_modules/electron/dist 的那一版在 npm workspace 下永远不存在,
  // mac 一打包就炸;Windows 走下载分支,所以只有 mac 会撞上。
  const module = await import(/* @vite-ignore */ ("./electron-builder.config.ts?electron-dist=1" as string))
  const config = module.default as Configuration
  if (config.electronDist !== undefined) {
    expect(typeof config.electronDist).toBe("string")
    expect(existsSync(config.electronDist as string)).toBe(true)
  }
})

test("mac 签名:没有 Developer ID 就显式 ad-hoc,并且把这件事如实写进包内元数据", async () => {
  // electron-builder 26 找不到证书时是**跳过**签名而不是回落到 ad-hoc,出来的 .app 封印是坏的
  // (下载后 macOS 报"已损坏")。所以没有证书时 identity 必须是 "-";而更新器看的 macDeveloperId
  // 必须与它同真同假 —— 两边说的不是一件事时,要么白关更新、要么 ad-hoc 包陷进下载循环。
  const saved = { CSC_LINK: process.env.CSC_LINK, CSC_NAME: process.env.CSC_NAME }

  process.env.CSC_LINK = "file:///not-a-real-cert.p12"
  const signed = (await import(/* @vite-ignore */ ("./electron-builder.config.ts?devid=1" as string)))
    .default as Configuration
  expect(signed.mac?.identity).toBeUndefined()
  expect((signed.extraMetadata as { yoma?: { macDeveloperId?: boolean } }).yoma?.macDeveloperId).toBe(true)

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const plain = (await import(/* @vite-ignore */ ("./electron-builder.config.ts?devid=0" as string)))
    .default as Configuration
  const meta = (plain.extraMetadata as { yoma?: { macDeveloperId?: boolean } }).yoma?.macDeveloperId
  expect(typeof meta).toBe("boolean")
  expect(plain.mac?.identity).toBe(meta ? undefined : "-")
})
