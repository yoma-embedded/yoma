/**
 * 模型把参数写错时,它看到的那句话。
 *
 * 校验本身在发动机里(pi-ai `validateToolArguments`,vendored,不改),原话是 ajv 风格的
 * "action: must be equal to constant" ×N,不列合法值 —— 2026-09-17 真机验证里 agent 就照着这句原样又调了一次
 * 不存在的 `scope timing`。发动机给每个工具留了 `prepareArguments`,在校验**之前**跑(pi 自己的 edit 工具用它把
 * 单个对象或 JSON 字符串归一成数组)。这里挂的是硬件工具共用的一层:先跑工具自己的归一,再按契约预校验,失败就
 * 抛出指名字段、允许值和实收值的错误,这个错误原样成为模型看到的工具结果;通过就把转换后的参数交回去,发动机
 * 再校验一遍是幂等的。
 *
 * 预校验必须和发动机同一套规矩(可选字段收到 null 当没给、`Value.Convert` 的类型转换),否则这里比发动机严,
 * 会拒绝它本来收的东西。
 */
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"
import type { Static, TSchema } from "typebox"
import { Compile } from "typebox/compile"
import { Value } from "typebox/value"

type JsonSchema = Record<string, unknown>

const validators = new WeakMap<object, ReturnType<typeof Compile>>()

function validatorFor(schema: TSchema): ReturnType<typeof Compile> {
  let validator = validators.get(schema)
  if (!validator) {
    validator = Compile(schema)
    validators.set(schema, validator)
  }
  return validator
}

/** 与发动机同一条规矩:可选字段收到 null、且 null 不是它的合法值时,当作没给。 */
function dropOptionalNulls(value: unknown, schema: JsonSchema): void {
  if (Array.isArray(value)) {
    const items = schema.items
    if (items && !Array.isArray(items)) for (const item of value) dropOptionalNulls(item, items as JsonSchema)
    return
  }
  if (!value || typeof value !== "object" || !schema.properties) return
  const object = value as Record<string, unknown>
  const required = new Set((schema.required as string[] | undefined) ?? [])
  for (const [key, sub] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
    if (!(key in object)) continue
    if (object[key] === null && !required.has(key) && !Value.Check(sub as TSchema, null)) delete object[key]
    else dropOptionalNulls(object[key], sub)
  }
}

