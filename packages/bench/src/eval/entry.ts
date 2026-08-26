#!/usr/bin/env node
/**
 * 评测无头入口(CLI 壳)。逻辑在 {@link runEval},这里只做 argv 解析、写文件、退出码。
 *
 * 打包成 `dist/yoma-eval-entry.mjs`(纯 node,内核 inline)之后由跑批器上传进任务容器:
 *
 *   node yoma-eval-entry.mjs \
 *     --cwd /app \
 *     (--instruction "…" | --instruction-file /path/to/instruction.md) \
 *     --out /logs/agent/result.json [--events /logs/agent/events.jsonl] \
 *     [--provider deepseek --model deepseek-v4-flash-vision-exp --thinking max] \
 *     [--config-dir DIR --sessions-root DIR --state-dir DIR --timeout-ms N] \
 *     [--faux script.json]
 *
 * env 兜底:YOMA_PROVIDER / YOMA_MODEL / YOMA_THINKING / YOMA_EVAL_TIMEOUT_MS。
 * 凭据:`<config-dir>/auth.json`,或各家标准环境变量(DEEPSEEK_API_KEY …)。
 *
 * 退出码:
 *   0  跑完了。**agent 有没有做对不由这里裁** —— 那是跑批器 verifier 的事。
 *   2  配置错误(缺参数、缺凭据、未知模型):这类必须与"agent 没做出来"区分开,
 *      否则跑批器会把"忘了配 key"记成一次模型失败。
 *   1  崩溃。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

import type { FauxScript } from "../faux.ts"
import { BUILD_STAMP, EvalConfigError, runEval } from "./run.ts"

const USAGE = `yoma-eval-entry (${BUILD_STAMP})

  --cwd DIR                  agent 的工作目录(必填)
  --instruction TEXT         任务描述
  --instruction-file FILE    从文件读任务描述(与 --instruction 二选一)
  --out FILE                 结果 JSON 落点(必填)
  --events FILE              事件流 JSONL 落点(transcript)
  --provider ID              默认 deepseek(env: YOMA_PROVIDER)
  --model ID                 默认 deepseek-v4-flash-vision-exp(env: YOMA_MODEL)
  --thinking LEVEL           off/minimal/low/medium/high/xhigh/max(env: YOMA_THINKING)
  --config-dir DIR           凭据/技能/上下文目录,默认 <cwd>/.yoma-eval-config
  --sessions-root DIR        会话 JSONL 根目录,默认 <config-dir>/sessions
  --state-dir DIR            projects.json 等,默认 <config-dir>/state
  --timeout-ms N             一轮墙钟上限(env: YOMA_EVAL_TIMEOUT_MS)
  --faux FILE                假模型脚本:不联网、不要 key,只用于冒烟
`

function fail(message: string): never {
  process.stderr.write(`yoma-eval-entry: ${message}\n`)
  process.exit(2)
}

/** `--k v` / `--k=v` / `--flag`。值以 `--` 开头时当成下一个开关,不吞。 */
function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token?.startsWith("--")) continue
    const body = token.slice(2)
    const eq = body.indexOf("=")
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      flags.set(body, "true")
    } else {
      flags.set(body, next)
      i += 1
    }
  }
  return flags
}

function abs(base: string, p: string): string {
  return isAbsolute(p) ? p : join(base, p)
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  if (flags.has("help") || flags.has("h")) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  const cwdArg = flags.get("cwd")
  if (!cwdArg) fail(`--cwd 必填(agent 的工作目录)\n\n${USAGE}`)
  const cwd = resolve(cwdArg)

  const outArg = flags.get("out")
  if (!outArg) fail(`--out 必填(结果 JSON 落点)\n\n${USAGE}`)
  const out = abs(cwd, outArg)

  let instruction = flags.get("instruction")
  const instructionFile = flags.get("instruction-file")
  if (instructionFile) {
    try {
      instruction = readFileSync(abs(cwd, instructionFile), "utf8")
    } catch (error) {
      fail(`读不到 --instruction-file ${instructionFile}: ${(error as Error).message}`)
    }
  }
  if (!instruction || instruction.trim() === "") fail("需要 --instruction 或 --instruction-file(且非空)")

  const configDir = resolve(flags.get("config-dir") ?? join(cwd, ".yoma-eval-config"))

  const timeoutRaw = flags.get("timeout-ms") ?? process.env.YOMA_EVAL_TIMEOUT_MS
  const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw)
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    fail(`--timeout-ms 必须是正数,收到 ${timeoutRaw}`)
  }

  let faux: FauxScript | undefined
  const fauxFile = flags.get("faux")
  if (fauxFile) {
    try {
      faux = JSON.parse(readFileSync(abs(cwd, fauxFile), "utf8")) as FauxScript
    } catch (error) {
      fail(`读不到 / 解析不了 --faux ${fauxFile}: ${(error as Error).message}`)
    }
  }

  const providerID = flags.get("provider") ?? process.env.YOMA_PROVIDER ?? "deepseek"
  const modelID = flags.get("model") ?? process.env.YOMA_MODEL ?? "deepseek-v4-flash-vision-exp"

  process.stderr.write(
    `yoma-eval-entry (${BUILD_STAMP}) · ${providerID}/${modelID}${faux ? " · faux" : ""} · cwd=${cwd}\n`,
  )

  let output
  try {
    output = await runEval({
      cwd,
      instruction,
      providerID,
      modelID,
      thinking: flags.get("thinking") ?? process.env.YOMA_THINKING,
      configDir,
      sessionsRoot: resolve(flags.get("sessions-root") ?? join(configDir, "sessions")),
      stateDir: resolve(flags.get("state-dir") ?? join(configDir, "state")),
      timeoutMs,
      eventsPath: flags.get("events") ? abs(cwd, flags.get("events")!) : undefined,
      faux,
    })
  } catch (error) {
    if (error instanceof EvalConfigError) fail(error.message)
    throw error
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(output, null, 2))

  const { result } = output
  const errs = result.errors.length > 0 ? ` · ${result.errors.length} 个错误` : ""
  const stop = result.stopReason ? ` · ${result.stopReason}` : ""
  process.stderr.write(
    `完成:${result.toolCalls.length} 次工具调用 · ${(result.elapsedMs / 1000).toFixed(0)}s · ` +
      `$${result.usage.cost.toFixed(4)} · in ${result.usage.tokens.input} / out ${result.usage.tokens.output}` +
      `${errs}${stop}\n`,
  )
  // runTurn 已经 dispose 了 host,但内核的模块级采集器可能还挂着监听(与 turn-entry 同一条)。
  process.exit(0)
}

main().catch((error) => {
  process.stderr.write(`yoma-eval-entry 崩溃: ${(error as Error).stack ?? String(error)}\n`)
  process.exit(1)
})
