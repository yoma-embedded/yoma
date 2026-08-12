/** 信箱两侧共用的纯文本小工具。零 import 的叶子模块。 */

/** markdown 引用块。提示词与终报都靠它把"别人说的话"和"我们的话"分开。 */
export function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
}