function valueAt(root: unknown, path: string[]): unknown {
  let value = root
  for (const segment of path) {
    if (value === null || typeof value !== "object") return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

/** anyOf 节点按实收值的形状挑分支(对象走对象分支);挑不到就原样返回,让 describe 把分支全列出来。 */
function resolveBranch(node: JsonSchema, value: unknown): JsonSchema {
  const branches = node.anyOf as JsonSchema[] | undefined
  if (!branches) return node
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value
  return branches.find((b) => b.type === kind || (kind === "number" && b.type === "integer")) ?? node
}

/** 沿实例路径走到出错处的子 schema。 */
function schemaAt(schema: JsonSchema, path: string[], value: unknown): JsonSchema | undefined {
  let node: JsonSchema | undefined = schema
  let current = value
  for (const segment of path) {
    node = resolveBranch(node, current)
    const properties = node.properties as Record<string, JsonSchema> | undefined
    if (properties && segment in properties) node = properties[segment]
    else if (node.items && !Array.isArray(node.items)) node = node.items as JsonSchema
    else if (Array.isArray(node.items)) node = (node.items as JsonSchema[])[Number(segment)]
    else if (node.additionalProperties && typeof node.additionalProperties === "object")
      node = node.additionalProperties as JsonSchema
    else return undefined
    if (!node) return undefined
    current =
      current !== null && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined
  }
  return node
}

function list(values: unknown[]): string {
  return values.map((v) => JSON.stringify(v)).join(", ")
}

/** 一句话说清一个 schema 要什么:字面量、枚举、带范围的数、带字段名的对象。 */
function brief(sub: JsonSchema): string {
  if ("const" in sub) return JSON.stringify(sub.const)
  if (Array.isArray(sub.enum)) return `one of ${list(sub.enum)}`
  const branches = sub.anyOf as JsonSchema[] | undefined
  if (branches) return branches.map(brief).join(" | ")
  const type = Array.isArray(sub.type) ? sub.type.join("/") : String(sub.type ?? "value")
  if (type === "object" && sub.properties) {
    const required = new Set((sub.required as string[] | undefined) ?? [])
    const keys = Object.keys(sub.properties as object).map((k) => (required.has(k) ? k : `${k}?`))
    return `object {${keys.join(", ")}}`
  }
  if (type === "array")
    return `array of ${sub.items && !Array.isArray(sub.items) ? brief(sub.items as JsonSchema) : "items"}`
  if (type === "integer" || type === "number") {
    const bounds: string[] = []
    if (typeof sub.minimum === "number") bounds.push(`>= ${sub.minimum}`)
    if (typeof sub.exclusiveMinimum === "number") bounds.push(`> ${sub.exclusiveMinimum}`)
    if (typeof sub.maximum === "number") bounds.push(`<= ${sub.maximum}`)
    if (typeof sub.exclusiveMaximum === "number") bounds.push(`< ${sub.exclusiveMaximum}`)
    if (typeof sub.minimum === "number" && typeof sub.maximum === "number")
      return `${type} ${sub.minimum}..${sub.maximum}`
    return bounds.length ? `${type} ${bounds.join(" and ")}` : type
  }
  if (type === "string" && typeof sub.pattern === "string") return `string matching ${sub.pattern}`
  return type
}

function describe(sub: JsonSchema): string {
  if ("const" in sub) return `must be ${JSON.stringify(sub.const)}`
  if (Array.isArray(sub.enum)) return `must be one of ${list(sub.enum)}`
  const branches = sub.anyOf as JsonSchema[] | undefined
  if (branches && branches.every((b) => "const" in b)) return `must be one of ${list(branches.map((b) => b.const))}`
  if (branches) return `must be one of: ${branches.map(brief).join(" | ")}`
  return `must be ${brief(sub)}`
}

function short(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

interface ValidationError {
  keyword?: string
  instancePath: string
  message?: string
  params?: { requiredProperties?: string[] }
}

/**
 * 给一份契约做 `prepareArguments`:先跑 `normalize`(工具自己的写法归一),再按发动机同款的规矩预校验。
 * 通过返回转换后的参数;不通过抛出列明字段、期望与实收值的错误。
 */
export function friendlyArguments<T extends TSchema>(
  name: string,
  schema: T,
  normalize?: (args: unknown) => unknown,
): (args: unknown) => Static<T> {
  return (raw) => {
    const value = structuredClone(normalize ? normalize(raw) : raw)
    dropOptionalNulls(value, schema as JsonSchema)
    const converted = Value.Convert(schema, value)
    const validator = validatorFor(schema)
    if (validator.Check(converted)) return converted as Static<T>
    const lines = new Map<string, string>()
    for (const error of Array.from(validator.Errors(converted)) as ValidationError[]) {
      const segments = error.instancePath.split("/").filter(Boolean)
      const required = error.keyword === "required" ? error.params?.requiredProperties?.[0] : undefined
      if (required) segments.push(required)
      const key = segments.join(".") || "arguments"
      if (lines.has(key)) continue
      const got = required ? undefined : valueAt(converted, segments)
      const sub = required ? undefined : schemaAt(schema as JsonSchema, segments, converted)
      const expectation = required ? "is required" : sub ? describe(sub) : (error.message ?? "is invalid")
      lines.set(key, `${key}: ${expectation}${got === undefined ? "" : ` (got ${short(JSON.stringify(got))})`}`)
    }
    // 联合节点自己的那行(列全部分支)在它下面有更具体的一行时是噪音:channels.0.ch 越界比"channels.0 得是数字或对象"更准
    const keys = [...lines.keys()]
    const specific = keys.filter((key) => !keys.some((other) => other !== key && other.startsWith(`${key}.`)))
    throw new Error(`${name}: invalid arguments\n${specific.map((key) => `  - ${lines.get(key)}`).join("\n")}`)
  }
}

/** 给装配面上的一个工具挂上这一层;工具自带的 prepareArguments 成为归一步骤。 */
export function withFriendlyArguments<T extends AgentHarnessTool<ExecutionToolContext>>(tool: T): T {
  return { ...tool, prepareArguments: friendlyArguments(tool.name, tool.parameters, tool.prepareArguments) }
}
