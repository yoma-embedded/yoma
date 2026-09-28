/**
 * netlist 的 `query`:从 controller_map 的原始逐 pin 图里挑出和一个信号 / 引脚 / 元件有关的那几个脚,渲染成几行人话。
 *
 * 为什么要有它(2026-09-28 一次真会话):调试时要问的是"VBUS 分压接在主控哪个脚""R68 的另一头是什么",而原始图是
 * 40 KB 的 JSON、截到 10 000 字符,主控的大半个引脚都在截断线之后 —— 模型于是改用 grep / sed 翻 .NET 文件。grep
 * 只看得见同一个网络上的直连元件,看不见"隔着一颗串联电阻到了哪里",这正是 controller_map 已经追好的东西。
 *
 * 纯函数、不碰文件:session.ts 把引擎的 stdout 解析好交进来。输出是确定的(按引脚在图里的顺序、按首次出现分组),
 * 同一份网表同一个 query 永远是同一段字。
 */

export interface MapNode {
  ref?: string
  pin?: string
  pin_name?: string
  value?: string
}

export interface MapVia {
  ref?: string
  value?: string
  pin_in?: string
  pin_out?: string
  kind?: string
  dnf?: boolean
}

export interface MapTrace {
  via?: MapVia[]
  endpoint?: MapNode | null
  rail?: string | null
  dnf?: boolean
}

export interface MapPin {
  pin?: string
  pin_name?: string
  net?: string
  direct_nodes?: MapNode[]
  traced?: MapTrace[]
}

/** controller_map 的 stdout(只列这里用到的字段)。 */
export interface ControllerMap {
  controller?: { ref?: string; part?: string; pin_count?: number }
  low_confidence?: boolean
  signal_pins?: MapPin[]
}

/** 一条追踪链上最多列几个终点;电源网络后面往往挂着几十颗 MOSFET 与电容,全列出来就是另一份 40 KB。 */
export const MAX_ENDPOINTS_PER_CHAIN = 4
/** 命中的引脚渲染到这么长就停(query 写成 "GND" 这类宽词时),其余只报个数。 */
export const MAX_QUERY_CHARS = 8_000
/** 没命中时列出的网络名上限。 */
const MAX_NET_NAMES = 80

/** 逗号分隔的多个词,取并集。 */
export function queryTerms(query: string): string[] {
  return query
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean)
}

const lower = (text: string | undefined | null) => (text ?? "").toLowerCase()
/** 去掉空格与标点再比:"PA0-BUSV"、"PA0 BUSV" 都该找到网络 "PA0 - BUSV"。 */
const squash = (text: string | undefined | null) => lower(text).replace(/[^\p{L}\p{N}]+/gu, "")

function refsOf(pin: MapPin): string[] {
  const refs: string[] = []
  for (const node of pin.direct_nodes ?? []) if (node.ref) refs.push(node.ref)
  for (const trace of pin.traced ?? []) {
    for (const via of trace.via ?? []) if (via.ref) refs.push(via.ref)
    if (trace.endpoint?.ref) refs.push(trace.endpoint.ref)
  }
  return refs
}

function valuesOf(pin: MapPin): string[] {
  const values: string[] = []
  for (const node of pin.direct_nodes ?? []) if (node.value) values.push(node.value)
  for (const trace of pin.traced ?? []) {
    for (const via of trace.via ?? []) if (via.value) values.push(via.value)
    if (trace.endpoint?.value) values.push(trace.endpoint.value)
    if (trace.rail) values.push(trace.rail)
  }
  return values
}

/**
 * 一个脚是否和一个词有关(不分大小写):词就是脚号 / 脚名;词是这个脚上某颗元件的位号(直连、串联、终点);
 * 网络名里含这个词;词至少 3 个字符时,元件值或电源轨里含这个词。最后一条设下限,是因为 "1"、"10" 这种短词会
 * 撞上半张图的 "10k" "0.1uF"。
 */
export function pinMatches(pin: MapPin, term: string): boolean {
  const want = lower(term)
  if (!want) return false
  if (want === lower(pin.pin) || want === lower(pin.pin_name)) return true
  // 纯数字就是在问脚号:自动生成的网络名带着主控位号("NetU8_4"),按子串比的话问 "8" 会捞出一串无关的脚(真板实测)。
  if (/^\d+$/.test(want)) return false
  if (refsOf(pin).some((ref) => lower(ref) === want)) return true
  if (lower(pin.net).includes(want)) return true
  const squashed = squash(term)
  if (squashed && squash(pin.net).includes(squashed)) return true
  if (want.length >= 3 && valuesOf(pin).some((value) => lower(value).includes(want))) return true
  return false
}

