import { existsSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import type { Configuration } from "electron-builder"

// 用 electron-builder 自己的匹配器,glob 与目录遍历的语义才是打包时真用的那一套。
const require = createRequire(import.meta.url)
const { FileMatcher } = createRequire(require.resolve("electron-builder"))("app-builder-lib/out/fileMatcher") as {
  FileMatcher: new (
    from: string,
    to: string,
    expand: (value: string) => string,
    patterns: string[],
  ) => { createFilter(): (file: string, stat: ReturnType<typeof statSync>) => boolean }
}
const here = path.dirname(fileURLToPath(import.meta.url))

const channels = [
  { channel: "dev", appId: "com.yoma.desktop.dev" },
  { channel: "beta", appId: "com.yoma.desktop.beta" },
  { channel: "prod", appId: "com.yoma.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.YOMA_CHANNEL
    process.env.YOMA_CHANNEL = channel.channel

    const module = await import(/* @vite-ignore */ `./electron-builder.config.ts?channel=${channel.channel}` as string)
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

  const module = await import(/* @vite-ignore */ "./electron-builder.config.ts?nocreds=1" as string)
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
  const module = await import(/* @vite-ignore */ "./electron-builder.config.ts?electron-dist=1" as string)
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
  const signed = (await import(/* @vite-ignore */ "./electron-builder.config.ts?devid=1" as string))
    .default as Configuration
  expect(signed.mac?.identity).toBeUndefined()
  expect((signed.extraMetadata as { yoma?: { macDeveloperId?: boolean } }).yoma?.macDeveloperId).toBe(true)

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const plain = (await import(/* @vite-ignore */ "./electron-builder.config.ts?devid=0" as string))
    .default as Configuration
  const meta = (plain.extraMetadata as { yoma?: { macDeveloperId?: boolean } }).yoma?.macDeveloperId
  expect(typeof meta).toBe("boolean")
  expect(plain.mac?.identity).toBe(meta ? undefined : "-")
})

test("asar 里不带 node_modules 的类型声明与 source map,运行要用的文件一个不少", async () => {
  const config = (await import(/* @vite-ignore */ "./electron-builder.config.ts?asar-trim=1" as string))
    .default as Configuration
  const excludes = (Array.isArray(config.files) ? config.files : []).filter(
    (value): value is string => typeof value === "string" && value.startsWith("!"),
  )
  const filter = new FileMatcher(here, "", (value) => value, ["**/*", ...excludes]).createFilter()
  const stat = statSync(fileURLToPath(import.meta.url))
  const kept = (file: string) => filter(path.join(here, file), stat)

  // 提升到根的依赖与嵌套在别的包底下的依赖,两种位置都要管到。
  for (const prefix of ["node_modules/", "node_modules/parent/node_modules/"]) {
    for (const file of [
      "effect/dist/Effect.d.ts",
      "effect/dist/Effect.d.ts.map",
      "effect/dist/Effect.js.map",
      "effect/src/Effect.ts",
      "effect/src/internal/core.ts",
      "electron-updater/out/main.d.ts",
      "electron-updater/out/main.js.map",
      "unrelated/dist/index.cjs.map",
      "unrelated/dist/index.mjs.map",
      "unrelated/dist/index.d.cts",
      "unrelated/dist/index.d.mts",
    ]) {
      expect(kept(prefix + file), prefix + file).toBe(false)
    }
    for (const file of [
      "effect/dist/Effect.js",
      "effect/package.json",
      "electron-updater/out/main.js",
      "usb/dist/index.js",
      "usb/prebuilds/darwin-x64+arm64/node.napi.node",
      "unrelated/dist/index.cjs",
      "unrelated/dist/data.json",
      // 只有 effect 的 src 确认过没人引用;别的包的 src 可能就是入口。
      "unrelated/src/index.ts",
      "unrelated/src/index.js",
    ]) {
      expect(kept(prefix + file), prefix + file).toBe(true)
    }
  }

  // 我们自己产物里的 source map 留着。
  expect(kept("out/main/index.js.map")).toBe(true)
  expect(kept("out/renderer/assets/index-abc.js.map")).toBe(true)
})
