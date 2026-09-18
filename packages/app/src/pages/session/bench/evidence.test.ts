/**
 * 「有我还没看过的新证据」的那几条纯函数与那一份落盘状态。
 *
 * 这一族全是**错了不会报错**的东西:指纹算错只是提示点该亮时不亮(或者永远亮着),
 * seen 的键写错只是每换一次会话就凭空亮一排点 —— 界面上看不出是 bug,所以它们值得有断言。
 */
import { beforeEach, describe, expect, test } from "vitest"
import { EMPTY_BENCH_STATUS, type BenchStatus, type GdbStatus, type InstrumentId } from "./bench-status"
import { EMPTY_BENCH_DISK, type BenchDisk, type InstrumentContext } from "./instruments"
import {
  BENCH_SEEN_KEY,
  benchSeen,
  hasEvidence,
  hasUnseen,
  instrumentSignature,
  markSeen,
  parseSeen,
  seenKey,
  unseenInstruments,
} from "./evidence"

function ctx(
  input: { status?: Partial<BenchStatus>; disk?: Partial<BenchDisk>; pinned?: InstrumentId[] } = {},
): InstrumentContext {
  return {
    status: { ...EMPTY_BENCH_STATUS, ...input.status } as BenchStatus,
    disk: { ...EMPTY_BENCH_DISK, ...input.disk },
    pinned: new Set(input.pinned ?? []),
  }
}

const gdb = (over: Partial<GdbStatus> = {}): GdbStatus => ({ state: "halted", epoch: 1, stops: [], at: 1, ...over })

describe("证据指纹", () => {
  test("日志:换了文件 / 多了行 / 开始采集都算变了;只是时刻走了不算", () => {
    const sig = (c: InstrumentContext) => instrumentSignature("log", c)
    const base = ctx({ status: { log: { capturing: false, file: "a.log", totalLines: 3, dropped: 0, at: 1 } } })
    expect(sig(base)).not.toBe(
      sig(ctx({ status: { log: { capturing: false, file: "a.log", totalLines: 4, dropped: 0, at: 2 } } })),
    )
    expect(sig(base)).not.toBe(
      sig(ctx({ status: { log: { capturing: false, file: "b.log", totalLines: 3, dropped: 0, at: 2 } } })),
    )
    expect(sig(base)).not.toBe(
      sig(ctx({ status: { log: { capturing: true, file: "a.log", totalLines: 3, dropped: 0, at: 2 } } })),
    )
    // 时刻不进指纹:同一份日志被重读一遍不该点一个提示点。
    expect(sig(base)).toBe(
      sig(ctx({ status: { log: { capturing: false, file: "a.log", totalLines: 3, dropped: 0, at: 99 } } })),
    )
    // 磁盘上多了一份也算 —— 上一轮存下的日志,这次会话没碰过 log 工具也该提示。
    expect(sig(ctx())).not.toBe(sig(ctx({ disk: { logFiles: 1 } })))
  })

  test("gdb:又停了一次、换了故障、复位换 epoch 都算变了", () => {
    const one = ctx({ status: { gdb: gdb({ stops: [{ n: 1, epoch: 1, reason: "bp", at: 1 }] }) } })
    const two = ctx({
      status: {
        gdb: gdb({
          stops: [
            { n: 1, epoch: 1, reason: "bp", at: 1 },
            { n: 2, epoch: 1, reason: "bp", at: 2 },
          ],
        }),
      },
    })
    const faulted = ctx({
      status: { gdb: gdb({ stops: [{ n: 1, epoch: 1, reason: "bp", at: 1 }], fault: "故障(BusFault)" }) },
    })
    const reset = ctx({ status: { gdb: gdb({ epoch: 2, stops: [{ n: 1, epoch: 2, reason: "bp", at: 1 }] }) } })
    expect(instrumentSignature("gdb", one)).not.toBe(instrumentSignature("gdb", two))
    expect(instrumentSignature("gdb", one)).not.toBe(instrumentSignature("gdb", faulted))
    expect(instrumentSignature("gdb", one)).not.toBe(instrumentSignature("gdb", reset))
    expect(instrumentSignature("gdb", ctx())).toBe("none")
  })

  test("示波器 / LA:换了采集 id 或磁盘上多了一份都算变了", () => {
    expect(instrumentSignature("scope", ctx({ status: { scope: { id: "s1", at: 5 } } }))).not.toBe(
      instrumentSignature("scope", ctx({ status: { scope: { id: "s2", at: 5 } } })),
    )
    expect(instrumentSignature("la", ctx({ disk: { laCaptures: 1 } }))).not.toBe(
      instrumentSignature("la", ctx({ disk: { laCaptures: 2 } })),
    )
  })

  test("busy 不进指纹:工具一开跑就点一次提示点是假的,那盏灯自己会脉冲", () => {
    const idle = ctx({ status: { scope: { id: "s1", at: 5 } } })
    const busy = ctx({ status: { scope: { id: "s1", at: 5 }, busy: new Set(["scope"]) as BenchStatus["busy"] } })
    expect(instrumentSignature("scope", idle)).toBe(instrumentSignature("scope", busy))
  })

  test("什么证据都没有的指纹不算「有新东西」", () => {
    expect(hasEvidence(instrumentSignature("log", ctx()))).toBe(false)
    expect(hasEvidence(instrumentSignature("gdb", ctx()))).toBe(false)
    expect(hasEvidence(instrumentSignature("scope", ctx()))).toBe(false)
    expect(hasEvidence(instrumentSignature("la", ctx({ disk: { laCaptures: 2 } })))).toBe(true)
  })
})

