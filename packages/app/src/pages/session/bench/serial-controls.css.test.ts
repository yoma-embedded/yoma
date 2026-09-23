import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

// happy-dom 下 import.meta.url 不是 file:。从 cwd 找,根目录 `--project app` 和包目录里跑都要成立。
const rel = "src/pages/session/bench/serial-controls.css"
const file = [resolve(process.cwd(), rel), resolve(process.cwd(), "packages/app", rel)].find((path) => existsSync(path))
const css = readFileSync(file ?? rel, "utf8")

describe("串口栏的样式", () => {
  test("下拉箭头用主题色拼出来,不把 light-dark 用在图片上", () => {
    // light-dark() 只接受颜色。写进 background-image 时整条声明作废,框上就没有箭头。
    expect(css).not.toContain("light-dark(")
    expect(css).toContain("appearance: none")
    expect(css).toContain("-webkit-appearance: none")
    expect(css).toContain("linear-gradient(45deg, transparent 50%, var(--text-weak) 50%)")
    expect(css).toContain("linear-gradient(135deg, var(--text-weak) 50%, transparent 50%)")
  })

  test("连接那一组不抢宽度:端口框有上限,多出来的宽度留给读数", () => {
    expect(css).toMatch(/\[data-slot="port-field"\] \{\s*flex: 0 1 auto;\s*width: 230px;/)
    expect(css).toMatch(/\[data-slot="readout"\] \{\s*flex: 1 1 80px;/)
    expect(css).toContain("font-size: 0")
  })

  test("工具条挤不下时折行,不把按钮压成一堆", () => {
    expect(css).toMatch(/\[data-slot="toolbar"\] \{[^}]*flex-wrap: wrap;/)
  })
})
