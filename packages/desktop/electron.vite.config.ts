import { defineConfig } from "electron-vite"
import appPlugin from "@yoma-desktop/app/vite"

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
    },
    // yoma 必须被 inline,不能外部化。
    // @yoma-desktop/kernel 放在 devDependencies 里,于是 externalizeDeps 不会碰它。
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