describe("看过没看过", () => {
  beforeEach(() => {
    localStorage.clear()
    benchSeen.reset()
  })

  test("键在 yoma.* 下", () => {
    expect(BENCH_SEEN_KEY).toBe("yoma.bench.seen")
  })

  test("seenKey 一眼看得出是哪一对", () => {
    expect(seenKey("abc", "gdb")).toBe("abc::gdb")
    expect(seenKey(undefined, "gdb")).toBe("::gdb")
  })

  test("没存过 / 存了垃圾一律当作「什么都没看过」,绝不抛", () => {
    for (const junk of [null, undefined, "", "not json", "null", "[]", "7"]) {
      expect(parseSeen(junk)).toEqual({})
    }
  })

  test("只有 `<会话>::<认识的仪器>` 的字符串条目进得来;别的形状直接丢掉,不迁移", () => {
    expect(parseSeen('{"s1::la":"a|b","s1::bogus":"x","la":"旧版本","s2::gdb":7,"s3::gdb":"ok"}')).toEqual({
      "s1::la": "a|b",
      "s3::gdb": "ok",
    })
  })

  test("从来没看过 + 手上有东西 = 新;看过之后熄灭;再来新东西又亮", () => {
    const one = ctx({ disk: { laCaptures: 1 } })
    expect(hasUnseen("la", one, "s1")).toBe(true)
    markSeen("la", one, "s1")
    expect(hasUnseen("la", one, "s1")).toBe(false)
    expect(hasUnseen("la", ctx({ disk: { laCaptures: 2 } }), "s1")).toBe(true)
  })

  test("从来没看过但也没有证据 = 不点", () => {
    expect(hasUnseen("la", ctx(), "s1")).toBe(false)
    expect(hasUnseen("gdb", ctx(), "s1")).toBe(false)
  })

  test("按会话记:在 A 里看过不代表 B 里也看过 —— 指纹有一半来自 transcript", () => {
    const evidence = ctx({ disk: { laCaptures: 1 } })
    markSeen("la", evidence, "A")
    expect(hasUnseen("la", evidence, "A")).toBe(false)
    expect(hasUnseen("la", evidence, "B")).toBe(true)
  })

  test("记满 120 条从最早那条开始丢", () => {
    const evidence = ctx({ disk: { laCaptures: 1 } })
    markSeen("la", evidence, "A")
    for (let i = 0; i < 200; i++) benchSeen.record(`fill-${i}::log`, `sig-${i}`)
    expect(hasUnseen("la", evidence, "A")).toBe(true)
    expect(benchSeen.unseen("fill-199::log", "sig-199")).toBe(false)
  })

  test("localStorage 抛了也不炸,而且这一次会话里照样算看过了", () => {
    // 无痕窗口 / 清过站点数据时 setItem 会抛。"这台仪器有没有新东西"不值得把会话页炸掉,
    // 存不下就只在本次会话里生效 —— 所以要断言的是**没抛**,且内存里那一份仍然生效了。
    const evidence = ctx({ disk: { laCaptures: 1 } })
    const setItem = localStorage.setItem.bind(localStorage)
    localStorage.setItem = () => {
      throw new Error("QuotaExceededError")
    }
    try {
      expect(() => markSeen("la", evidence, "A")).not.toThrow()
    } finally {
      localStorage.setItem = setItem
    }
    expect(hasUnseen("la", evidence, "A")).toBe(false)
  })

  test("落盘:看过的那一条读回来还在(app 重开之后提示点不会全部复活)", () => {
    markSeen("la", ctx({ disk: { laCaptures: 1 } }), "A")
    expect(parseSeen(localStorage.getItem(BENCH_SEEN_KEY))).toEqual({ "A::la": "1||0" })
  })

  test("同一份指纹再记一次不重写 localStorage —— 面板开着时这个函数每拍都会被调", () => {
    const evidence = ctx({ disk: { laCaptures: 1 } })
    markSeen("la", evidence, "A")
    const before = localStorage.getItem(BENCH_SEEN_KEY)
    let writes = 0
    const setItem = localStorage.setItem.bind(localStorage)
    localStorage.setItem = (key: string, value: string) => {
      writes++
      setItem(key, value)
    }
    try {
      markSeen("la", evidence, "A")
      markSeen("la", evidence, "A")
    } finally {
      localStorage.setItem = setItem
    }
    expect(writes).toBe(0)
    expect(localStorage.getItem(BENCH_SEEN_KEY)).toBe(before)
  })
})

describe("该点提示点的那些仪器", () => {
  beforeEach(() => {
    localStorage.clear()
    benchSeen.reset()
  })

  test("只看该露面的那些 —— 藏着的仪器没有任何地方画得下这个点", () => {
    // 磁盘上有示波器采集 = 示波器露面;LA 什么都没有 = 藏着。
    expect([...unseenInstruments(ctx({ disk: { scopeCaptures: 1 } }), "s1")]).toEqual(["scope"])
  })

  test("开着的那台不点:面板已经在屏幕上了,新证据直接就看见了", () => {
    const both = ctx({ disk: { scopeCaptures: 1, laCaptures: 1 } })
    expect([...unseenInstruments(both, "s1")].sort()).toEqual(["la", "scope"])
    expect([...unseenInstruments(both, "s1", new Set<InstrumentId>(["scope"]))]).toEqual(["la"])
  })

  test("看过之后就不在这份集合里了", () => {
    const evidence = ctx({ disk: { laCaptures: 1 }, pinned: ["la"] })
    expect(unseenInstruments(evidence, "s1").has("la")).toBe(true)
    markSeen("la", evidence, "s1")
    expect(unseenInstruments(evidence, "s1").has("la")).toBe(false)
  })

  test("什么都没发生的会话上一个点都没有(日志虽然永远露面,但它手上没东西)", () => {
    expect([...unseenInstruments(ctx(), "s1")]).toEqual([])
  })
})
