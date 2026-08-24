import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

/**
 * Windows 代码签名。没有证书时**跳过而不是失败** —— 未签名包是当前已知且被文档
 * 承认的状态(用户装的时候 SmartScreen 会拦一下,点"仍要运行"即可)。
 *
 * 之前的写法是"在 CI 的 Windows 上就无条件调 script/sign-windows.ps1",而那个脚本
 * 从来没存在过 —— 于是任何 Windows CI 打包都必炸,而且错误长得像 pwsh 的问题,
 * 不像"你还没配签名"。
 */
async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return
  if (!existsSync(signScript)) {
    console.warn(`[sign] 跳过签名:${signScript} 不存在 —— 产出的是未签名包(SmartScreen 会拦)`)
    return
  }

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.YOMA_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// 有 Apple 公证凭据(notarytool 的两种喂法之一)才开公证;没有就出"未公证包" ——
// 本机能跑,发给别人要右键打开或 `xattr -cr`。这样没有开发者账号的机器照样能出包,
// 凭据以后配齐了(APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID,或
// APPLE_KEYCHAIN_PROFILE)不改一行代码自动升级成完整签名+公证。
// 签名本身不用管:钥匙串里有 Developer ID 证书 electron-builder 自动用,
// 没有就落到 ad-hoc(arm64 上必须至少 ad-hoc,不能真的"无签名")。
const hasAppleNotaryCreds = Boolean(
  (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD) || process.env.APPLE_KEYCHAIN_PROFILE,
)

// Owner of the GitHub repos the packaged app checks for auto-updates
// (yoma-embedded/yoma-desktop, and yoma-embedded/yoma-desktop-beta for the beta channel).
// 自动更新的来源仓库。2026-08 公开仓是 yoma,自动更新必须指向它 ——
// 继续指向 yoma-desktop 的后果不是"更新不到",而是**可能被降级**:那边还挂着旧
// Release,而下面 updater 开了 allowDowngrade。
// Override the owner via env at release time if needed, e.g. YOMA_GH_OWNER=other-org.
const GH_OWNER = process.env.YOMA_GH_OWNER ?? "yoma-embedded"

const APP_IDS = {
  dev: "com.yoma.desktop.dev",
  beta: "com.yoma.desktop.beta",
  prod: "com.yoma.desktop",
} as const

// 打本机平台(mac-on-mac)的包时直接用 node_modules/electron/dist,不去网上拉
// 同版本的 zip —— 每次打包都请求 GitHub,在这边的网络环境下会随机 TLS 断连。
// 跨平台目标(--win/--linux)仍需下载对应平台的 dist,不能用本地这份。
const wantsForeignPlatform = process.argv.some((arg) => ["--win", "-w", "--linux", "-l"].includes(arg))
const localElectronDist = path.join(packageDir, "node_modules", "electron", "dist")

const getBase = (appId: string): Configuration => ({
  artifactName: "yoma-${os}-${arch}.${ext}",
  ...(wantsForeignPlatform ? {} : { electronDist: localElectronDist }),
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*"],
  // 信箱守护的两个 node 入口必须从 asar 里解出来:它们由 main 用
  // spawn(execPath, [.mjs]) + ELECTRON_RUN_AS_NODE 起,node 的 ESM 加载器
  // 读不了 asar 内的文件。运行时路径由 main/index.ts 做 app.asar → unpacked 替换。
  asarUnpack: ["out/main/mailbox-host.mjs", "out/main/mailbox-turn-entry.mjs"],
  extraResources: [
    // opencode 时代这里还有一个 native/(mac_window.node + swift-build)条目,
    // fork 后该目录已不存在,源码里也无引用,引用一个不存在的 from 会让打包绊倒。
    // 嵌入式引擎(stm32kernel / controller_map / board_ir / connections)
    // 和 stm32 数据包。**必须走 extraResources 而不是 files** —— 它们是原生可执行文件,
    // 打进 asar 之后不能直接 spawn,而 yoma 的工具就是 argv 进 JSON 出的黑盒 CLI。
    // 运行时由 main/index.ts 的 resolveEnginesDir() 解析到 process.resourcesPath/engines。
    //
    // **不能直接指向仓库根的 engines/**:那里面全是软链,而 electron-builder 对
    // extraResources 里的软链是**原样保留**(实测:.app 里出现指向
    // ../controller_map/.venv/bin/... 的断链,签名阶段 stat ENOENT)。所以 package:*
    // 脚本先跑 scripts/stage-engines.ts 校验并**实体化**到 .engines-stage/,这里只认
    // 暂存目录。空目录/悬空软链在 stage 一步就响,不会打出静默的坏包。
    {
      from: ".engines-stage/bin/",
      to: "engines/bin/",
    },
    {
      from: ".engines-stage/data/",
      to: "engines/data/",
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: hasAppleNotaryCreds,
    // engines/data 是给单片机的固件包/芯片数据库/文档,不是 macOS 二进制
    // (里面的 .elf 是 ARM Cortex-M 的,公证也不看)。不跳过的话,签名器会把
    // 几万个数据文件逐个 codesign,一次打包跑几个小时。engines/bin 正常签。
    // schema 只收字符串(按正则源解释),不收 RegExp 对象。
    signIgnore: ["Resources/engines/data"],
    target: ["dmg", "zip"],
  },
  dmg: {
    // dmg 本身不签:公证盖章打在 .app 上,dmg 签名是可选项,而它在没有
    // Developer ID 证书的机器上会让整次打包直接失败。
    sign: false,
  },
  protocols: {
    name: "Yoma",
    schemes: ["yoma"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    // 架构必须写死:不写的话 electron-builder 跟宿主机走,在 arm64 Mac 上会默默
    // 打出 Windows ARM64 包 —— 绝大多数 PC 装不上(实测踩过)。要 win-arm64 再加。
    target: [{ target: "nsis", arch: ["x64"] }],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Yoma Dev",
        rpm: { packageName: "yoma-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Yoma Beta",
        protocols: { name: "Yoma Beta", schemes: ["yoma"] },
        publish: { provider: "github", owner: GH_OWNER, repo: "yoma-beta", channel: "latest" },
        rpm: { packageName: "yoma-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Yoma",
        protocols: { name: "Yoma", schemes: ["yoma"] },
        publish: { provider: "github", owner: GH_OWNER, repo: "yoma", channel: "latest" },
        deb: { fpm: [legacyDesktopEntryFpm] },
        rpm: { packageName: "yoma", fpm: [legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
