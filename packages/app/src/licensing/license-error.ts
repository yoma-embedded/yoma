/**
 * 从一个 rejection 里认出"这是授权问题"。
 *
 * 两条路都要看:`KernelError` 把结构化信息放在 `error.data`,同时也塞进
 * `cause.body`(前端 `unwrapNamedError()` 认的形状)。只认一条的代价是同一个错误在
 * 两个调用点上一个认得出、一个报"内核出错"。
 */

import { isLicenseImportErrorData, isLicenseRequiredData } from "@yoma-desktop/kernel"
import type {
  LicenseImportErrorData,
  LicenseRequiredData,
  LicensedExecutionKind,
  LicenseStatusView,
} from "@yoma-desktop/kernel"

function candidates(error: unknown): unknown[] {
  if (!error || typeof error !== "object") return []
  const out: unknown[] = []
  const data = (error as { data?: unknown }).data
  if (data) out.push(data)
  const cause = (error as { cause?: unknown }).cause
  if (cause && typeof cause === "object") {
    const body = (cause as { body?: unknown }).body
    if (body) out.push(body)
  }
  // 错误本身就是那个普通对象的情况(preload 把 Error 剥成 `{message, stack, data}` 之后
  // 有的调用点会把 data 再往上抛)。
  out.push(error)
  return out
}

/** 执行被拦下了吗。是的话给出内核的结构化原因。 */
export function licenseRequiredFrom(error: unknown): LicenseRequiredData | undefined {
  for (const candidate of candidates(error)) if (isLicenseRequiredData(candidate)) return candidate
  return undefined
}

/** 导入被拒了吗。是的话给出 code。 */
export function licenseImportErrorFrom(error: unknown): LicenseImportErrorData | undefined {
  for (const candidate of candidates(error)) if (isLicenseImportErrorData(candidate)) return candidate
  return undefined
}

/** 状态 → "会被内核以什么理由拒"。不强制 / 有效 = undefined(不会被拒)。 */
export function licenseRequiredFromStatus(
  status: LicenseStatusView,
  execution: LicensedExecutionKind,
): LicenseRequiredData | undefined {
  if (!status.enforced || status.state === "active" || status.state === "not-required") return undefined
  return {
    _tag: "LicenseRequiredError",
    state: status.state,
    execution,
    notBefore: status.license?.notBefore,
    expiresAt: status.license?.expiresAt,
  }
}
