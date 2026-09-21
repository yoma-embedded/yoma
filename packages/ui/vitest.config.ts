import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

export default defineConfig({
  // hot:false —— 测试里用不到热更新,而开着它在 Windows 上整个文件加载不了:插件注入的虚拟模块
  // `/@solid-refresh` 被 vitest 转成 `file:///@solid-refresh` 交给 createRequire,不带盘符的 file URL
  // 在 Windows 上非法(TypeError: The argument 'filename' must be a file URL…)。2026-09-18 之前 app /
  // app-browser / ui 共 22 个用例文件在 Windows 上一直红,而 CI 的 Windows 岗不跑它们,没人看见。
  plugins: [solid({ hot: false })],
  test: { name: "ui", environment: "happy-dom", include: ["src/**/*.test.ts"] },
})
