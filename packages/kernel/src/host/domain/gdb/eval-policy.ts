/**
 * eval 闸门:一条普通 gdb 命令在交给 `-interpreter-exec console` 之前先分类。
 *
 * 三个实测的坑,任何一个都能让会话再也回不来:
 * - `pipe` / `shell` / `!` / 行首 `|` 把裸字节写到 gdb 的 stdout,绕开 MI 分帧(实测
 *   `pipe print 1+1 | cat` 产出了不在任何 record 里的 `$1 = 2`)。永久损坏。
 * - `-gdb-set <不认识的名字> = 值` 不报错,它当表达式**写目标内存**。
 * - `set logging redirect on` 把整条 MI 流偷进文件,驱动变聋而 gdb 一切正常。
 *
 * 运行控制类动词**转发**到 exec 而不是拒绝:模型会的是 gdb 不是这个工具,拒绝什么也没教会它,转发零成本。
 *
 * 写目标的动词要显式 write:true(那是确认门的钥匙,见工具契约)。这一层比阁楼版多认三样,都是实测能
 * 绕过去的:`load` / `flash-erase`(经 gdb server 改写 flash —— 和烧录一样贵,却不经过 flash 工具);
 * 藏在表达式里的赋值(`p x = 5`、`printf "%d", i++`、`display *p |= 1` 都是写内存,gdb 不区分"看"和"改");
 * 以及 `set {int}0x20000000 = 1` 这种按类型写内存的写法(阁楼版把它当"裸 set"一律拒了,而它是正经的内存写)。
 *
 * 纯函数、零依赖:第二刀的工具壳只消费判定,不在这里起任何东西。
 */

/** 转发给 exec 的运行控制动作;工具契约的 EXEC_OPS 必须是它的超集(工具的测试钉着)。 */
export const RUN_CONTROL_OPS = ["continue", "step", "next", "finish", "stepi", "interrupt"] as const
export type RunControlOp = (typeof RUN_CONTROL_OPS)[number]

export type EvalVerdict =
  | { kind: "blocked"; reason: string }
  | { kind: "reroute"; op: RunControlOp }
  | { kind: "mutating"; reason: string }
  | { kind: "read" }

/**
 * 会污染 MI 流、或接管会话的动词。`!` 与 `|` 单独匹配而不经 `\b`:它们本身不是单词字符,`| p 1+1` 里
 * `|` 与空格之间没有单词边界,套在 `\b` 里就漏了(写测试时抓到的)。
 */
const BLOCKED_RE =
  /^\s*(?:[!|]|(?:shell|pipe|python|py|python-interactive|pi|run|r|start|starti|attach|detach|target|file|exec-file|symbol-file|add-symbol-file|remove-symbol-file|core-file|quit|q|kill|source|define|document|compile|tui|layout)\b)/i
/** 工具自己拥有的设置。 */
const BLOCKED_SET_RE = /^\s*set\s+(logging|confirm|pagination|height|width|editing|mi-async|non-stop)\b/i
/**
 * 只影响显示的设置,放行:模型想把结构体打平、换反汇编风格、改进制,都不碰目标。
 * 白名单而不是"gdb 认识的都放":`set <未知名字> = 值` 真的会当表达式写内存,认识不认识只有 gdb 知道。
 */
const DISPLAY_SET_RE =
  /^\s*set\s+(print|listsize|disassembly-flavor|language|output-radix|input-radix|charset|style)\b/i
