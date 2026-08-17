# Board IR + STM32 config mapping — design

Date: 2026-07-06. Status: as-built.

## Problem

The schematic→firmware pipeline needs a parsing layer whose output an AI can combine
with user intent to fill in the `stm32kernel` config document
(`stm32-config-kernel/crates/engine/src/config.rs`, JSON, camelCase,
`deny_unknown_fields`). The existing `controller_map` output is deliberately
"L1 factual": it does not name MCU pads (`PA9`), does not know what a pad *can* do
(AF table), and carries no peripheral semantics. Netlists themselves are worse:
an Altium/OrCAD `.NET` has only package pin *numbers*, and (on the ODrive board)
the MCU's value field is empty — the part number appears nowhere in the file.

Three artifacts close the gap:

1. **`*_board_ir.json` (Board IR)** — the complete, factual, serialized netlist model:
   every component, every net, plus (when an MCU pin table is supplied) the
   position→pad join and per-pad traced connections. This is also the document a
   future frontend renders (selectable components/nets/pins, stable IDs).
2. **`*_stm32_map.json`** — the distilled, schema-vocabulary view: per-peripheral
   suggestions (`instance`, `pins` as `SHORT→pad`), each with evidence and
   confidence, plus gpio/analog/clock suggestions and an `unexplained` list.
3. **`*_cfg_seed.json`** — a pure, loadable `stm32kernel` ConfigDoc containing only
   facts that need no CubeMX-db knowledge: `mcu.part`, `clock.sources`, `debug`,
   high-confidence `gpio` entries. The AI merges suggestions + user intent into it,
   then iterates with `stm32kernel validate`.

Division of authority: **parser = copper facts + ranked hypotheses; AI = intent
(modes, params, instance choice where copper is silent); kernel = correctness.**

## Inputs

- Netlist: KiCad `kicadxml` XML or Altium/OrCAD PCB II `.NET` (existing parsers,
  auto-sniffed).
- MCU pin table: a `describe-mcu`-shaped JSON (`pins[].{name,position,kind,signals}`,
  `part.{refName,package,...}`, `ipInstances[]`), via:
  - `--mcu-desc <file>` (offline; canonical), or
  - `--stm32kernel <bin> [--data-dir <dir>]` (subprocess `describe-mcu <part>`).
  `tools/cubemx_to_mcudesc.py` converts an ST `STM32_open_pin_data` /CubeMX
  `db/mcu/STM32*.xml` part file into this shape (mirrors
  `stm32ck-importer` `mcu.rs` semantics: Type→kind mapping, signals incl. the
  `GPIO` pseudo-signal).
- `--part <marking>`: MCU ordering code when the netlist doesn't carry it
  (`STM32F405RGT6` → normalized `STM32F405RGTx`). KiCad `libsource.part` / value is
  used when present.

## Part identity & verification

The netlist cannot prove the part number; we verify instead: pin-count vs package,
and every `V*`-named `kind:Power` pad (VDD/VSS/VBAT/VDDA/VSSA/VREF) must sit on a
power/ground-classified net (VCAP pads excluded — they legitimately connect to
auto-named cap nets). Output: matched/mismatched lists + score; score < 0.8 warns.
Detection of the MCU component itself reuses `controller_map`'s heuristic
(`--main-controller` overrides).

## Board IR (v1) shape