function nodeLabel(node: MapNode): string {
  const pin = node.pin ?? ""
  const name = node.pin_name && node.pin_name !== pin ? `/${node.pin_name}` : ""
  const where = node.ref ? `${node.ref}${pin ? `.${pin}` : ""}${name}` : "?"
  return node.value ? `${where} ${node.value}` : where
}

function viaLabel(via: MapVia): string {
  const text = [via.ref, via.value].filter(Boolean).join(" ") || "?"
  return via.dnf ? `${text} (DNF)` : text
}

/** traced 按串联链分组(按首次出现的顺序),同一条链上的终点去重、封顶。 */
function renderTraced(traced: MapTrace[]): string {
  const groups = new Map<string, string[]>()
  for (const trace of traced) {
    const chain = (trace.via ?? []).map(viaLabel).join(" → ")
    const target = trace.rail ?? (trace.endpoint ? nodeLabel(trace.endpoint) : undefined)
    if (!target) continue
    const shown = trace.dnf ? `${target} [DNF path]` : target
    const list = groups.get(chain) ?? []
    if (!list.includes(shown)) list.push(shown)
    groups.set(chain, list)
  }
  const parts: string[] = []
  for (const [chain, targets] of groups) {
    const head = targets.slice(0, MAX_ENDPOINTS_PER_CHAIN).join(", ")
    const more = targets.length > MAX_ENDPOINTS_PER_CHAIN ? ` (+${targets.length - MAX_ENDPOINTS_PER_CHAIN} more)` : ""
    parts.push(chain ? `via ${chain} → ${head}${more}` : `${head}${more}`)
  }
  return parts.join(" | ")
}

export function renderPin(pin: MapPin): string {
  const name = pin.pin_name && pin.pin_name !== pin.pin ? ` (${pin.pin_name})` : ""
  const net = pin.net ? `net "${pin.net}"` : "no net"
  const lines = [`pin ${pin.pin ?? "?"}${name}  ${net}`]
  const direct = (pin.direct_nodes ?? []).map(nodeLabel)
  if (direct.length > 0) lines.push(`  direct: ${direct.join(", ")}`)
  const traced = renderTraced(pin.traced ?? [])
  if (traced) lines.push(`  traced: ${traced}`)
  return lines.join("\n")
}

function controllerLabel(map: ControllerMap): string {
  const ref = map.controller?.ref || "the controller"
  return map.controller?.part ? `${ref} (${map.controller.part})` : ref
}

/**
 * 按 query 渲染命中的脚。没命中时不吐 JSON,而是列出主控各脚的网络名,让模型换个词再问。
 * 脚名全是数字时(OrCAD PCB II / 多数 Altium 导出不带脚名)补一句:这是封装脚号,不是端口名 —— 要映射到 PA0 这类
 * 名字得查芯片数据手册的引脚表,否则模型会把"8 号脚"当成"通道 8"。
 */
export function renderPinQuery(map: ControllerMap, query: string): string {
  const terms = queryTerms(query)
  const pins = map.signal_pins ?? []
  const who = controllerLabel(map)
  const matched = pins.filter((pin) => terms.some((term) => pinMatches(pin, term)))
  if (matched.length === 0) {
    const nets = [...new Set(pins.map((pin) => pin.net).filter((net): net is string => !!net))]
    const shown = nets.slice(0, MAX_NET_NAMES).map((net) => `"${net}"`)
    const more = nets.length > shown.length ? `, … (+${nets.length - shown.length} more)` : ""
    return (
      `no pin on ${who} matches "${query}" (searched pin numbers/names, net names, component refs and values).\n` +
      (nets.length > 0 ? `Nets on ${who}'s pins: ${shown.join(", ")}${more}` : `${who} has no signal pins in this map.`)
    )
  }

  const blocks: string[] = []
  let used = 0
  for (const pin of matched) {
    const block = renderPin(pin)
    if (blocks.length > 0 && used + block.length > MAX_QUERY_CHARS) break
    blocks.push(block)
    used += block.length + 1
  }
  const lines = [`${matched.length} of ${pins.length} pins on ${who} match "${query}":`, ...blocks]
  if (blocks.length < matched.length) {
    lines.push(`… ${matched.length - blocks.length} more matching pins not shown — narrow the query.`)
  }
  if (matched.every((pin) => /^\d+$/.test(pin.pin_name || pin.pin || ""))) {
    lines.push(
      "Pin names here are package pin numbers, not port names: map them to ports (e.g. PA0) with the chip's pinout table (datasheet tool) or stm32config describe-mcu.",
    )
  }
  return lines.join("\n")
}
