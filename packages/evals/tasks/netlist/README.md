# netlist 组 —— 15 道纸面题(L1)

评的是 agent 在**只有一份网表**的情况下能不能把连接关系读准:主控是谁、某个脚最后落在哪、
一个脚扇出到哪几处、不贴的元件算不算数、某个外设该配到哪几个 pad。全部是 analysis-only,
所以每题都挂 `tool-forbidden: ["flash","gdb","log"]` —— 板子根本不在场,碰硬件工具就是错的。

夹具全部来自 `engines/controller_map/tests/fixtures/`,复制进工作目录时改成中性文件名
(`board.xml` / `board.NET` / `board.net`),**扩展名保留**。格式识别是按内容而不是扩展名做的
(实测:`stm32_eeschema_legacy.net` 改名成 `board.net` 后仍报 `format: eeschema`),
输出里的 `source` 字段也跟着变成 `board`,不泄露夹具出身。

## 难度怎么定的

`netlist` 工具不带 `part` 时跑 controller_map 给原始逐 pin 图,**输出被截到 10,000 字符**
(`netlist.ts` 里写死,比引擎通用上限 24,000 更紧)。判据就一条:

- **easy** —— 答案落在截断后的那 10,000 字符里,一次裸调用就看得见。
- **hard** —— 答案在截断之外:要么带 `part` 跑 board IR,要么用 `mainController` 改指别的元件,
  要么自己去读网表原文。

五份夹具裸调用的实测体量(stdout trim 后 / 截断后窗口覆盖到哪):

| 夹具 | stdout 字符 | 截断 | 窗口覆盖 |
|---|---|---|---|
| `RP2040_kicad_netlist.xml` | 26,089 | 是 | signal_pins 只到 pin 20(XIN);pin 47/56 全在窗外 |
| `pca10056.NET`(自动 U2) | 34,132 | 是 | 到 SWD1_RESET 一带 |
| `pca10056.NET --main-controller U1` | 87,969 | 是 | **只剩 7 个网络**(P0.31/AIN7 … P1.10) |
| `odrive_two_ax.NET` | 44,051 | 是 | 只有 12 个网络(M0_nCS_1 … GPIO_2_1) |
| `sumobot_eeschema.net` | 16,924 | 是 | PA0 … PB4 |
| `stm32_eeschema_legacy.net` | 2,324 | 否 | 全量 |

带 `part` 的 board IR 模式则相反:两块 STM32 板的 `stm32_map` 分别是 18,933 / 11,286 字符,
**都没到 24,000 的内联上限**,整份都在工具输出里 —— 所以 14/15 两题虽然标 hard,
只要 agent 照工具自述"知道料号就第一次调用直接带 part"去做,一次就能拿到答案。

## 题目清单

| id | 夹具 | 格式 | 难度 | 参考答案 | 事实出处 | 一句话 |
|---|---|---|---|---|---|---|
| `netlist-rp2040-main-controller` | RP2040 | kicad | easy | `U3` | check.py:45 | 板上好几颗芯片,哪一颗是主控 |
| `netlist-rp2040-gpio0-header` | RP2040 | kicad | easy | `J3.4` | check.py:49 | GPIO0 直连到排针的哪个脚 |
| `netlist-rp2040-xin-crystal` | RP2040 | kicad | easy | `Y1.1` | check.py:59 | XIN 上排掉负载电容 C2,真正的终点是晶振 |
| `netlist-rp2040-qspi-ss-dnf` | RP2040 | kicad | **hard** | `R2` | check.py:56-57 | 片选上标 DNF 的上拉是哪个位号(全网表唯一一个 DNF) |
| `netlist-rp2040-usb-dp-endpoint` | RP2040 | kicad | **hard** | `J1.3` | check.py:50-53 | USB D+ 经 27R 串阻落到 USB 座哪个脚 |
| `netlist-nrf-imcu-reset-fanout` | pca10056 | altium | easy | `["J4.10","TP50.1","RAIL:VDD_IMCU"]` | check_connections.py:84 | 扇出数组题,含经 100k 上拉到的电源轨 |
| `netlist-nrf-target-mcu-ref` | pca10056 | altium | easy | `U1` | check.py:68 / :72 | 自动探测挑的是 U2(nRF5340),目标芯片其实是 runner-up |
| `netlist-nrf52840-p031-fanout` | pca10056 | altium | **hard** | `["P2.6","P8.6","P14.12","TP47.1"]` | 直跑核实(同 check.py:72-74 那一支) | 必须 `mainController: "U1"`,自动图里 P0.31 一次都不出现 |
| `netlist-odrive-m0-ncs` | odrive | altium | easy | `U4.8` | 直跑核实 | 两轴各一颗栅极驱动,M0 那路去 U4、M1 那路去 U5 |
| `netlist-odrive-can-pins` | odrive | altium | **hard** | `["PB8","PB9"]` | check_stm32_map.py:48 | 带 `part: STM32F405RGT6` 才有的 stm32_map:CAN1 RX/TX |
| `netlist-stm32g0-led-endpoint` | stm32 legacy | eeschema | easy | `D2.1` | check.py:102 | 经 R1 追到 D2;板上还有一颗直连的 D1 当干扰项 |
| `netlist-stm32g0-signal-pin-count` | stm32 legacy | eeschema | easy | `4` | check.py:99-100 | 计数题:滤掉 3 个电源脚,unconnected 的那个仍要算 |
| `netlist-sumobot-dip-switch-pins` | sumobot | eeschema | easy | `["PA4","PA5","PA6","PA7"]` | check_actuators.py:69 | 反查:4 位拨码开关 SW1 落在哪四个 pad |
| `netlist-sumobot-motor-in1` | sumobot | eeschema | easy | `U1.3` | check_board_ir.py:148-149 | 两颗同型号 DRV8871,PA2 去的是 U1 不是 U2 |
| `netlist-sumobot-servo-timer` | sumobot | eeschema | **hard** | `TIM3` | check_actuators.py:46-47 | 带 `part: STM32F103C8T6` 的 stm32_map:两个舵机共用 TIM3 CH3/CH4 |

