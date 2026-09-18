import { describe, expect, test } from "vitest"
import {
  classifyLogLine,
  filterLogLines,
  isLogFileName,
  pickNewestLogFile,
  tailLines,
  toLogLines,
} from "./log-lines"

describe("pickNewestLogFile", () => {
  test("名字里的时间戳决定新旧(file.list 没有 mtime)", () => {
    const entries = [
      { name: "hw-20260918-090000000.log", type: "file" },
      { name: "hw-20260918-101112345.log", type: "file" },
      { name: "hw-20260917-235959999.log", type: "file" },
    ]
    expect(pickNewestLogFile(entries)).toBe("hw-20260918-101112345.log")
  })

  test("只认 hw-*.log,目录与别的文件一概不要", () => {
    expect(pickNewestLogFile([{ name: "notes.txt", type: "file" }, { name: "hw-old", type: "directory" }])).toBeUndefined()
    expect(isLogFileName("hw-20260918-101112345.log")).toBe(true)
    expect(isLogFileName("build.log")).toBe(false)
  })

  test("一个都没有时是 undefined,不是抛", () => {
    expect(pickNewestLogFile([])).toBeUndefined()
  })
})

describe("tailLines", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")

  test("只留尾部若干行", () => {
    expect(tailLines(lines(10), { maxLines: 3 })).toEqual(["line 8", "line 9", "line 10"])
  })

  test("末尾的换行不算成一行空行", () => {
    expect(tailLines("a\nb\n", { maxLines: 10 })).toEqual(["a", "b"])
  })

  test("\\r\\n 与裸 \\r 都切得开", () => {
    expect(tailLines("a\r\nb\rc", { maxLines: 10 })).toEqual(["a", "b", "c"])
  })

  test("truncated 时丢掉被字节切断的最后半行", () => {
    expect(tailLines("aaa\nbbb\nccc-half", { maxLines: 10, dropLastPartial: true })).toEqual(["aaa", "bbb"])
  })

  test("字节上限在行数上限之内再砍一刀(单行几十 KB 的喷吐)", () => {
    const fat = ["x".repeat(100), "y".repeat(100), "z".repeat(100)].join("\n")
    expect(tailLines(fat, { maxLines: 10, maxBytes: 210 })).toEqual(["y".repeat(100), "z".repeat(100)])
  })

  test("空内容是空数组", () => {
    expect(tailLines("", {})).toEqual([])
  })

  test("**最后一行自己就超预算时也要留着** —— 不然整屏空白,看着像面板坏了", () => {
    const fat = "x".repeat(300)
    expect(tailLines(fat, { maxLines: 10, maxBytes: 100 })).toEqual([fat])
    expect(tailLines(["aa", "bb", fat].join("\n"), { maxLines: 10, maxBytes: 100 })).toEqual([fat])
  })
})

describe("classifyLogLine", () => {
  test("ESP-IDF 的 E/W/I/D (ms)", () => {
    expect(classifyLogLine("E (1234) wifi: connect failed")).toBe("error")
    expect(classifyLogLine("W (12) app: retrying")).toBe("warn")
    expect(classifyLogLine("I (12) app: ready")).toBe("info")
    expect(classifyLogLine("D (12) app: tick")).toBe("debug")
  })

  test("方括号与尖括号(Zephyr)", () => {
    expect(classifyLogLine("[ERR] uart: overrun")).toBe("error")
    expect(classifyLogLine("[WRN] adc: clipped")).toBe("warn")
    expect(classifyLogLine("[INF] boot ok")).toBe("info")
    expect(classifyLogLine("[00:00:01.234] <err> os: fault")).toBe("error")
    expect(classifyLogLine("[00:00:01.234] <dbg> os: idle")).toBe("debug")
  })

  test("行首裸词", () => {
    expect(classifyLogLine("ERROR: i2c nack")).toBe("error")
    expect(classifyLogLine("FATAL watchdog")).toBe("error")
    expect(classifyLogLine("warn - low battery")).toBe("warn")
  })

  test("没有级别标记时,Cortex-M 的事故词自己就是级别", () => {
    expect(classifyLogLine("*** HardFault ***")).toBe("error")
    expect(classifyLogLine("ASSERT failed at main.c:200")).toBe("error")
    expect(classifyLogLine("Stack overflow in task blink")).toBe("error")
    expect(classifyLogLine("assert_failed(file, line)")).toBe("error")
  })

  test("带 info 前缀的事故词不算错误 —— 否则「装好了 HardFault 处理器」会一直红着", () => {
    expect(classifyLogLine("I (12) app: HardFault handler installed")).toBe("info")
    expect(classifyLogLine("[DBG] panic hook registered")).toBe("debug")
  })

  test("时间戳紧贴级别括号时也认(`[12:00:00][E] …`,中间没有空格)", () => {
    expect(classifyLogLine("[12:00:00.000][E] boot fail")).toBe("error")
    expect(classifyLogLine("<12:00:00><wrn> adc")).toBe("warn")
  })

  test("panic / ASSERT 要站在行首那一段 —— `no panic detected` 是好消息", () => {
    expect(classifyLogLine("no panic detected")).toBe("info")
    expect(classifyLogLine("*** PANIC: null deref")).toBe("error")
    expect(classifyLogLine("ASSERT failed at main.c:200")).toBe("error")
  })

  test("认不出来的行是 info,不涂色", () => {
    expect(classifyLogLine("0x20000010: de ad be ef")).toBe("info")
    expect(classifyLogLine("")).toBe("info")
  })
})

describe("toLogLines / filterLogLines", () => {
  test("行号从 1 起,按本窗口算", () => {
    expect(toLogLines(["a", "E (1) b"])).toEqual([
      { no: 1, text: "a", level: "info" },
      { no: 2, text: "E (1) b", level: "error" },
    ])
  })

  test("过滤是大小写不敏感的子串;空串不过滤", () => {
    const lines = toLogLines(["Alpha", "beta", "GAMMA"])
    expect(filterLogLines(lines, "a").length).toBe(3)
    expect(filterLogLines(lines, "BET").map((line) => line.text)).toEqual(["beta"])
    expect(filterLogLines(lines, "   ").length).toBe(3)
  })
})
