import { defineConfig } from "electron-vite"
import appPlugin from "@yoma-desktop/app/vite"

import { licenseDefine, resolveLicenseBuild } from "./scripts/license-build.ts"

// 授权策略是**编译期常量**:两个 main 入口(index.js 与 kernel.js)共享这一份 define。
// 配置不全(商业构建没给可信公钥、社区构建却给了)在这里就抛 —— 构建不该继续。
// prebuild 先拦过一次并印出指纹;这里是第二道,保证真正落进产物的与那一份同源。
const licenseBuild = resolveLicenseBuild(process.env)

const channel = (() => {
  const raw = process.env.YOMA_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.YOMA_CHANNEL === "latest") return "prod"
  return "dev"
})()

export default defineConfig({
  main: {
    define: {
      "import.meta.env.YOMA_CHANNEL": JSON.stringify(channel),
      ...licenseDefine(licenseBuild),
    },
    // yoma 必须被 inline,不能外部化。
    // kernel 与 pi-ai 都放在 devDependencies:两者导出 raw TS,外部化后安装包无法加载。
    build: {
      rollupOptions: {
        input: {
          index: "src/main/index.ts",
          kernel: "src/main/kernel-entry.ts",
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
