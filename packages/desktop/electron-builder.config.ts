import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
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

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// Owner of the GitHub repos the packaged app checks for auto-updates
// (yoma-embedded/yoma-desktop, and yoma-embedded/yoma-desktop-beta for the beta channel).
// Override the owner via env at release time if needed, e.g. YOMA_GH_OWNER=other-org.
const GH_OWNER = process.env.YOMA_GH_OWNER ?? "yoma-embedded"

const APP_IDS = {
  dev: "com.yoma.desktop.dev",
  beta: "com.yoma.desktop.beta",
  prod: "com.yoma.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "yoma-${os}-${arch}.${ext}",
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
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    // 嵌入式引擎(stm32kernel / probe-rs / controller_map / board_ir / connections)
    // 和 stm32 数据包。**必须走 extraResources 而不是 files** —— 它们是原生可执行文件,
    // 打进 asar 之后不能直接 spawn,而 my-pi 的工具就是 argv 进 JSON 出的黑盒 CLI。
    // 运行时由 main/index.ts 的 resolveEnginesDir() 解析到 process.resourcesPath/engines。
    //
    // 开发期仓库根的 engines 是指向 ../my-pi/engines 的软链,而 engines/bin 与
    // engines/data 里又是指向各引擎构建产物的软链。electron-builder 会 dereference,
    // 所以打包机上必须先跑过 `bun engines/build.ts`,否则这里会是空的 —— 而且不会报错,
    // 只会在用户第一次点烧录时才炸。CI 里要显式校验这两个目录非空。
    {
      from: "../../engines/bin/",
      to: "engines/bin/",
    },
    {
      from: "../../engines/data/",
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
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
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
    target: ["nsis"],
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
        publish: { provider: "github", owner: GH_OWNER, repo: "yoma-desktop-beta", channel: "latest" },
        rpm: { packageName: "yoma-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Yoma",
        protocols: { name: "Yoma", schemes: ["yoma"] },
        publish: { provider: "github", owner: GH_OWNER, repo: "yoma-desktop", channel: "latest" },
        deb: { fpm: [legacyDesktopEntryFpm] },
        rpm: { packageName: "yoma", fpm: [legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
