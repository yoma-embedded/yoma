/**
 * 右栏"调试"档的内容。
 *
 * v2-console 里它是**按需仪器页**(`console/instrument-rail.tsx`):只放波形类仪器
 * (示波器 / 逻辑分析仪),文本流(日志 / GDB)在底部控制台。这一层壳留着是因为
 * `debug-panel.css` 里的 `--d-*` token 与 `[data-component="la-body"]` /
 * `[data-component="scope-body"]` 的样式仍住在这个目录 —— 两台老仪器还在按那套变量画。
 */
import { InstrumentRail } from "../console/instrument-rail"
import "./debug-panel.css"

export function DebugContent() {
  return <InstrumentRail />
}
