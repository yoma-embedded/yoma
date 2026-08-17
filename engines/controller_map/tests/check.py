"""Reproducible verification for controller_map (this project has no pytest convention).

Runs the tool on both committed fixtures and asserts facts derived independently from the
netlists. Run:  uv run python tests/check.py
Exits non-zero on the first failed assertion.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from controller_map.controller_map import create_controller_map

FIX = Path(__file__).parent / "fixtures"
DEVNULL = Path(os.devnull)  # "/dev/null" breaks on Windows
_checks = 0


def check(cond: bool, msg: str) -> None:
    global _checks
    _checks += 1
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        raise SystemExit(1)
    print(f"  ok: {msg}")


def pin(cmap, num):
    return next((p for p in cmap.signal_pins if p.pin == num), None)


def traced_dsts(p):
    """Set of traced destinations as 'REF.PIN' or 'RAIL:name'."""
    out = set()
    for t in p.traced:
        out.add(f"RAIL:{t.rail}" if t.endpoint is None else f"{t.endpoint.ref}.{t.endpoint.pin}")
    return out


print("== RP2040 (KiCad) ==")
rp = create_controller_map(FIX / "RP2040_kicad_netlist.xml", DEVNULL)
check(rp.format == "kicad", "format is kicad")
check(rp.controller.ref == "U3" and "RP2040" in rp.controller.part, "controller is U3 / RP2040")
check(rp.runner_up is not None and rp.runner_up.ref == "U2", "runner-up is U2 (flash)")
check(len(rp.signal_pins) == 43, f"43 signal pins (got {len(rp.signal_pins)})")
check(pin(rp, "2").pin_name == "GPIO0" and traced_dsts(pin(rp, "2")) == {"J3.4"},
      "GPIO0 (pin 2) traces directly to J3.4")
check(pin(rp, "47").pin_name == "USB_DP" and traced_dsts(pin(rp, "47")) == {"J1.3"},
      "USB_DP (pin 47) traces through R3 to J1.3")
check(pin(rp, "47").traced[0].via[0].ref == "R3" and pin(rp, "47").traced[0].via[0].value == "27",
      "USB_DP via is R3 27R")
check(traced_dsts(pin(rp, "56")) == {"U2.1", "J2.1", "RAIL:+3V3"},
      "QSPI_SS (pin 56) fans to U2.1, J2.1, and the +3V3 rail")
check(any(t.dnf and t.rail == "+3V3" for t in pin(rp, "56").traced),
      "QSPI_SS pull-up via R2 is flagged DNF and terminates on +3V3")
check(traced_dsts(pin(rp, "20")) == {"Y1.1"},
      "XIN (pin 20) traces only to crystal Y1.1 (stub load cap C2 excluded from traced)")
check(any(nd.ref == "C2" for nd in pin(rp, "20").direct_nodes),
      "XIN still lists C2 in direct_nodes (raw truth)")

print("== Nordic (Altium) — auto-detect ==")
na = create_controller_map(FIX / "pca10056.NET", DEVNULL)
check(na.format == "altium", "format is altium")
check(na.controller.ref == "U2" and "nRF5340" in na.controller.part, "auto picks U2 / nRF5340 (most pins)")
check(na.low_confidence is True, "low_confidence flagged (two MCUs, 98 vs 74 pins)")
check(na.runner_up is not None and na.runner_up.ref == "U1", "runner-up is U1 / nRF52840")

print("== Nordic (Altium) — override U1 (nRF52840) ==")
nu = create_controller_map(FIX / "pca10056.NET", DEVNULL, main_controller="U1")
check(nu.controller.ref == "U1" and "nRF52840" in nu.controller.part, "override gives U1 / nRF52840")
check(nu.controller.detected_by == "override", "detected_by == override")
check(len(nu.signal_pins) == 64, f"64 signal pins (got {len(nu.signal_pins)})")
dp = next(p for p in nu.signal_pins if p.net == "D_P")
check("J3.3" in traced_dsts(dp), "D_P reaches MicroUSB J3.3")
p026 = next(p for p in nu.signal_pins if p.net == "P0.26")
check(any(t.via and t.via[0].ref == "R1" and "U7.8" == f"{t.endpoint.ref}.{t.endpoint.pin}"
          for t in p026.traced if t.endpoint),
      "P0.26 routes through R1 (0R) to analog switch U7.8")
nfc = next(p for p in nu.signal_pins if p.net == "P0.10/NFC2")
check(any(t.dnf for t in nfc.traced), "NFC2 has a DNF (N.C. resistor) branch flagged")

p013 = next(p for p in nu.signal_pins if p.net == "P0.13")
check(any(t.via and t.via[0].kind == "solderbridge" and t.endpoint and t.endpoint.ref == "LED1"
          for t in p013.traced),
      "P0.13 traces through a CLOSED solder bridge (SB5) to LED1")
p019 = next(p for p in nu.signal_pins if p.net == "P0.19")
check(any(t.via == () and t.endpoint and t.endpoint.ref.startswith("SB") for t in p019.traced),
      "P0.19 still has an OPEN solder bridge (SB21) as a bare endpoint (not traced through)")
check(any(t.via and t.via[0].kind == "solderbridge" for t in p019.traced),
      "P0.19 also traces through its CLOSED bridge (SB11) to the flash")

print("== STM32 (KiCad legacy EESchema .net) ==")
ee = create_controller_map(FIX / "stm32_eeschema_legacy.net", DEVNULL)
check(ee.format == "eeschema", "format is eeschema")
check(ee.controller.ref == "U1" and "STM32G031" in ee.controller.part,
      "controller is U1 / STM32G031 (MCU regex on value)")
check({p.pin for p in ee.signal_pins} == {"4", "5", "6", "7"},
      f"power pins filtered incl. hierarchical /Power/D+3V3 (got {sorted(p.pin for p in ee.signal_pins)})")
check(pin(ee, "4").net == "/LED_CTRL" and traced_dsts(pin(ee, "4")) == {"D2.1"},
      "LED_CTRL (pin 4) traces through R1 ($noname footprint) to D2.1")
check(pin(ee, "4").traced[0].via[0].ref == "R1" and pin(ee, "4").traced[0].via[0].kind == "resistor",
      "via is R1, kind resistor")
check(pin(ee, "5").direct_nodes[0].value == "Red LED 0603", "value with spaces parsed (D1)")
check(pin(ee, "6").net.startswith("unconnected-") and pin(ee, "6").traced == (),
      "unconnected pin kept, empty trace")
check(traced_dsts(pin(ee, "7")) == {"J1.1"}, "UART_TX reaches J1.1 (empty-value header parsed)")

print(f"\nALL {_checks} CHECKS PASSED")
