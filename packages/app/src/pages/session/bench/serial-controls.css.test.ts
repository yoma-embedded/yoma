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

  test("一行里的间距是同一个 8px,多出来的宽度留在端口输入框", () => {
    expect(css).toContain("gap: 8px")
    expect(css).toContain("flex: 1 1 240px")
    expect(css).toContain("font-size: 0")
  })
})
