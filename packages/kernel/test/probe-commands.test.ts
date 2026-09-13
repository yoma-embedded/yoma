/**
 * probeCommandIn(flash/contract.ts):bash / powershell 那两道确认门的纱窗。
 *
 * 正例要覆盖模型真会写的形状(sudo、PowerShell 的 & 调用符、绝对路径带 .exe、python -m、管道后半段、
 * bash -c 里藏一层、west flash 这种两个词才算的);反例要覆盖"参数里出现程序名"—— `grep openocd`
 * 与 `cat openocd.cfg` 若也问,用户会被问到烦,然后习惯性点允许,门就白立了。
 */

import { describe, expect, it } from "vitest"

import { probeCommandIn } from "../src/host/tools/flash/contract.ts"

describe("probeCommandIn", () => {
  it("命令位站着探针程序:各种包装与路径形状都认", () => {
    expect(probeCommandIn("openocd -f interface/stlink.cfg -c 'program fw.elf verify reset exit'")).toBe("openocd")
    expect(probeCommandIn("sudo openocd -f board/st_nucleo_g4.cfg")).toBe("openocd")
    expect(probeCommandIn('& "C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\bin\\STM32_Programmer_CLI.exe" -c port=SWD -w fw.hex')).toBe(
      "stm32_programmer_cli",
    )
    expect(probeCommandIn(".\\JLink.exe -device STM32G474RE -CommanderScript flash.jlink")).toBe("jlink")
    expect(probeCommandIn("/opt/SEGGER/JLink/JLinkExe -if SWD")).toBe("jlink")
    expect(probeCommandIn("python -m esptool --port COM3 write_flash 0x0 fw.bin")).toBe("esptool")
    expect(probeCommandIn("python3 esptool.py --chip esp32 erase_flash")).toBe("esptool")
    expect(probeCommandIn("cd build && st-flash write fw.bin 0x8000000")).toBe("st-flash")
    expect(probeCommandIn("echo y | pyocd flash fw.hex")).toBe("pyocd")
    expect(probeCommandIn("PROBE=1 nrfjprog --program fw.hex --chiperase")).toBe("nrfjprog")
  })

  it("包装自己的开关站在程序名前面也认:Start-Process -FilePath、sudo -E、start /wait", () => {
    expect(probeCommandIn("Start-Process -FilePath 'STM32_Programmer_CLI.exe' -ArgumentList '-c port=SWD -e all' -Wait")).toBe(
      "stm32_programmer_cli",
    )
    expect(probeCommandIn("sudo -E openocd -f interface/stlink.cfg")).toBe("openocd")
    expect(probeCommandIn("start /wait openocd -f x.cfg")).toBe("openocd")
    expect(probeCommandIn("sudo west flash")).toBe("west flash")
  })

  it("PowerShell 脚本块与赋值:Start-Job { … }、if { … }、foreach { … }、$p = Start-Process 都认", () => {
    expect(probeCommandIn('Start-Job { openocd -f interface/stlink.cfg -c "init; stm32f4x mass_erase 0" }')).toBe("openocd")
    expect(probeCommandIn("Invoke-Command -ScriptBlock { openocd -f x.cfg }")).toBe("openocd")
    expect(probeCommandIn("if ($true) { openocd -f x.cfg }")).toBeDefined()
    expect(probeCommandIn("foreach ($f in $files) { STM32_Programmer_CLI -c port=SWD -w $f }")).toBe("stm32_programmer_cli")
    expect(probeCommandIn("$p = Start-Process openocd -PassThru")).toBe("openocd")
    expect(probeCommandIn("$p=Start-Process openocd -PassThru")).toBe("openocd")
    expect(probeCommandIn("$p = & openocd -f x.cfg")).toBe("openocd")
    expect(probeCommandIn("cmd.exe /c start openocd -f x.cfg")).toBe("openocd")
    expect(probeCommandIn("$ports = Get-PnpDevice -Class Ports | % { $_.InstanceId }")).toBeUndefined()
  })

  it("Makefile / package.json 的 flash 目标也算:那是最常见的烧录入口", () => {
    expect(probeCommandIn("make -j8 flash")).toBe("make flash")
    expect(probeCommandIn("make -C build erase")).toBe("make erase")
    expect(probeCommandIn("make -j8 all")).toBeUndefined()
    expect(probeCommandIn("npm run flash")).toBe("npm flash")
    expect(probeCommandIn("pnpm run build")).toBeUndefined()
  })

  it("SEGGER 的 Unix 命名:JLinkGDBServerCLExe / JFlashExe 与 Windows 的 .exe 同一个程序", () => {
    expect(probeCommandIn("JLinkGDBServerCLExe -device STM32G474RE -if SWD")).toBe("jlinkgdbservercl")
    expect(probeCommandIn("JLinkGDBServerCL.exe -device STM32G474RE")).toBe("jlinkgdbservercl")
    expect(probeCommandIn("JFlashExe -openprj proj.jflash -auto -exit")).toBe("jflash")
  })

  it("两个词才算:子命令按各家语法定位", () => {
    expect(probeCommandIn("west flash --runner openocd")).toBe("west flash")
    expect(probeCommandIn("west build -b nucleo_g474re")).toBeUndefined()
    expect(probeCommandIn("cargo embed --chip STM32G474RETx")).toBe("cargo embed")
    expect(probeCommandIn("cargo +nightly embed")).toBe("cargo embed")
    expect(probeCommandIn("cargo build --release")).toBeUndefined()
    // 子命令名出现在开关的值里、测试过滤里:不问。
    expect(probeCommandIn("cargo build --features embed --release")).toBeUndefined()
    expect(probeCommandIn("cargo test -- flash")).toBeUndefined()
    expect(probeCommandIn("pio run -t upload")).toBe("pio upload")
    expect(probeCommandIn("pio run -e nucleo_g474re --target upload")).toBe("pio upload")
    expect(probeCommandIn("pio run")).toBeUndefined()
    expect(probeCommandIn("idf.py -p COM3 flash")).toBe("idf flash")
    expect(probeCommandIn("idf.py build")).toBeUndefined()
  })

  it("藏在子 shell 字符串里也认:bash -c / -lc / cmd /c / Invoke-Expression,引号里的分号不剪断", () => {
    expect(probeCommandIn('bash -c "openocd -f x.cfg"')).toBe("openocd")
    expect(probeCommandIn('bash -lc "openocd -f x.cfg"')).toBe("openocd")
    expect(probeCommandIn('bash -c "openocd -f x.cfg -c \'init; stm32g4x mass_erase 0; exit\'"')).toBe("openocd")
    expect(probeCommandIn('cmd /c "STM32_Programmer_CLI.exe -c port=SWD"')).toBe("stm32_programmer_cli")
    expect(probeCommandIn("Invoke-Expression 'JLinkExe -CommanderScript x.jlink'")).toBe("jlink")
    expect(probeCommandIn("bash -c 'ls -la'")).toBeUndefined()
  })

  it("只看命令位,不扫参数:查日志、读配置、搜代码、改脚本都不问", () => {
    expect(probeCommandIn("grep -rn openocd src/")).toBeUndefined()
    expect(probeCommandIn("cat openocd.cfg")).toBeUndefined()
    expect(probeCommandIn("rg JLinkExe docs/")).toBeUndefined()
    expect(probeCommandIn("ls /opt/SEGGER/JLink")).toBeUndefined()
    expect(probeCommandIn("tail -f openocd.log")).toBeUndefined()
    expect(probeCommandIn("which openocd")).toBeUndefined()
    // 引号里的 | 与 ; 不是段界:sed 的分隔符、grep 的正则里出现程序名不该问。
    expect(probeCommandIn("sed -i 's|openocd|pyocd|g' flash.sh")).toBeUndefined()
    expect(probeCommandIn('grep -E "error|openocd failed" build.log')).toBeUndefined()
    expect(probeCommandIn("")).toBeUndefined()
  })

  it("多段脚本只要有一段碰探针就问", () => {
    const script = ["$ErrorActionPreference = 'Stop'", "Set-Location build", "openocd -f x.cfg -c 'program fw.elf'"].join("\n")
    expect(probeCommandIn(script)).toBe("openocd")
    expect(probeCommandIn("make -j8; arm-none-eabi-size build/fw.elf")).toBeUndefined()
  })
})
