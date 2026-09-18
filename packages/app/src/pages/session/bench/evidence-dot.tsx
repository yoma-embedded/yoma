/**
 * 「有我还没看过的新证据」的提示点。一个元素,布局无关 —— 状态栏的一格、底部控制台的页签、
 * 右栏的波形页签三处都用它。
 *
 * 它与 LED 是两件事,所以刻意长得不一样(样式在 session-ui 的 `bench.css`,LED 旁边):
 * **LED 说"这台仪器现在什么状况"**(采集中 = 呼吸的青灯,出了事 = 黄灯),
 * **提示点说"有新东西你还没看"**。一个不动的实心小点,打开对应面板的那一刻就没了。
 *
 * 它是 `role="img"` 而不是 `aria-hidden` 的装饰:一个只有看得见的人才知道的提示点,
 * 对读屏的人就是"这里什么都没发生"。名字会并进外层按钮的可访问名(「调试器 有新证据」)。
 */
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"

export function EvidenceDot(props: { when?: boolean }) {
  const language = useLanguage()
  return (
    <Show when={props.when}>
      <span
        data-component="bench-unseen-dot"
        role="img"
        aria-label={language.t("session.bench.unseen")}
        title={language.t("session.bench.unseen")}
      />
    </Show>
  )
}