```jsonc
{
  "schemaVersion": 1, "tool": "board_ir v0.1.0",
  "source": {"file": "...", "format": "altium|kicad", "board": "..."},
  "components": [{"id": "C:U2", "ref": "U2", "class": "ic", "value": "",
                  "values": ["120uF", "470uF"],      // board-variant duplicates, merged
                  "footprint": "STM-LQFP64_N", "lib": "", "part": "",
                  "sheetpath": "", "dnf": false, "pinCount": 64,
                  "pins": [{"num": "1", "name": "VCC?", "type": "power_in?", "net": "VCC|null"}]}],
  "nets": [{"id": "N:VCC", "name": "VCC", "kind": "power|ground|signal",
            "nodes": [{"ref": "U2", "pin": "1"}]}],
  "controller": { /* controller_map-style detection info */ },
  "mcu": {                                   // present iff pin table resolved
    "part": {"requested": "STM32F405RGT6", "resolved": "STM32F405RGTx",
             "package": "LQFP64", "family": "STM32F4", ...},
    "verification": {"score": 1.0, "powerChecked": n, "mismatches": []},
    "pins": [{"position": "41", "pad": "PA8", "padFull": "PA8", "kind": "Io",
              "net": "M0_AH_1", "netKind": "signal",
              "role": "signal|power|ground|crystal|swd|reset|boot|nc",
              "signals": ["I2C3_SCL", "TIM1_CH1", ..., "GPIO"],
              "connections": [ /* traced endpoints, controller_map format */ ]}]
  }
}
```

IDs (`C:<ref>`, `N:<net>`) are stable across runs (sorted, deterministic output) —
the frontend @-mention anchor. Pads are emitted **base-named** (`PA0`, not
`PA0-WKUP`; `padFull` keeps the suffix) because the kernel resolves user pads
base-first (`pinout.rs`).

## stm32_map (v1) shape

```jsonc
{
  "schemaVersion": 1,
  "mcu": {"part": "STM32F405RGTx"},
  "clock": [{"source": "HSE", "kind": "crystal", "freqHz": 8000000,
             "evidence": ["XT1 '8 MHz' on PH0/PH1"]}],
  "peripherals": [
    {"instance": "TIM1", "kind": "pwm-complementary", "confidence": "high",
     "pins": {"CH1": "PA8", "CH1N": "PB13", ...},           // SHORT signal → bare pad
     "modeHint": "3-phase complementary PWM (CubeMX F4 leaves: 'PWM Generation1 CH1 CH1N' …)",
     "evidence": [{"pad": "PA8", "net": "M0_AH_1", "signal": "TIM1_CH1",
                   "reasons": ["net-token:AH", "endpoint:U4 (gate driver)",
                               "instance-set:6/6 channels"], "alternatives": []}]},
    ...
  ],
  "gpio": [{"pad": "PB12", "suggest": {"mode": "output", "label": "EN_GATE"},
            "confidence": "medium", "evidence": [...]}],
  "analog": [{"pad": "PC0", "net": "M0_SO1_1", "options": ["ADC1_IN10", "ADC2_IN10", "ADC3_IN10"],
              "evidence": [...]}],                          // ADC instance choice = intent
  "reserved": {"swd": ["PA13", "PA14"], "boot": ["PB..|BOOT0"], "reset": ["NRST"]},
  "unexplained": [{"pad": "...", "net": "...", "note": "..."}],
  "cfgSeed": { /* the pure ConfigDoc, duplicated into *_cfg_seed.json */ }
}
```

