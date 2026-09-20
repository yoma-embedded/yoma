import { describe, expect, test } from "vitest"
import { licenseImportErrorFrom, licenseRequiredFrom } from "./license-error"

/**
 * `KernelError` 把结构化信息同时放在 `error.data` 与 `cause.body`(前端 `unwrapNamedError()`
 * 认的那一条)。两条路都要认得出 —— 只认一条的代价是同一个错误在两个调用点上一个认得出、
 * 一个报"内核出错"。
 */
const required = { _tag: "LicenseRequiredError", state: "expired", execution: "session.prompt" }

describe("从 rejection 里认出授权问题", () => {
  test("走 error.data", () => {
    const error = Object.assign(new Error("x"), { data: required })
    expect(licenseRequiredFrom(error)).toEqual(required)
  })

  test("走 cause.body", () => {
    const error = new Error("x", { cause: { body: required, status: 404 } })
    expect(licenseRequiredFrom(error)).toEqual(required)
  })

  test("错误本身就是那个普通对象(过了 contextBridge 之后的形状)", () => {
    expect(licenseRequiredFrom(required)).toEqual(required)
  })

  test("别的错误一律不认 —— 认错了就会把真报错藏起来", () => {
    expect(licenseRequiredFrom(new Error("boom"))).toBeUndefined()
    expect(licenseRequiredFrom(Object.assign(new Error("x"), { data: { _tag: "SessionNotFoundError" } }))).toBeUndefined()
    expect(licenseRequiredFrom(undefined)).toBeUndefined()
    expect(licenseRequiredFrom("string")).toBeUndefined()
    expect(licenseRequiredFrom(null)).toBeUndefined()
  })

  test("导入被拒带着 code", () => {
    const data = { _tag: "LicenseImportError", code: "bad-signature" }
    expect(licenseImportErrorFrom(Object.assign(new Error("签名对不上"), { data }))?.code).toBe("bad-signature")
    expect(licenseImportErrorFrom(new Error("x", { cause: { body: data } }))?.code).toBe("bad-signature")
    expect(licenseImportErrorFrom(new Error("普通失败"))).toBeUndefined()
    // 两类错误不能互相冒充。
    expect(licenseImportErrorFrom(required)).toBeUndefined()
    expect(licenseRequiredFrom(data)).toBeUndefined()
  })
})
