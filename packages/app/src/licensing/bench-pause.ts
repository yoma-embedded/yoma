/**
 * 调试台"因为授权停住了"横幅该不该出、该说哪一种"接下来怎么办"。
 *
 * 抽成纯函数是因为这里有三处**看起来一样、说错就误导人**的分叉:
 *  1. 守护还活着停在轮次边界(`step` 的 `license-paused`)→ 它自己会接着跑;
 *     守护已经退了 / 压根没起来(`phase: "paused"`、`done.license`、`start()` 回了 license)
 *     → 要人重新点开始。说反了的代价是用户干等,或者白等一个不会自己动的任务。
 *  2. **跑着的时候 `status.done` 里可能还躺着上一单的记录** —— 拿它说话会在任务跑得好好的
 *     时候挂出一条横幅。
 *  3. 授权补好之后,"自己会接着跑"那一种不该再吓人(收掉),"要人点开始"那一种要留着,
 *     并且话要换成"授权已就绪,点开始"。
 */

import type { LicenseRequiredData, LicenseState, MailboxStatusView } from "@yoma-desktop/kernel"
import { licenseRequiredInstant } from "./format"

/** 守护 `step` 事件里那一条 `license-paused`(形状按松散的 outcome 取)。 */
export interface BenchStepPause {
  state: string
  detail?: string
  expiresAt?: string
  notBefore?: string
}

export interface BenchLicensePause {
  /** 授权已经补好,只剩"点开始"这一步。 */
  resolved: boolean
  /** 拿来选那一句解释用的状态;读不出来时 undefined(那就一句都不说)。 */
  state?: string
  /** 要说的那个日期(到期日 / 生效日)的 UTC ISO。 */
  instant?: string
  note: "bench.license.note.restart" | "bench.license.note.autoResume"
  /** 守护给的原文,排查用。 */
  detail?: string
}

export interface BenchLicensePauseInput {
  status?: MailboxStatusView
  /** `start()` 直接被授权拦下那一次(main 的 status 也会说,但不保证先到)。 */
  startPause?: LicenseRequiredData
  stepPause?: BenchStepPause
  /** 本机当前的授权状态(共享 store),没读到时 undefined。 */
  licenseState?: LicenseState
}

const READY: readonly LicenseState[] = ["active", "not-required"]

export function selectBenchLicensePause(input: BenchLicensePauseInput): BenchLicensePause | undefined {
  const status = input.status
  const phase = status?.phase
  const running = phase === "running" || phase === "stopping"
  const ready = !!input.licenseState && READY.includes(input.licenseState)

  if (!running) {
    const carried = status?.license ?? status?.done?.license ?? input.startPause
    if (phase === "paused" || carried) {
      return {
        resolved: ready,
        state: carried?.state ?? input.licenseState,
        instant: carried ? licenseRequiredInstant(carried) : undefined,
        note: "bench.license.note.restart",
        detail: status?.done?.detail ?? status?.message,
      }
    }
  }

  const step = input.stepPause
  if (step && !ready) {
    return {
      resolved: false,
      state: step.state,
      instant: licenseRequiredInstant({
        state: step.state as LicenseRequiredData["state"],
        expiresAt: step.expiresAt,
        notBefore: step.notBefore,
      }),
      note: "bench.license.note.autoResume",
      detail: step.detail,
    }
  }
  return undefined
}
