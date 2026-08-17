"""Endpoint-device actuator inference (task #20): DRV8871/servo/LED board with zero
protocol tokens. Expected values are the real pipeline outputs on the committed
sumobot_eeschema.net fixture + F103C8 pin table (post PB3 pad-name-join fix: the
board has SEVEN LED loads incl. PB3//LED103).

Run:  uv run python tests/check_actuators.py
Opt-in corpus scan:  set NETLIST_CORPUS=<dir of .net files> first (zero-crash gate).
Exits non-zero on the first failed assertion.
"""

from __future__ import annotations

import os
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


desc = load_mcu_desc(FIX / "STM32F103C8Tx.mcudesc.json")
ir, _, _ = build_board_ir(FIX / "sumobot_eeschema.net", desc, "STM32F103C8Tx", "user")
m = build_stm32_map(ir, desc)
periph = {p["instance"]: p for p in m["peripherals"]}

# 1. exactly the three inferred TIMs, nothing else
check(set(periph) == {"TIM2", "TIM3", "TIM4"}, "sumobot peripherals are TIM2/TIM3/TIM4 only")
# 2-4. pin maps, kind, confidence
check(periph["TIM2"]["pins"] == {"CH3": "PA2", "CH4": "PA3"} and periph["TIM2"]["kind"] == "pwm"
      and periph["TIM2"]["confidence"] == "medium", "U1 DRV8871 IN pins -> TIM2 CH3/CH4 medium")
check(periph["TIM4"]["pins"] == {"CH3": "PB8", "CH4": "PB9"} and periph["TIM4"]["confidence"] == "medium",
      "U2 DRV8871 IN pins -> TIM4 CH3/CH4 medium")
check(periph["TIM3"]["pins"] == {"CH3": "PB0", "CH4": "PB1"} and periph["TIM3"]["confidence"] == "medium",
      "servo headers share TIM3 CH3/CH4 (plain CH preferred over TIM1_CHxN)")
# 5. evidence format aligned with existing suggestions
ev = periph["TIM2"]["evidence"][0]
check(set(ev) == {"pad", "position", "net", "signal", "score", "reasons", "alternatives"},
      "evidence rows carry the standard keys")
check(ev["signal"] == "TIM2_CH3" and ev["score"] == 2
      and ev["reasons"] == ["endpoint:motor-driver(U1 DRV8871DDAR)"], "reason string format endpoint:cat(ref value)")
check(any(e["reasons"] == ["endpoint:servo(S1 Servo)"] for e in periph["TIM3"]["evidence"]),
      "servo evidence names the header")
check(next(e for e in periph["TIM3"]["evidence"] if e["pad"] == "PB0")["alternatives"] == ["TIM1_CH2N"],
      "PB0 records TIM1_CH2N as the losing alternative")
check(periph["TIM2"]["modeHint"].startswith("PWM/output-compare"), "pwm modeHint attached")
# 6. direction/power guard: no suggested pad sits on a power/ground-role pin; no rail nets in evidence
power_pads = {p["pad"] for p in ir["mcu"]["pins"] if p["role"] in ("power", "ground")}
sugg_pads = {pad for p in m["peripherals"] for pad in p["pins"].values()}
check(not (sugg_pads & power_pads), "no PWM suggestion on a power-role pin")
check(all(e["net"] not in ("9V", "5V", "VBAT", "GND") for p in m["peripherals"] for e in p["evidence"]),
      "no rail net cited as PWM evidence")
# 7-8. non-actuator endpoints untouched
gpio = {g["pad"]: g for g in m["gpio"]}
check(all(pad in gpio for pad in ("PB10", "PB11", "PB12", "PB13", "PB14")),
      "distance-sensor pads stay gpio (connector w/o actuator identity)")
check(all(pad in gpio for pad in ("PA4", "PA5", "PA6", "PA7")), "DIP-switch pads stay gpio inputs")
check(gpio["PA0"]["suggest"]["mode"] == "output" and gpio["PA0"]["evidence"][0] == "LED load"
      and gpio["PA0"].get("pwmOptions") == ["TIM2_CH1"], "LED stays gpio output + pwmOptions listed")
check(gpio["PB3"]["suggest"] == {"mode": "output", "label": "LED103"}
      and gpio["PB3"]["evidence"][0] == "LED load" and gpio["PB3"].get("pwmOptions") == ["TIM2_CH2"],
      "PB3 (recovered /LED103) is the 7th LED: gpio output + TIM2_CH2 pwmOption")
# 9. seed unchanged: no TIM, same gpio keys as before the feature
seed = m["cfgSeed"]
check(set(seed) == {"schemaVersion", "mcu", "gpio", "project"}, "seed keys unchanged (db-free facts only)")
check(set(seed["gpio"]) == {"PA0", "PA1", "PA8", "PA15", "PB3", "PB4", "PB5"},
      "seed gpio = the 7 LED outputs only")
# 10. ODrive regression: actuator pass adds nothing on a token-rich board
d2 = load_mcu_desc(FIX / "STM32F405RGTx.mcudesc.json")
ir2, _, _ = build_board_ir(FIX / "odrive_two_ax.NET", d2, "STM32F405RGT6", "user")
m2 = build_stm32_map(ir2, d2)
check({p["instance"] for p in m2["peripherals"]} ==
      {"CAN1", "SPI3", "TIM1", "TIM2", "TIM3", "TIM4", "TIM8", "USB_OTG_FS"},
      "ODrive instance set unchanged (DRV8301 gate driver excluded, EN_GATE/nCS/nFAULT vetoed)")
check({g["pad"] for g in m2["gpio"]} >= {"PB12", "PC13", "PD2"}, "ODrive EN_GATE/nCS/nFAULT still gpio")
# 11. corpus zero-crash scan (opt-in; corpus lives outside the repo)
corpus = os.environ.get("NETLIST_CORPUS")
if corpus:
    from controller_map.controller_map import _load_netlist, _detect_controller, _trace_pin, _is_power_pin
    from controller_map.stm32_map import _classify_endpoint
    n = 0
    for path in sorted(Path(corpus).glob("*.net")):
        nl, _ = _load_netlist(path)
        ctrl, _, _ = _detect_controller(nl)
        for pin in nl.pins_of.get(ctrl, set()):
            net = nl.net_of[ctrl].get(pin)
            if net is None or _is_power_pin(nl, ctrl, pin, net):
                continue
            for t in _trace_pin(nl, ctrl, net):
                if t.endpoint:
                    _classify_endpoint({"ref": t.endpoint.ref, "value": t.endpoint.value,
                                        "pin_name": t.endpoint.pin_name}, None)
        n += 1
    check(n >= 38, f"corpus scan: {n} netlists, no exception")

print(f"\nALL {_checks} CHECKS PASSED")
