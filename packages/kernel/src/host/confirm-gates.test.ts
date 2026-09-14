/**
 * confirmNeeded(tools/contracts.ts):钩子问"这次要不要先问用户"的那一个函数。
 *
 * 钉三件事:flash 每次都问;bash / powershell 只在命令位站着探针程序时问(上一版一个字都不问 ——
 * 模型被拒之后改用 bash 跑同一条 openocd 就绕过去了);没登记的工具与无害命令不问。
 */

import { describe, expect, it } from "vitest"

import { confirmNeeded } from "./tools/contracts.ts"

describe("confirmNeeded", () => {
  it("flash 每次都问,summary 是拼回去的那行命令", () => {
    const gate = confirmNeeded("flash", { command: ["openocd", "-c", "program fw.elf"] })
    expect(gate?.label).toBe("烧录")
    expect(gate?.summary({ command: ["openocd", "-c", "program fw.elf"] })).toBe('openocd -c "program fw.elf"')
  })

  it("bash 里起探针程序要问,summary 是整条命令", () => {
    const command = "cd build && openocd -f interface/stlink.cfg -c 'program fw.elf verify reset exit'"
    const gate = confirmNeeded("bash", { command })
    expect(gate?.label).toBe("命令")
    expect(gate?.summary({ command })).toBe(command)
  })

  it("powershell 里起探针程序要问,summary 是整段脚本(不只首行)", () => {
    const command = "Set-Location build\n& 'C:\\ST\\STM32_Programmer_CLI.exe' -c port=SWD -e all"
    const gate = confirmNeeded("powershell", { command })
    expect(gate?.label).toBe("PowerShell")
    expect(gate?.summary({ command })).toBe(command)
  })

  it("log 只在 command 源起探针程序时问;串口、TCP、wait/read 一律不问", () => {
    const command = "openocd -f interface/stlink.cfg -c 'rtt server start 9090 0'"
    const gate = confirmNeeded("log", { action: "start", command })
    expect(gate?.label).toBe("日志")
    expect(gate?.summary({ action: "start", command })).toBe(`start ${command}`)
    expect(confirmNeeded("log", { action: "start", command: "python3 decode.py /dev/ttyUSB0" })).toBeUndefined()
    expect(confirmNeeded("log", { action: "start", port: "/dev/ttyUSB0", baud: 921600 })).toBeUndefined()
    expect(confirmNeeded("log", { action: "start", tcp: "localhost:19021" })).toBeUndefined()
    expect(confirmNeeded("log", { action: "wait", pattern: "openocd" })).toBeUndefined()
  })

  it("无害命令、没登记的工具、参数形状不对的都不问", () => {
    expect(confirmNeeded("bash", { command: "ls -la && grep -rn openocd src/" })).toBeUndefined()
    expect(confirmNeeded("powershell", { command: "Get-PnpDevice -Class Ports" })).toBeUndefined()
    expect(confirmNeeded("bash", { command: 42 })).toBeUndefined()
    expect(confirmNeeded("read", { path: "openocd.cfg" })).toBeUndefined()
    expect(confirmNeeded("grep", { pattern: "openocd" })).toBeUndefined()
  })
})
