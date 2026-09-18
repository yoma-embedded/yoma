/**
 * 目标卡的三行读数。
 *
 * 这里钉的是**"板子永远在场"这条立场的具体形状**:三行固定都在,没发生过的那一行是暗着的空值,
 * 而不是这一行消失。一格消失和一格是空的,对读的人是两件事。
 *
 * 移植自 `ui/v3-bench` 的同名文件。
 */
import { describe, expect, test } from "vitest"
import { EMPTY_BENCH_STATUS, type BenchStatus } from "./bench-status"
import { targetRows } from "./target-card"

/** 测试里的翻译器:原样回键名,顺便证明取的是哪一条。 */
const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}(${Object.values(params).join(",")})` : key
const status = (partial: Partial<BenchStatus>): BenchStatus => ({ ...EMPTY_BENCH_STATUS, ...partial })
const byKey = (rows: ReturnType<typeof targetRows>, key: string) => rows.find((row) => row.key === key)!

describe("targetRows", () => {
  test("什么都没发生过也是三行,值是空的、灯是灭的", () => {
    const rows = targetRows(EMPTY_BENCH_STATUS, t)
    expect(rows.map((row) => row.key)).toEqual(["flash", "gdb", "log"])
    expect(rows.every((row) => row.value === undefined)).toBe(true)
    expect(rows.every((row) => row.state === "offline")).toBe(true)
  })

  test("烧录成功是绿灯 + 时间 + 镜像文件名(不是绝对路径)", () => {
    const rows = targetRows(
      status({
        flash: {
          ok: true,
          exitCode: 0,
          command: "sh tools/flash.sh",
          image: "/Users/ben/ws/f405/build/f405-motor-ctrl.elf",
          at: Date.parse("2026-09-18T01:15:54Z"),
        },
      }),
      t,
    )
    const flash = byKey(rows, "flash")
    expect(flash.state).toBe("ok")
    expect(flash.value).toContain("f405-motor-ctrl.elf")
    expect(flash.value).not.toContain("/Users/ben")
  })

  test("烧录失败是红灯 + 退出码", () => {
    const flash = byKey(targetRows(status({ flash: { ok: false, exitCode: 1, command: "x", at: 1 } }), t), "flash")
    expect(flash.state).toBe("fail")
    expect(flash.value).toContain("exit 1")
  })

  test("gdb 出过故障时指的是**出事那一行**,不是现在停在哪(现在停的是故障处理函数)", () => {
    const gdb = byKey(
      targetRows(
        status({
          gdb: {
            state: "halted",
            epoch: 1,
            stops: [{ n: 1, epoch: 1, reason: "breakpoint-hit", at: 1 }],
            at: 1,
            location: "main.c:136",
            fault: "故障(BusFault):PRECISERR",
            faultLocation: "foc.c:45",
          },
        }),
        t,
      ),
      "gdb",
    )
    expect(gdb.value).toContain("foc.c:45")
    expect(gdb.value).not.toContain("main.c:136")
    expect(gdb.state).toBe("attention")
  })

  test("gdb 会话收了之后灯灭、字还在 —— 那份故障现场在会话结束后才最有用", () => {
    const gdb = byKey(
      targetRows(
        status({
          gdb: {
            state: "none",
            epoch: 1,
            stops: [{ n: 1, epoch: 1, reason: "breakpoint-hit", at: 1 }],
            at: 1,
            fault: "故障(BusFault)",
            faultLocation: "foc.c:45",
            report: "■ stopped#1",
          },
        }),
        t,
      ),
      "gdb",
    )
    expect(gdb.state).toBe("offline")
    expect(gdb.value).toContain("foc.c:45")
    expect(gdb.value).toContain("session.bench.gdb.state.ended")
  })

  test("正在采集的日志是活灯", () => {
    const log = byKey(
      targetRows(
        status({
          log: {
            capturing: true,
            source: "serial /dev/cu.usbmodem1103 @ 115200 8N1",
            kind: "serial",
            port: "/dev/cu.usbmodem1103",
            baud: 115200,
            totalLines: 12,
            dropped: 0,
            at: 1,
          },
        }),
        t,
      ),
      "log",
    )
    expect(log.state).toBe("active")
    expect(log.value).toContain("cu.usbmodem1103")
  })

  test("这次会话没采过、可工程里有旧日志时,那一格说的是旧日志而不是'什么都没有'", () => {
    const log = byKey(targetRows(EMPTY_BENCH_STATUS, t, { logFiles: 2 }), "log")
    expect(log.value).toBe("session.bench.target.logOnDisk(2)")
    // 旧日志不是现状 —— 灯仍然是灭的。
    expect(log.state).toBe("offline")
  })

  test("烧录那一格永远不可点(它是一个动作,不是一台仪器)", () => {
    const rows = targetRows(EMPTY_BENCH_STATUS, t)
    expect(byKey(rows, "flash").id).toBeUndefined()
    expect(byKey(rows, "gdb").id).toBe("gdb")
    expect(byKey(rows, "log").id).toBe("log")
  })
})
