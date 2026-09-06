/**
 * 工具链自动安装的 UI 契约。
 *
 * **为什么这里测的是纯函数而不是渲染出来的 DOM**:这个仓库的 bun 测试跑不了 Solid 组件。
 * Solid 的 JSX 必须经 babel-preset-solid(vite-plugin-solid)编译成 dom-expressions 调用,
 * 而 bun 的转译器只有 React 两种运行时;`packages/app` 的 tsconfig 是 `jsx: "preserve"` +
 * `jsxImportSource: "solid-js"`,而 solid-js 包里只有 `jsx-runtime.d.ts`(纯类型,没有运行时),
 * 于是 bun 落回 classic 运行时,任何 JSX 一渲染就是 `ReferenceError: React is not defined`
 * (实测,`solid-js/web` 的 render 也只在 --conditions=browser 下才不是 server 版)。
 * 仓库里 `packages/{app,ui,session-ui}` 至今没有一个组件渲染测试,原因就是这个。
 * 所以 SettingsToolchainV2 的 DOM 契约只能靠 e2e(playwright)去钉,这里钉住可以被单测覆盖的
 * 那一半:进度百分比的算法。
 *
 * 留给实现方的 DOM 契约(playwright / 手工验收用,单测覆盖不到):
 * - 工具行 `.settings-v2-toolchain-row[data-tool="cmake"]`;
 * - 行内 `button[data-action="install"]`,文案含标题 / 版本 / 体积("CMake"、"4.4.3"、"54" MB);
 * - 点击 ⇒ `kernel.toolchain.install({ id: "cmake" })`,并出现 `.settings-v2-toolchain-progress[data-phase]`;
 * - 收到 `{type:"toolchain.install", id:"cmake", phase:"download", bytes:27000000, total:54000000}` 事件后
 *   进度文案含 "50"(= installProgressPercent 的结果);
 * - 安装期间出现 `button[data-action="install-cancel"]`,点击 ⇒ `kernel.toolchain.installCancel({ id: "cmake" })`;
 * - install 返回 `ToolchainInstallResultView` 后该行状态变 ok(直接 mutate 家族视图,不重探);
 * - 家族汇总行在有任何 installable 工具时出现 `button[data-action="install-all"]`。
 *
 * 下面这个函数是那条进度文案唯一的算法来源(卡片与面板共用一份读法,同"逻辑分析仪"的纪律)。
 */

import { describe, expect, test } from "bun:test"

type InstallProgressPercent = (progress: { bytes?: number; total?: number }) => number | undefined

/**
 * 动态说明符:模块还不存在,写成静态 import 会让 `bun typecheck` 整包变红(而红的应该只有这个测试)。
 * 实现方补上 `./toolchain-install.ts` 之后这里就自然通了。
 */
const MODULE_SPECIFIER: string = "./toolchain-install"

async function installProgressPercent(): Promise<InstallProgressPercent> {
  const loaded = (await import(MODULE_SPECIFIER)) as { installProgressPercent?: InstallProgressPercent }
  if (typeof loaded.installProgressPercent !== "function")
    throw new Error(
      "packages/app/src/components/settings-v2/toolchain-install.ts must export installProgressPercent(progress)",
    )
  return loaded.installProgressPercent
}

describe("installProgressPercent", () => {
  test("turns downloaded bytes into a whole percentage", async () => {
    const percent = await installProgressPercent()

    expect(percent({ bytes: 27_000_000, total: 54_000_000 })).toBe(50)
    expect(percent({ bytes: 0, total: 54_000_000 })).toBe(0)
    expect(percent({ bytes: 54_000_000, total: 54_000_000 })).toBe(100)
  })

  test("rounds to the nearest whole percent", async () => {
    const percent = await installProgressPercent()

    expect(percent({ bytes: 1, total: 3 })).toBe(33)
    expect(percent({ bytes: 2, total: 3 })).toBe(67)
  })

  test("has no answer before the total is known", async () => {
    const percent = await installProgressPercent()

    // resolve / verify / extract / record 这些阶段没有 bytes/total,进度行只能显示阶段名。
    expect(percent({})).toBeUndefined()
    expect(percent({ bytes: 27_000_000 })).toBeUndefined()
    expect(percent({ total: 54_000_000 })).toBeUndefined()
  })

  test("never divides by zero", async () => {
    const percent = await installProgressPercent()

    expect(percent({ bytes: 0, total: 0 })).toBeUndefined()
    expect(percent({ bytes: 10, total: 0 })).toBeUndefined()
  })
})
