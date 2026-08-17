"""Reproducible verification for stm32_map inference on the ODrive v3 netlist.

Expected values are derived from the netlist + the F405 pin table; where the board
revision agrees with stm32-config-kernel's hand-transcribed parity config
(tests/parity/odrive/odrive.json), they are identical to it: CAN1, SPI3, TIM1, TIM8,
TIM2, TIM3, TIM4, USB_OTG_FS, HSE 8 MHz, EN_GATE/nCS/nFAULT gpio.

Run:  uv run python tests/check_stm32_map.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from controller_map.board_ir import build_board_ir
from controller_map.mcu_desc import load_mcu_desc
from controller_map.stm32_map import build_stm32_map

FIX = Path(__file__).parent / "fixtures"
_checks = 0


def check(cond: bool, msg: str) -> None:
    global _checks
    _checks += 1
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        raise SystemExit(1)
    print(f"  ok: {msg}")


desc = load_mcu_desc(FIX / "STM32F405RGTx.mcudesc.json")
ir, _, _ = build_board_ir(FIX / "odrive_two_ax.NET", desc, "STM32F405RGT6", "user")
m = build_stm32_map(ir, desc)

print("== identity / clock / reserved ==")
check(m["mcu"]["part"] == "STM32F405RGTx", "part STM32F405RGTx")
check(m["clock"] == [{"source": "HSE", "kind": "crystal", "freqHz": 8_000_000,
                      "pads": ["PH0", "PH1"],
                      "evidence": ["XT1 on PH0/PH1"]}], "HSE crystal 8 MHz on PH0/PH1")
check(m["reserved"]["swd"] == ["PA13", "PA14"], "SWD reserved PA13/PA14")
check(m["reserved"]["boot"] == ["BOOT0"] and m["reserved"]["reset"] == ["NRST"], "BOOT0/NRST reserved")

print("== peripheral suggestions (pin maps must equal the parity ground truth) ==")
periph = {p["instance"]: p for p in m["peripherals"]}
EXPECTED = {
    "CAN1": {"RX": "PB8", "TX": "PB9"},
    "SPI3": {"SCK": "PC10", "MISO": "PC11", "MOSI": "PC12"},
    "TIM1": {"CH1": "PA8", "CH2": "PA9", "CH3": "PA10",
             "CH1N": "PB13", "CH2N": "PB14", "CH3N": "PB15"},
    "TIM8": {"CH1": "PC6", "CH2": "PC7", "CH3": "PC8",
             "CH1N": "PA7", "CH2N": "PB0", "CH3N": "PB1"},
    "TIM2": {"CH3": "PB10", "CH4": "PB11"},
    "TIM3": {"CH1": "PB4", "CH2": "PB5"},
    "TIM4": {"CH1": "PB6", "CH2": "PB7"},
    "USB_OTG_FS": {"DM": "PA11", "DP": "PA12"},
}
check(set(periph) == set(EXPECTED), f"exactly the expected instances: {sorted(EXPECTED)}")
for inst, pins in EXPECTED.items():
    check(periph[inst]["pins"] == pins, f"{inst} pins {pins}")
check(periph["TIM1"]["kind"] == "pwm-complementary" and periph["TIM8"]["kind"] == "pwm-complementary",
      "TIM1/TIM8 recognized as complementary PWM")
check(periph["TIM3"]["kind"] == "encoder" and periph["TIM4"]["kind"] == "encoder",
      "TIM3/TIM4 recognized as encoders")
for inst in ("CAN1", "SPI3", "TIM1", "TIM3", "TIM4", "TIM8", "USB_OTG_FS"):
    check(periph[inst]["confidence"] == "high", f"{inst} high confidence")
check(periph["TIM2"]["confidence"] == "low", "TIM2 (AUX H/L, weak evidence) low confidence")
pa7 = next(e for e in periph["TIM8"]["evidence"] if e["pad"] == "PA7")
check("TIM1_CH1N" in pa7["alternatives"], "PA7 records TIM1_CH1N as the losing alternative")

print("== analog ==")
analog = {a["pad"]: a for a in m["analog"]}
check(set(analog) == {"PA4", "PA5", "PA6", "PC0", "PC1", "PC2", "PC3", "PC4", "PC5"},
      "9 analog sense pads (shunt amps, temps, AUX_I, VBUS_S)")
check(analog["PC0"]["options"] == ["ADC1_IN10", "ADC2_IN10", "ADC3_IN10"],
      "PC0 offers ADC1/2/3_IN10 (instance choice left to intent)")

print("== gpio suggestions ==")
gpio = {g["pad"]: g for g in m["gpio"]}
check(gpio["PB12"]["suggest"] == {"mode": "output", "label": "EN_GATE"}, "PB12 EN_GATE output")
check(gpio["PC13"]["suggest"] == {"mode": "output", "label": "M0_nCS", "initHigh": True},
      "PC13 M0_nCS output initHigh")
check(gpio["PD2"]["suggest"]["mode"] == "input" and gpio["PD2"]["extiCandidate"],
      "PD2 nFAULT input + EXTI candidate")
check(gpio["PA0"]["confidence"] == "low" and "UART4_TX" in gpio["PA0"]["afAvailable"],
      "PA0 GPIO_1 default input, UART4_TX visible as AF option")
check(all(g["pad"] not in periph_pads
          for periph_pads in [set(p["pins"].values()) for p in m["peripherals"]]
          for g in m["gpio"]), "no pad is both a peripheral pin and a gpio suggestion")

print("== cfg seed ==")
seed = m["cfgSeed"]
check(set(seed) == {"schemaVersion", "mcu", "clock", "gpio", "debug", "project"},
      "seed carries only db-free facts")
check(seed["schemaVersion"] == 1 and seed["mcu"] == {"part": "STM32F405RGTx"}, "seed identity")
check(seed["clock"] == {"sources": {"HSE": {"kind": "crystal", "freqHz": 8_000_000}}}, "seed HSE")
check(seed["debug"] == "swd", "seed debug swd")
check(set(seed["gpio"]) == {"PA15", "PB3", "PB12", "PC9", "PC13", "PC14", "PC15", "PD2"},
      "seed gpio = medium+ confidence suggestions only")
check(all(set(v) <= {"mode", "label", "initHigh"} for v in seed["gpio"].values()),
      "seed gpio entries use only GpioPinCfg fields")
check(m["unexplained"] == [], "nothing unexplained on this board")

print(f"\nALL {_checks} CHECKS PASSED")