/** 断点表由 break 动作维护(硬件预算按它算),从这里下的断点它看不见。 */
const BREAKPOINT_RE = /^\s*(break|b|br|tbreak|hbreak|thbreak|watch|rwatch|awatch|delete|d|clear)\b/i
/** 会让目标跑起来、但 exec 没有对应动作的动词。 */
const RUN_CONTROL_RE = /^\s*(until|u|advance|ni|nexti|c|cont|continue|s|step|n|next|fin|finish|si|stepi|interrupt)\b/i
/** 写目标的动词。 */
const MUTATING_RE =
  /^\s*(set\s+var(iable)?\b|set\s+\$|set\s*\{|call|jump|return|restore|dprintf|signal|queue-signal|load|flash-erase|compare-sections\s+-w)/i
const MONITOR_RE = /^\s*monitor\b/i

const REROUTE: Record<string, RunControlOp> = {
  c: "continue",
  cont: "continue",
  continue: "continue",
  s: "step",
  step: "step",
  n: "next",
  next: "next",
  fin: "finish",
  finish: "finish",
  si: "stepi",
  stepi: "stepi",
  interrupt: "interrupt",
}

/**
 * 表达式里有没有藏着写:`=`(不是 `==` / `!=` / `<=` / `>=`)、复合赋值、`++` / `--`。
 * 字符串与字符字面量先剥掉:`printf "a=%d", x` 与 `p '='` 都不是写。
 * 这是纱窗不是墙:`call` 已经按动词拦了,这里拦的是模型顺手写的那种。
 */
export function expressionWrites(expression: string): boolean {
  const bare = expression.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")
  return /(^|[^=!<>+\-*/%&|^])=(?!=)|\+\+|--|[+\-*/%&|^]=|<<=|>>=/.test(bare)
}

/** 看着像函数调用、其实不是的:编译期运算符。`$_streq(...)` 这类 gdb 自带函数以 `$` 开头,另外放行。 */
const NOT_A_CALL = new Set(["sizeof", "_Alignof", "alignof", "__alignof__", "typeof", "__typeof__", "_Generic"])
/** `(uint32_t *)(addr)` 这种类型转换:括号里只有一个类型名(可带限定词和星号)。`(*fp)(1)` / `(s.cb)(1)` 不算。 */
const CAST_BODY = /^\s*(?:(?:const|volatile|struct|union|enum|unsigned|signed)\s+)*[A-Za-z_]\w*(?:\s+(?:const|volatile))*(?:\s*\*\s*(?:const|volatile)?)*\s*$/

/**
 * 表达式里有没有函数调用。gdb 求值时会**在目标上真的执行**那个函数(inferior call):
 * 函数卡住(等一个被调试器冻住的外设)整个 gdb 会话就跟着卡死,撞上断点则会留下一次"停止"、把选中帧挪走。
 * 监视列表每次停住都要重新求值,这种表达式绝不能进去。字符串与字符字面量先剥掉。
 */
export function expressionCalls(expression: string): boolean {
  const bare = expression.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")
  for (const match of bare.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]!
    if (name.startsWith("$") || NOT_A_CALL.has(name)) continue
    return true
  }
  // `)(` / `](`:经函数指针调用;但 `(T *)(x)` 是类型转换,不是调用。
  for (const match of bare.matchAll(/[)\]]\s*\(/g)) {
    const close = match.index!
    if (bare[close] === "]") return true
    let depth = 0
    let open = -1
    for (let i = close; i >= 0; i--) {
      if (bare[i] === ")") depth++
      else if (bare[i] === "(") {
        depth--
        if (depth === 0) {
          open = i
          break
        }
      }
    }
    if (open < 0 || !CAST_BODY.test(bare.slice(open + 1, close))) return true
  }
  return false
}

export function classifyEval(command: string): EvalVerdict {
  const trimmed = command.trim()
  if (trimmed === "") return { kind: "blocked", reason: "empty command" }
  if (/[\r\n]/.test(trimmed)) {
    return {
      kind: "blocked",
      reason: "one command per eval call — a newline inside the command would be sent to gdb verbatim.",
    }
  }

  const first = trimmed.split(/\s+/)[0]!.toLowerCase()
  const rerouted = REROUTE[first]
  if (rerouted) return { kind: "reroute", op: rerouted }

  if (BLOCKED_RE.test(trimmed)) {
    return {
      kind: "blocked",
      reason:
        "this command either writes raw bytes to gdb's stdout (shell/!/|/pipe/python) and permanently corrupts the MI stream, or takes over the session (run/start/attach/detach/target/file/source/define/quit/kill). Use gdb exec for run control and gdb stop to end the session.",
    }
  }
  if (RUN_CONTROL_RE.test(trimmed)) {
    return {
      kind: "blocked",
      reason:
        "this resumes the target outside the tool's state machine — use gdb exec (continue/step/next/finish/stepi, with count for repeats).",
    }
  }
  if (BREAKPOINT_RE.test(trimmed)) {
    return {
      kind: "blocked",
      reason:
        "breakpoints and watchpoints go through gdb break (at / watch / remove): it tracks the hardware unit budget and refuses at insert time instead of failing on the next continue.",
    }
  }
  if (BLOCKED_SET_RE.test(trimmed)) {
    return {
      kind: "blocked",
      reason:
        "this setting is owned by the tool (logging/confirm/pagination/height/width/editing/mi-async/non-stop); changing it breaks the driver.",
    }
  }
  if (DISPLAY_SET_RE.test(trimmed)) return { kind: "read" }
  if (MUTATING_RE.test(trimmed) || MONITOR_RE.test(trimmed)) {
    return {
      kind: "mutating",
      reason: `\`${first}\` changes the target (memory, registers, flash or the running state). Re-send with write: true if that is what you mean.`,
    }
  }
  // 裸 `set foo = 1`:gdb 认不出的设置名会被当表达式,静默写目标内存。
  if (/^\s*set\s+/i.test(trimmed)) {
    return {
      kind: "blocked",
      reason:
        "a bare `set <name>` that gdb does not recognise as a setting is parsed as an EXPRESSION and silently writes target memory. Write `set variable X = Y` (with write: true) for a memory write, or use `-gdb-show <name>` to check a setting name first.",
    }
  }
  if (expressionWrites(trimmed.slice(first.length))) {
    return {
      kind: "mutating",
      reason:
        "the expression contains an assignment or ++/-- — gdb evaluates it by WRITING the target (`p x = 5` stores 5 into x). Re-send with write: true if that is what you mean, or drop the assignment to just read.",
    }
  }
  return { kind: "read" }
}
