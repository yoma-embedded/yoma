/**
 * 右栏"调试"档的内容。
 *
 * 真正的装配在 `pages/session/bench/bench-panel.tsx`(状态条 + 注册表驱动的仪器窗口),
 * 这里只剩一层壳:`debug-panel.css` 里的 `--d-*` token 与 `[data-component="la-body"]`
 * / `[data-component="scope-body"]` 的样式仍住在这个目录,所以这份 import 是承重的 ——
 * 两台老仪器的面板还在按那套变量画。
 */
import { BenchPanel } from "../bench/bench-panel"
import "./debug-panel.css"

export function DebugContent() {
  return <BenchPanel />
}
