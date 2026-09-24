/**
 * 内核心跳的看门人:超时记一次、恢复记一次带时长;main 自己被堵的那一拍不算。
 */
import { describe, expect, it } from "vitest"
import { createHeartbeatWatch } from "./kernel-heartbeat"

function setup() {
  let now = 0
  const silent: number[] = []
  const recovered: number[] = []
  const watch = createHeartbeatWatch({
    now: () => now,
    checkMs: 5_000,
    silentMs: 20_000,
    onSilent: (ms) => silent.push(ms),
    onRecovered: (ms) => recovered.push(ms),
  })
  return {
    watch,
    silent,
    recovered,
    advance(ms: number) {
      now += ms
    },
  }
}

describe("createHeartbeatWatch", () => {
  it("心跳按时到:一直不出声", () => {
    const t = setup()
    for (let i = 0; i < 20; i++) {
      t.advance(5_000)
      t.watch.beat()
      t.watch.check()
    }
    expect(t.silent).toEqual([])
    expect(t.recovered).toEqual([])
  })

  it("20 s 没心跳记一次(只记一次);心跳回来再记一次带总时长", () => {
    const t = setup()
    for (let i = 0; i < 6; i++) {
      t.advance(5_000)
      t.watch.check()
    }
    expect(t.silent).toEqual([20_000])
    t.advance(2_000)
    t.watch.beat()
    expect(t.recovered).toEqual([32_000])
    t.advance(5_000)
    t.watch.check()
    expect(t.silent).toHaveLength(1)
  })

  it("main 自己被堵(这次检查晚到了一个间隔以上):这一拍不算,下一拍照常判", () => {
    const t = setup()
    t.advance(25_000) // main 被堵了 25 s,内核的心跳在队列里等着
    t.watch.check()
    expect(t.silent).toEqual([])
    t.watch.beat() // 队列里的心跳紧接着被处理
    t.advance(5_000)
    t.watch.check()
    expect(t.silent).toEqual([])
  })
})
