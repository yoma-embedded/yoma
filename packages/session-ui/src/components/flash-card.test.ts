import { describe, expect, test } from "vitest"
import { describeFlash, joinCommand } from "./flash-card"
import { fixture } from "./fixtures/hw-parts"

describe("describeFlash · 真实形状", () => {
  const part = fixture("flash")

  test("命令整段拼出来,一个字都不截", () => {
    const card = describeFlash(part.input, part.metadata, part.output)!
    expect(card.command).toBe("sh tools/flash-openocd.sh build/f405-motor-ctrl.elf")
    // 与契约的 flashSummary 同一种拼法
    expect(card.command).toBe(joinCommand(part.metadata.command as string[]))
  })

  test("exit 0 = 成了;镜像从命令里认出来", () => {
    const card = describeFlash(part.input, part.metadata, part.output)!
    expect(card.ok).toBe(true)
    expect(card.exitCode).toBe(0)
    expect(card.image).toBe("build/f405-motor-ctrl.elf")
    expect(card.recordedElf).toBe("/work/f405-motor-ctrl/build/f405-motor-ctrl.elf")
  })

  test("OpenOCD 的关键行进高亮,Warn 标成 warn", () => {
    const card = describeFlash(part.input, part.metadata, part.output)!
    const texts = card.highlights.map((item) => item.text)
    expect(texts).toContain("** Programming Finished **")
    expect(texts).toContain("** Verified OK **")
    expect(card.highlights.find((item) => item.text.startsWith("Warn :"))?.tone).toBe("warn")
    // 上限在,别让一屏 OpenOCD 输出整段搬进卡片
    expect(card.highlights.length).toBeLessThanOrEqual(6)
  })

  test("写入 / 校验的字节数与秒数从输出里读回来", () => {
    const card = describeFlash(part.input, part.metadata, part.output)!
    expect(card.wroteBytes).toBe(16384)
    expect(card.programSeconds).toBeCloseTo(0.681733, 6)
    expect(card.verifySeconds).toBeCloseTo(0.049812, 6)
  })
})

describe("describeFlash · 边界", () => {
  test("退出码非 0 = 没成,即使输出里写着 Programming Finished", () => {
    const argv = ["openocd", "-c", "program fw.elf verify reset exit"]
    const card = describeFlash(
      { command: argv },
      { command: argv, exitCode: 1 },
      "** Programming Finished **\nError: libusb_open() failed with LIBUSB_ERROR_ACCESS\n",
    )!
    expect(card.ok).toBe(false)
    expect(card.exitCode).toBe(1)
    expect(card.highlights.find((item) => item.text.includes("LIBUSB_ERROR_ACCESS"))?.tone).toBe("fail")
  })

  test("失败行挤不出上限:一屏过程行之后那一条 Error 照样在", () => {
    const argv = ["openocd"]
    // 七条过程行 + 一条定论行 + 一条 Error,上限是 6
    const noise = [
      "** Programming Started **",
      "Erasing done",
      "** Verify Started **",
      "** Resetting Target **",
      "RESET done",
      "Verifying ... OK",
      "wrote 1024 bytes from file fw.elf in 0.1s",
    ].join("\n")
    const card = describeFlash({ command: argv }, { command: argv, exitCode: 1 }, `${noise}\nError: no device found`)!
    expect(card.highlights.length).toBe(6)
    expect(card.highlights.some((item) => item.text === "Error: no device found")).toBe(true)
    // 挑完之后按原序摆:读起来还是一次烧录,不是按严重程度重排过的一张表
    expect(card.highlights[card.highlights.length - 1].text).toBe("Error: no device found")
    expect(card.highlights[0].text).toBe("** Programming Started **")
    // 过程行("** Resetting Target **")先被挤掉,定论行留着
    expect(card.highlights.some((item) => item.text === "Verifying ... OK")).toBe(true)
  })

  test("`program <file>` 里的镜像也认得出来", () => {
    const argv = ["openocd", "-f", "interface/stlink.cfg", "-c", "program build/fw.elf verify reset exit"]
    expect(describeFlash({ command: argv }, { command: argv, exitCode: 0 }, "")!.image).toBe("build/fw.elf")
  })

  test("工具抛错(metadata 是 {})时退回 input 里的命令,exitCode 报 null", () => {
    const card = describeFlash({ command: ["openocd"] }, {}, undefined)!
    expect(card.command).toBe("openocd")
    expect(card.ok).toBe(false)
    expect(card.exitCode).toBe(null)
  })

  test("形状不对 → undefined(调用方回落到通用卡)", () => {
    // 连命令都没有:这不是 flash 的形状(旧会话重放时 details 可能是上一个版本的)
    expect(describeFlash({}, {}, "whatever")).toBeUndefined()
    expect(describeFlash(undefined, undefined, undefined)).toBeUndefined()
    expect(describeFlash({ command: "not an array" }, { command: 42 }, "")).toBeUndefined()
    expect(describeFlash({ command: [] }, { command: [] }, "")).toBeUndefined()
  })

  test("metadata 里塞垃圾也不抛", () => {
    expect(() =>
      describeFlash({ command: ["x"] }, { command: ["x"], exitCode: "0", recordedElf: 7 } as never, null as never),
    ).not.toThrow()
  })
})
