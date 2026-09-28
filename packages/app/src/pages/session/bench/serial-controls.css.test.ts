import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

// happy-dom 下 import.meta.url 不是 file:。从 cwd 找,根目录 `--project app` 和包目录里跑都要成立。
const rel = "src/pages/session/bench/serial-controls.css"
const file = [resolve(process.cwd(), rel), resolve(process.cwd(), "packages/app", rel)].find((path) => existsSync(path))
const css = readFileSync(file ?? rel, "utf8")
const consoleRel = "src/pages/session/console/console.css"
const consoleFile = [resolve(process.cwd(), consoleRel), resolve(process.cwd(), "packages/app", consoleRel)].find(
  (path) => existsSync(path),
)
const consoleCss = readFileSync(consoleFile ?? consoleRel, "utf8")

describe("串口栏的样式", () => {
  test("下拉箭头用主题色拼出来,不把 light-dark 用在图片上", () => {
    // light-dark() 只接受颜色。写进 background-image 时整条声明作废,框上就没有箭头。
    expect(css).not.toContain("light-dark(")
    expect(css).toContain("appearance: none")
    expect(css).toContain("-webkit-appearance: none")
    expect(css).toContain("linear-gradient(45deg, transparent 50%, var(--text-weak) 50%)")
    expect(css).toContain("linear-gradient(135deg, var(--text-weak) 50%, transparent 50%)")
  })

  test("连接那一组不抢宽度:端口框有上限,读数只拿剩下的宽度", () => {
    expect(css).toMatch(/\[data-slot="port-field"\] \{\s*flex: 100 1 118px;\s*max-width: 230px;\s*min-width: 118px;/)
    expect(css).toMatch(/\[data-slot="readout"\] \{\s*flex: 1 1 0;/)
    expect(css).toContain("font-size: 0")
  })

  test("▾ 弹出来的选项自己有字号与颜色,不继承选择框为 macOS 归零的字号", () => {
    // Windows / Linux 的 Chromium 按 <option> 的计算样式画弹层:继承了 font-size: 0 就是一条 28px 宽的空竖条。
    const option = /\[data-component="serial-choice"\] option \{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(option).toMatch(/font-size: 12px;/)
    expect(option).not.toMatch(/font-size: 0/)
    expect(option).toMatch(/color: var\(--text-strong\);/)
    expect(option).toMatch(/background-color: var\(--background-base\);/)
    // 选择框本身的归零还在(macOS 会把选中项画出来)。
    expect(css).toMatch(/\[data-component="serial-choice"\] select \{[^}]*font-size: 0;[^}]*\}/)
  })

  test("先缩后折:wrap 下各件的基准就是下限,放不下下限才折行,不靠写死的断点", () => {
    // 写死的断点(工具条 ≤ 620px 才 wrap)只对得上一种状态:过滤着 + 连着 + 英文时下限加起来 700px 上下,
    // 控制台 640–720px 之间不折也放不下,关闭按钮被裁掉(Electron 里对真组件的 DOM 量过)。
    const toolbar = /\[data-slot="toolbar"\] \{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(toolbar).toMatch(/flex-wrap: wrap;/)
    expect(css).not.toMatch(/flex-wrap: nowrap/)
    expect(css).not.toMatch(/@container/)
    // 端口框 / 器件名框:基准 = 下限 118px,grow 长回 230px。**不许再写 width**:基准按 width 算的话,
    // 折不折就按满宽 230px 算,1024 宽的窗口里(macOS runner)整条折成两行。
    for (const slot of ["port-field", "device-field"]) {
      const rule = new RegExp(`\\[data-slot="${slot}"\\] \\{([^}]*)\\}`).exec(css)?.[1] ?? ""
      expect(rule, slot).toMatch(/flex: 100 1 118px;/)
      expect(rule, slot).toMatch(/max-width: 230px;/)
      expect(rule, slot).toMatch(/min-width: 118px;/)
      expect(rule, slot).not.toMatch(/(^|[^-])width: 230px/)
    }
    // 控制台里的过滤框:基准就是 console.css 给它的下限,压过那条 `flex: 0 1 180px`,grow 长回 180px。
    const filter =
      /\[data-slot="toolbar-end"\] > \[data-slot="controls"\] > input\[data-slot="filter"\] \{([^}]*)\}/.exec(css)?.[1]
    expect(filter).toMatch(/flex: 100 1 90px;/)
    expect(filter).toMatch(/max-width: 180px;/)
    const consoleFilter = /\[data-slot="controls"\] input\[data-slot="filter"\] \{([^}]*)\}/.exec(consoleCss)?.[1] ?? ""
    expect(consoleFilter).toMatch(/min-width: 90px;/)
  })

  test("三组拆成工具条的直接子项,端口框与过滤框才缩得动;连接按钮不许被挤", () => {
    // 嵌套的组在 Chromium 里按端口框写死的 230px、过滤框的固有宽度算下限,两组都缩不动,整行往右溢出。
    expect(css).toMatch(
      /\[data-slot="connection"\],\s*\[data-slot="toolbar-end"\],\s*\[data-slot="toolbar-end"\] > \[data-slot="controls"\] \{\s*display: contents;/,
    )
    // 右端那一组不能在后面又被写回 display: flex(同一特异度,后写的赢)。
    expect(css).not.toMatch(/\[data-slot="toolbar-end"\] \{\s*display: flex;/)
    expect(css).toMatch(/\[data-slot="connect"\] \{\s*flex: none;/)
  })
})