Why suggestions aren't a ConfigDoc: `peripherals.*.mode` values are CubeMX
mode-tree leaves (db data the parser doesn't have), and instance choice for ADC
(and pin-stacked UART/EXTI double-use) is firmware intent. Suggestions carry
schema-*vocabulary* (`instance` keys, SHORT signal names, bare pads) so the AI's
merge is mechanical; correctness is enforced by `stm32kernel validate`
(diagnostics have JSON Pointer paths + suggestions, designed for the LLM loop).

## Inference rules (deterministic, ordered)

1. **Roles**: net kind power/ground → power pins; `kind:Reset/Boot` pads; crystal =
   `padFull` contains `OSC_IN/OSC_OUT` (or `OSC32`) AND net reaches a crystal-class
   component (`XT|Y|X` refdes; value parsed `8 MHz|8MHz|25.000M` → Hz) → HSE/LSE
   source; SWD = signals contain `SYS_JTMS-SWDIO`/`SYS_JTCK-SWCLK` (net names
   corroborate); single-node or missing net → `nc`.
2. **Evidence per signal pin**: net base name (Altium sheet suffix `_<n>` stripped),
   tokens matched against a keyword table (SCK/MISO/MOSI/SS, SCL/SDA, TX/RX,
   DM/DP, CAN+R/D, ENC+A/B/Z, AH..CL/HIN/LIN, SO/TEMP/SENSE/VBUS/_I, nCS, FAULT…);
   traced endpoint classes (usb connector, transceiver IC, gate driver, LED, header).
3. **Candidate filter**: a suggestion may only bind a pad to a signal the pad's AF
   table (`signals[]`) actually offers — evidence picks *among* candidates, never
   invents.
4. **Instance grouping**: candidates grouped by instance; score = per-pin evidence +
   set-coherence bonuses (CHx/CHxN complementary sets, ENC CH1+CH2 pairs, SPI
   SCK+MISO+MOSI triples, CAN/UART TX+RX pairs, USB DM+DP). Greedy assignment by
   descending score; consumed pads removed; losers recorded as `alternatives`.
5. **Fallbacks**: analog-capable pads with analog-ish nets → `analog` options;
   everything else → `gpio` suggestion (label = net base name; mode heuristics:
   gate-driver EN / nCS → output (nCS initHigh), FAULT/IRQ + pull-up → input,
   LED → output; default input @ low confidence).

## Module layout (all inside `controller_map`, additive)

- `netlist_model.py`: `_Comp` gains `values: tuple[str, ...] = ()` (variant merge).
- `altium_parser.py`: header disambiguation (trailing-space rule first, then 3-token,
  then refdes-scan), decode chain utf-8→GBK→latin-1, duplicate-refdes variant merge.
- `mcu_desc.py` (new): load/normalize describe-mcu JSON, part normalization,
  position join, verification.
- `board_ir.py` (new): IR builder + CLI `board_ir`.
- `stm32_map.py` (new): inference + `stm32_map.json` + `cfg_seed.json` emission.
- `tools/cubemx_to_mcudesc.py` (new): fixture/offline converter.
- Tests: `tests/check_board_ir.py`, `tests/check_stm32_map.py` (plain-assert style),
  fixtures: ODrive `.NET` copy + `STM32F405RGTx.mcudesc.json`.

Existing `controller_map` / `connections` CLIs and their output schemas are
untouched; existing checks must stay green.

## Acceptance (ODrive `two_ax_PCB(1).NET` + F405 pin table)

Netlist-derived expected results (cross-checked against
`stm32-config-kernel/tests/parity/odrive/odrive.json` where board revisions agree):
part `STM32F405RGTx` verified; HSE crystal 8 MHz; `debug: swd`;
`USB_OTG_FS {DM: PA11, DP: PA12}`; `CAN1 {RX: PB8, TX: PB9}`;
`SPI3 {SCK: PC10, MISO: PC11, MOSI: PC12}`;
`TIM1 {CH1: PA8, CH2: PA9, CH3: PA10, CH1N: PB13, CH2N: PB14, CH3N: PB15}`;
`TIM8 {CH1: PC6, CH2: PC7, CH3: PC8, CH1N: PA7, CH2N: PB0, CH3N: PB1}`;
encoders `TIM3 {CH1: PB4, CH2: PB5}`, `TIM4 {CH1: PB6, CH2: PB7}`;
aux `TIM2 {CH3: PB10, CH4: PB11}`; gpio incl. `PB12 EN_GATE (output)`,
`PD2 nFAULT (input)`, `PC13/PC14 M0/M1_nCS (output)`; analog pads
PC0–PC3 (shunt amps), PA4/PC5 (temps), PA5 (AUX_I), PA6 (VBUS_S), PC4 (AUX_TEMP).
Board-revision deltas vs odrive.json (ENC_Z / DC_CAL / GPIO_5-8 placement) are
expected and asserted from the netlist, not the parity file.

## Out of scope (this iteration)

Geometry/rendering (netlists carry none; future `.kicad_sch`/`.SchDoc` work),
datasheet RAG, the opencode TS tool wrapper (`yoma-config/tool/netlist_parse.ts`,
recipe documented in integration recon), non-STM32 targets (the Board IR layer is
target-neutral; only `stm32_map.py` is STM32-specific).