配比 10 easy + 5 hard;kicad / altium / eeschema 各 5 题;五份夹具全部用到。
15 个参考答案两两不同,没有一条事实出两次。

## grader 约定

每题三个:`answer`(全部 `equals`;数组题按集合比,`unordered` 走默认 true)、
`grounded`(显式给 needles)、`tool-forbidden`。**没有一题用 `tool-called`** —— 题面都没有
要求"用网表解析",判路径会冤枉合法解法(比如直接读 XML 数一遍)。

needles 一律挑 ASCII 的位号 / 网络名,并且逐条拿真实引擎输出核对过(见下面"坑"里的编码那条:
夹具里的 µ、Ø、破折号在中文 Windows 上会变成 U+FFFD,选到它们就是一个随机红的闸门)。
easy 题的 needles 都落在默认 faux(裸调 `netlist`)的输出里,所以不写 `faux`;
5 道 hard 题自带 `faux.good`,参数是我实跑过的那一组:

| id | faux.good 的工具入参 | 该输出里 needles 在不在 |
|---|---|---|
| `netlist-rp2040-qspi-ss-dnf` | `{netlistPath:"board.xml", mainController:"U2"}` | 在(4,618 字符不截断,QSPI_SS / DNF 都有) |
| `netlist-rp2040-usb-dp-endpoint` | `{netlistPath:"board.xml", mainController:"J1"}` | 在(1,952 字符不截断,USB_DP / R3 都有) |
| `netlist-nrf52840-p031-fanout` | `{netlistPath:"board.NET", mainController:"U1"}` | 在(截断了,但 P0.31/AIN7 是窗口里第一个网络) |
| `netlist-odrive-can-pins` | `{netlistPath:"board.NET", part:"STM32F405RGT6"}` | 在(stm32_map 整份内联) |
| `netlist-sumobot-servo-timer` | `{netlistPath:"board.net", part:"STM32F103C8T6"}` | 在(stm32_map 整份内联) |

## 出题时踩到 / 记下的坑

- **引擎的 stdout 和 stderr 在中文 Windows 上是 cp936,不是 UTF-8。** `runEngine`
  (`tools/engines.ts`)spawn 时**不传 env**,所以 bash 工具那份 `PYTHONIOENCODING=utf-8` +
  `PYTHONUTF8=1` 兜不到它;`child.stdout.setEncoding("utf8")` 于是把 `µ`(GBK `a6 cc`)、
  `Ø`、破折号 `—`(GBK `a1 aa`)解成 U+FFFD。实测 `pca10056.NET` 的裸输出里有 **12 个**
  U+FFFD,低置信度警告那句在模型眼里是 `low-confidence controller detection <?><?> verify`。
  不影响任何一道题的答案(位号 / 网络名全是 ASCII),但 needles 绝不能挑到这些字符上。
- **截断提示语本身是有用信息**:被截时工具会补一句
  `[truncated: N of M characters withheld. re-run with \`part\` set to …]` —— hard 题指望
  agent 看见这句话之后换路子,而不是拿窗口里那一段硬答。
- **自动探测在三份夹具上都报 low confidence**(pca10056 98 vs 74 脚、odrive U2 vs U4、
  sumobot U3 vs U1),odrive 的主控 `part` 字段还是**空串**(Altium 网表里没写型号)。
  只有 RP2040 和 stm32 legacy 是高置信度。
- **sumobot 带 part 跑 board IR 会吐三条吓人的警告**(`wrong part or package?`、
  `the part number is probably wrong for this netlist`、`weak join`)—— 因为蓝药丸模块的符号
  按 pad 名而不是封装位号编号。**TIM 建议本身是对的**,但这是 `netlist-sumobot-servo-timer`
  最可能把 agent 带跑偏的地方。
- **board IR 模式的 `[detection]` 段只有三行 `wrote <绝对路径>`**,没有主控探测说明 ——
  想同时拿"探测置信度"和"外设建议",得两种模式各跑一次。
