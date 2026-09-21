/**
 * 调试台这一侧的授权闸门:**在安全的轮次边界停住**,而不是让它长得像崩溃或业务失败。
 *
 * 检查规则一行都不在这里 —— 那只有一份,在内核的 `LicenseService`(同一份验签、同一份
 * 编译期策略、每次重新读盘)。这个文件只回答三个调试台特有的问题:
 *
 * 1. **哪一刻问。** 守护每一步在"确定这一步要开始一轮付费执行"之后、**任何副作用之前**问一次:
 *    工位端在 staging 附件与起 turn 子进程之前,研发端在建工作分支与分析之前。空转、终局、
 *    挂起等人、终局收尾(交付与保存证据)一律不问 —— 停止、取消、释放设备、留下证据永远可用。
 * 2. **停住长什么样。** `license-paused` 这一步。它不是 `blocked`(那是"远端推不上去"那类故障,
 *    守护对它指数退避),也不是业务成功/失败:**什么都不写** —— 不写 result.json、不写 decision、
 *    不提交、不推。信箱状态原样留着,导入有效授权后下一次轮询自己接着跑,不需要重启守护。
 * 3. **注入口在哪。** 只有代码级的 `license?: LicenseService`(host.ts / cli.ts 逐字段构造 options
 *    时传)。**不从 JSON 配置、命令行、环境变量取值** —— `TurnInput` 与 `MailboxHostConfig` 里
 *    没有任何授权字段(license.test.ts 按源码扫着这一条),拿到正式安装包的人因此够不着它。
 */

import type { LicenseRequiredData } from "@yoma-desktop/kernel"
import { LicenseService } from "@yoma-desktop/kernel/host"

/**
 * 守护因为授权在轮次边界停住的那一步。两个角色的 outcome 联合里各有一个这个分支,
 * 形状与 `kernel/src/mailbox-view.ts` 的 step 契约对齐(`state` / `detail` / `round` /
 * `expiresAt` / `notBefore` 都在那份松散形状里)。
 */
export interface LicensePausedOutcome {
  kind: "license-paused"
  /** `missing` / `expired` / `not-yet-valid` / `invalid`。 */
  state: LicenseRequiredData["state"]
  /** 给人看的一句话:为什么停、停在哪、状态还在、怎么恢复。 */
  detail: string
  /** 停在哪一轮的边界(研发端的开局轮是 0)。 */
  round?: number
  notBefore?: string
  expiresAt?: string
}

/** 两个角色的 options 里那两个字段。`license` 是**代码级**注入口,`configDir` 是授权文件所在目录。 */
export interface BenchLicenseOptions {
  license?: LicenseService
  configDir?: string
}

/**
 * 这一步该问的那个服务。不传 `license` 就现建一个 —— 走**编译期策略**
 * (`buildLicensePolicy()`),没有注入的开发态因此完全不受影响。
 *
 * 每步现建一个不是浪费:`status()` 本来就每次重新读盘(那正是"另一个进程导入了续费授权,
 * 这边下一次轮询就看得见"的全部机制),服务对象自己不缓存任何东西。
 */
export function benchLicense(options: BenchLicenseOptions): LicenseService {
  return options.license ?? new LicenseService({ configDir: options.configDir })
}

/** 一轮付费执行的闸门:能跑返回 undefined,不能跑返回那一步(调用方**直接返回它,什么都别写**)。 */
export function licenseGateForTurn(options: BenchLicenseOptions, round?: number): LicensePausedOutcome | undefined {
  const check = benchLicense(options).check("bench.turn")
  return check.ok ? undefined : licensePausedFrom(check.data, round)
}

/**
 * 把内核的拒绝理由变成"暂停"这一步。
 *
 * 也用在**竞态兜底**上:守护这边检查通过、而轮次子进程那边恰好过期时,子进程的
 * `TurnResult.licenseBlocked` 会带着同一份 data 回来,按同一条路处理 —— 不回填失败结果。
 */
export function licensePausedFrom(data: LicenseRequiredData, round?: number): LicensePausedOutcome {
  return {
    kind: "license-paused",
    state: data.state,
    detail: licensePausedDetail(data.state, round),
    round,
    notBefore: data.notBefore,
    expiresAt: data.expiresAt,
  }
}

/** 从暂停这一步还原跨进程的结构化数据(守护 stdout 的 `done` 事件要带它,界面据此出"去激活"入口)。 */
export function licenseDataOfPaused(outcome: LicensePausedOutcome): LicenseRequiredData {
  return {
    _tag: "LicenseRequiredError",
    state: outcome.state,
    execution: "bench.turn",
    notBefore: outcome.notBefore,
    expiresAt: outcome.expiresAt,
  }
}

const STATE_TEXT: Record<LicenseRequiredData["state"], string> = {
  missing: "软件尚未激活(本机没有授权文件)",
  expired: "软件授权已到期",
  "not-yet-valid": "软件授权还没到生效时间",
  invalid: "授权文件无效",
}

/**
 * 暂停的话术。三件事必须说全:**为什么**(到期 / 未激活 / …)、**停在哪**(第几轮的边界,
 * 状态都留着)、**怎么恢复**(导入授权后自己继续)。少了最后一句,用户看到的就是一个
 * 卡住的任务,而唯一的自救动作没人告诉他。
 */
export function licensePausedDetail(state: LicenseRequiredData["state"], round?: number): string {
  const where =
    round === undefined ? "任务已在轮次边界暂停" : round <= 0 ? "任务已在开局轮边界暂停" : `任务已在第 ${round} 轮边界暂停`
  return `${STATE_TEXT[state]}:${where},状态已保留(这一步没有写入任何结果)。在桌面端「设置 → 授权」导入有效授权后自动继续,不必重启守护。`
}

export interface LicenseStartRefusal {
  detail: string
  license: LicenseRequiredData
}

/**
 * 守护**启动**时的那一次检查(`mailbox.start`)。不满足就拒绝启动:不抢单实例锁、不碰信箱、
 * 不碰板子,退出码 4(不是崩溃,宿主不该把它当失败去自动重启)。
 *
 * 看状态的命令(`status` / `ack` / `check`)不走这里 —— 查看与回执始终可用。
 */
export function licenseGateForStart(options: BenchLicenseOptions): LicenseStartRefusal | undefined {
  const check = benchLicense(options).check("mailbox.start")
  if (check.ok) return undefined
  return {
    detail: `调试台守护没有启动:${check.message}(信箱、板子与本地状态一个字都没碰)`,
    license: check.data,
  }
}
