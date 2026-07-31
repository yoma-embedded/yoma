import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@yoma-desktop/app/vite"
// 相对路径导入,不走包说明符 —— vite 的 config 加载器对 workspace 符号链接的
// 外部化行为不稳定,而这张表必须在配置求值时就存在。
import { MY_PI_VITE_ALIAS } from "../kernel/mypi.ts"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    // my-pi 必须被 inline,不能外部化 —— 见 packages/kernel/mypi.ts 顶部的说明。
    // @yoma-desktop/kernel 放在 devDependencies 里,于是 externalizeDeps 不会碰它。
    resolve: { alias: MY_PI_VITE_ALIAS },
    build: {
      rollupOptions: {
        input: {
          index: "src/main/index.ts",
          sidecar: "src/main/sidecar.ts",
          kernel: "src/main/kernel-entry.ts",
        },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          // Externalize the prebuilt server bundle as its bare package specifier instead of inlining
          // (or copying) it. Re-bundling the 30MB bun bundle through rollup/esbuild corrupts it
          // (v1.17.14 pulls the TS language service in, tripping an "Unterminated string literal" at
          // renderChunk). Resolving to the package name — not a copied-out file — keeps node.js
          // running from its own node_modules dir at runtime, where its deps (jsonc-parser,
          // @lydell/node-pty) and its .wasm files are colocated siblings and resolve naturally.
          if (id === "virtual:opencode-server") return { id: "@yoma-desktop/opencode-server", external: true }
        },
      },
    ],
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
    plugins: [appPlugin, sentry],
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
