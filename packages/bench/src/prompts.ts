/**
 * 交给 agent 的话术。
 *
 * 这里是"调试循环纪律"的落点。M9 的技能加载器还没做(my-pi 的 skills.ts 只有格式化器),
 * 所以纪律先以任务提示词的形态注入 —— 等 `.my-pi/skills/` 那套接通了,再把这段搬过去,
 * 形状是一样的。
 *
 * 三条纪律,每条都对着一种实际见过的失败:
 *   1. **先复现再修**。模型拿到 bug 描述会立刻开始改代码,改完发现根本没复现过,
 *      于是"修好了"是修了一个想象中的问题。第一轮强制只做复现和取证。
 *   2. **一轮一个假设**。同时改三处的后果是判据失败时不知道是哪处错了,而且
 *      diff 会大到人不愿意 review。
 *   3. **判据不归你管**。模型看不到 grader 的执行,只看到结果。明确告诉它
 *      "你说修好了不算数",省得它把时间花在自证上。
 */

import type { Job, JobCheck } from "./job.ts"
import type { GradeResult } from "./grader.ts"

export function describeChecks(checks: JobCheck[]): string {
  return checks
    .map((check) => {
      switch (check.type) {
        case "build":
        case "bash":
          return `- 命令 \`${check.command}\` 要退出码 ${check.type === "bash" ? (check.expectExitCode ?? 0) : 0}`
        case "log_wait":
          return `- 设备日志里要出现 /${check.pattern}/`
        case "log_absent":
          return `- 设备日志里不能出现 /${check.pattern}/`
      }
    })
    .join("\n")
}

/** 第一轮:只准复现和取证,不准改代码。 */
export function firstPrompt(job: Job): string {
  const hardware = [
    job.bench.board && `板卡:${job.bench.board}`,
    job.bench.chip && `芯片:${job.bench.chip}`,
    job.bench.probe && `探针:${job.bench.probe}`,
    job.bench.elf && `本任务的 ELF:${job.bench.elf}`,
  ]
    .filter(Boolean)
    .join("\n")

  return `# 调试任务:${job.title}

${job.task}

## 硬件
${hardware || "(未声明)"}

## 成功判据(由调试台独立执行,你说"修好了"不算数)
${job.success.build ? `- 先要构建通过:\`${job.success.build}\`\n` : ""}${describeChecks(job.success.checks)}

## 工具约束(先读,能省你好几轮)

- **bash 一次只能跑一条命令**:不能用 \`&&\`、\`;\`、\`|\`、反引号、\`$(...)\` 串联 ——
  权限策略管不住串联后半段,会直接拦下。要多步就分多次调用。
- **不需要 \`cd\`**:工作目录已经是仓库根,\`cd\` 只会让命令被拦。
- 命令白名单之外的东西(如 \`rm\`、\`curl\`)会被拦;\`git\` 只能用查询类子命令,
  提交由调试台负责,你不用管。
- 被拦下的动作**别原地重试** —— 换一条路,或说明为什么非它不可。

## 这一轮只做一件事:复现,并留下证据

**先别改任何代码。** 这一轮请你:
1. 读懂相关代码,判断问题可能出在哪;
2. 构建并烧录当前代码,用日志或 gdb **亲眼看到问题发生**;
3. 说清楚:你观察到了什么(贴关键日志行/停点)、你认为根因是什么、下一轮打算改哪一处。

如果复现不出来,直接说复现不出来以及你试了什么 —— 那本身就是重要结论,别去改代码碰运气。`
}

/** 后续轮:带上判据失败的证据。 */
export function retryPrompt(job: Job, grade: GradeResult, iteration: number): string {
  const failures = [grade.build, ...grade.checks]
    .filter((result) => result && (result.outcome === "fail" || result.outcome === "error"))
    .map((result) => {
      const header = `### ${result!.outcome === "error" ? "判据没跑成" : "判据没过"}:${result!.summary}`
      return result!.evidence ? `${header}\n\n\`\`\`\n${result!.evidence}\n\`\`\`` : header
    })
    .join("\n\n")

  const environment = grade.hasEnvironmentError
    ? `\n**注意:上面有判据是"没跑成"而不是"没通过"** —— 那是环境问题(命令不存在、探针没连上、超时)。
先把环境问题说清楚,不要去改代码迁就它。\n`
    : ""

  return `# 第 ${iteration} 轮:判据仍未通过

调试台刚刚独立跑了一遍判据,结果如下。

${failures}
${environment}
## 这一轮的纪律

- **一次只验证一个假设**。说清楚你这轮改的是哪一处、为什么认为它是根因。
- 改完之后**自己先复现一遍**(构建、烧录、看日志),别把没验证过的改动交上来。
- 如果上一轮的假设被证伪了,明确说"假设 X 不成立,证据是 Y",再提新假设。
- 判据会由调试台再跑一遍 —— 不用自己声明成功。`
}

/** 权限被拒之后的续跑提示:告诉 agent 此路不通,别原地重试。 */
export function blockedPrompt(blocked: { tool: string; title: string; why?: string }[]): string {
  const list = blocked.map((item) => `- \`${item.tool}\`:${item.title}${item.why ? `(${item.why})` : ""}`).join("\n")
  return `# 上一轮有动作被权限策略拦下

${list}

这些动作在本任务的策略下不可用。**别重试同一个动作** —— 换一条路达到目的,
或者说清楚为什么非它不可(人会看到这段话)。`
}
