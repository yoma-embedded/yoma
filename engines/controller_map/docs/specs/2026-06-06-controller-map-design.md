# DESIGN SPEC: `controller_map` — controller-pin connection extractor

> Status: design, awaiting implementation. Standalone project at
> `/Users/ben/embedded_agents/sch_read/controller_map/`, independent of the
> `kicad_firmware_generation` repo. Grounded against the real board
> `RP2040_minimal_r2` (netlist in `../minimal/RP2040_kicad_netlist.xml`).

## 1. Purpose & non-goals

### Purpose
`controller_map` answers one question with **zero user annotation**: *for the main
controller on a KiCad board, where does each signal pin actually go?* It reads the
`kicadxml` netlist directly (the file `kicad-cli sch export netlist --format kicadxml`
produces), auto-detects the main controller, and for every signal pin emits both the
**raw direct net** (everything sharing the pin's net) and the **pass-through-traced
endpoints** (the meaningful sinks reached through series passives — resistors, ferrites,
AC-coupling caps). Output is JSON.

This tool exists because the existing `kicad_firmware_generation` pipeline requires
per-component `GroupType` annotations in KiCad that most schematics lack.
`controller_map` deliberately bypasses the Group abstraction entirely and is a separate,
self-contained project.

### Non-goals (YAGNI — explicitly out of scope)
- **No Group abstraction, no `common_types` dependency, no dependency on the other repo.**
  It does not produce or consume a Group Netlist. It has its own focused parser.
- **No KiCad invocation.** The user runs `kicad-cli` themselves; we consume its XML.
- **No multi-controller mapping.** Exactly one controller is detected and reported. A
  board with two MCUs reports the highest-scoring one (and warns).
- **No power/ground report in v1.** Signal pins only. Power/ground is excluded, but the
  classifier already runs over all pins (§7), so a `power` section can be added later
  behind a flag.
- **No net-to-net electrical simulation, no impedance/timing analysis, no DRC.**
  Pass-through tracing is topological only.
- **No CSV, no SVG, no merging.**
- **No writing of any intermediate XML.** The only artifact is the JSON.
- **No support for non-`kicadxml` formats** (no `orcad`, no `spice`, no raw `.kicad_sch`).
- **No Jinja2 template path in v1.** The model is plain dataclasses, which is all that is
  needed to keep that door open later; if a renderer is wanted, it is a trivial mirror of
  the existing repo's `code_gen.py`. No stub file, no pre-designed renderer API ships now.
- **No third-party runtime dependency in v1.** Standard library only
  (`xml.etree`, `json`, `argparse`, `dataclasses`, `re`, `pathlib`).

## 2. Project layout (standalone uv project)

A brand-new, self-contained project. Flat package layout matching the
`kicad_firmware_generation` repo's style (package dir at project root), so it is familiar
but fully independent:

```
controller_map/                      # project root (NEW, in parent dir)
  pyproject.toml                     # standalone; name="controller_map"; build-system=setuptools; no runtime deps
  uv.lock                            # created by `uv sync`
  README.md
  .gitignore
  controller_map/                    # the package
    __init__.py
    kicad_parser.py                  # focused kicadxml parser -> throwaway _Kicad*/_ types
    controller_map.py                # model + detection + tracing + power classifier + orchestrator + CLI main()
  tests/
    fixtures/RP2040_kicad_netlist.xml   # committed copy of the real board (reproducible verification)
    check.py                            # runnable verification asserts (the repo has no pytest convention; keep it a plain script)
  docs/
    specs/2026-06-06-controller-map-design.md   # this file
```

`kicad_parser.py` mirrors the existing repo's `kicad_netlist_xml.py` / `kicad_types.py`
split (parser plus throwaway types). Everything else — detection tuple, data model,
tracer, power classifier, orchestrator, `main()` — lives in `controller_map.py`, matching
how the other tools in the reference repo are structured (cf. `code_gen.py` ~140 lines,
`netlist_to_csv.py` ~206 lines).

Per that convention, `main()` is a thin `argparse` wrapper over a single orchestrator
function `create_controller_map(...)` taking the same parameters, so the tool is
programmatically drivable.

```toml
# pyproject.toml (standalone)
[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "controller_map"
version = "0.1.0"
description = "Extract main-controller pin connections from a KiCad kicadxml netlist"
requires-python = ">3.13"
dependencies = []                     # stdlib only in v1

[tool.setuptools]
packages = ["controller_map"]

[project.scripts]
controller_map = "controller_map.controller_map:main"
```

Set up with `uv` (own `.venv` + `uv.lock`), `uv run controller_map ...`. Fully
type-annotated, strict.

## 3. KiCad XML parsing scope

`kicad_parser.py` uses `xml.etree.ElementTree` and reads **only** these
elements/attributes. All produced types are throwaway internal scaffolding (prefixed
`_`), never serialized.

| XPath | Attrs / text read | Purpose |
|---|---|---|
| `./design/source` (text) | — | board name (transformed, see below). |
| `./components/comp` | `@ref` | component identity. |
| `./components/comp/value` (text) | — | component value (`27`, `1k`, `DNF`, `W25Q128JVS`). |
| `./components/comp/libsource` | `@lib`, `@part` | library/part → controller heuristic + libpart resolution. |
| `./components/comp/sheetpath` | `@names` | sheetpath, recorded but not used for selection in v1. |
| `./libparts/libpart` | `@lib`, `@part` | match to a comp's `libsource`. |
| `./libparts/libpart/pins/pin` | `@num`, `@name`, `@type` | clean pin names (no KiCad-10 suffix) + electrical type. |
| `./nets/net` | `@name` | net identity. |
| `./nets/net/node` | `@ref`, `@pin`, `@pinfunction` | net membership; `pinfunction` is fallback naming only. |

**Board name transformation.** `./design/source` is an **absolute path** (verified:
`/Users/.../RP2040_minimal_r2/RP2040_minimal_r2.kicad_sch`). The emitted `source` field is
`Path(<design/source text>).stem` — the basename without the `.kicad_sch` extension,
yielding `RP2040_minimal_r2`. Used in both §3 and §5/§8; rule and example agree.

**Pin-count source (format-robust).** Pin counts for detection come from the **libpart**
pin list (`./libparts/libpart[match]/pins/pin`), counted by `@num`. Do **not** rely on
`comp/units/unit/pins/pin` vs `comp/pins/pin` nesting differences across KiCad versions —
the libpart pin list is present and version-stable in both KiCad-8-era and KiCad-10
exports, and is also the clean-name source we already need. (Verified: RP2040 libpart has
57 pins.)

Throwaway internal types (illustrative):

```python
_Ref     = NewType("_Ref", str)
_PinNum  = NewType("_PinNum", str)   # KiCad pin number, e.g. "2", "57"
_NetName = NewType("_NetName", str)

@dataclass(frozen=True)
class _LibPin:  num: _PinNum; name: str; type: str    # type e.g. "power_in","bidirectional","passive"
@dataclass
class _LibPart: lib: str; part: str; pins: dict[_PinNum, _LibPin]
@dataclass
class _Comp:    ref: _Ref; value: str; lib: str; part: str; sheetpath: str
@dataclass(frozen=True)
class _Node:    ref: _Ref; pin: _PinNum; pinfunction: str | None
@dataclass
class _Net:     name: _NetName; nodes: frozenset[_Node]

@dataclass
class _Netlist:
    source: str                                 # already transformed to Path(...).stem
    comps: dict[_Ref, _Comp]
    libparts: dict[tuple[str, str], _LibPart]   # keyed (lib, part)
    nets: list[_Net]
    # derived indices, built once:
    net_of: dict[_Ref, dict[_PinNum, _NetName]] # ref -> pin -> net
    net_nodes: dict[_NetName, list[_Node]]      # net -> nodes
    pins_of: dict[_Ref, set[_PinNum]]           # connected-pin set per ref
```

`pinfunction` is stored but treated as nullable; only ~152/196 nodes carry it on this
board (passives never do).

## 4. Controller auto-detection

Zero user input by default. Layered, transparent scoring; **never gate on a single rule**.

### Candidate set
All components that have a resolvable libpart with ≥1 pin. Do **not** hard-filter to `ref`
starting with `U` — keep ref-prefix as a *soft* score signal so ICs ref'd `IC`/`A`
survive, and so a connector mis-ref'd as `U*` doesn't win on pin count alone.

### Score (lexicographic tuple, pick the max)
```
score(c) = (lib_is_mcu, ref_is_ic, pin_count)
  lib_is_mcu  = c.lib.startswith("MCU_")        # MCU_RaspberryPi_RP2040, MCU_ST_STM32*, ...
  ref_is_ic   = leading_alpha(c.ref) in {"U","IC","A"} and not c.ref.startswith("#")
  pin_count   = len(libpart.pins)               # includes exposed pad
```
`ref_is_ic` is the set `{U, IC, A}` (not bare `U`) so an MCU-class IC ref'd `IC2`/`A1`
without an `MCU_` lib still gets the IC bonus. Tie-break order is exactly the tuple order:
`MCU_*` beats everything; among non-MCU, IC beats non-IC; final tie-break is pin count.
Full-tuple ties broken by `ref` ascending (deterministic).

On `RP2040_minimal_r2`: `U3 RP2040 = (1, True, 57)`, `U2 W25Q128JVS = (0, True, 8)`,
`U1 NCP1117 = (0, True, 3)`; the 36-pin `J3/J4` headers score `(0, False, 36)` and lose to
U3 on the first tuple element. **Winner: U3.** Verified.

### What it prints (always, to stderr)
```
Auto-detected main controller: U3 RP2040 (MCU_RaspberryPi_RP2040, 57 pins).
  Runner-up: U2 W25Q128JVS (Memory_Flash, 8 pins).
```

### Confidence warning (stderr)
Emit `WARNING: low-confidence controller detection` when **any** of:
- no candidate has `lib_is_mcu = True`, **or**
- the top two candidates share the same `lib_is_mcu` bucket **and**
  `top.pin_count < 1.5 * runner_up.pin_count`.

Loudly flags FPGA/SoM/multi-MCU boards where pin count is a weak proxy.

### Escape hatch (kept, ref-exact only)
A single optional flag `--main-controller <ref>` overrides detection by **exact `ref`
match**. Default remains pure zero-input auto-detect. No glob mode in v1. If the named ref
does not exist, error to stderr and exit non-zero.

## 5. Connection data model

Frozen `@dataclass`es in `controller_map.py`. This is the serialized model.

```python
@dataclass(frozen=True)
class NodeRef:
    ref: str            # "J1"
    pin: str            # KiCad pin number, "2"
    pin_name: str       # resolved name, "D-" / "Pin_4" / "1" (may be generic; see priority)
    value: str          # comp value, "USB_B_Micro"

@dataclass(frozen=True)
class ViaPart:
    ref: str            # series passive crossed, "R4"
    value: str          # "27"
    pin_in: str         # entered on this pin number
    pin_out: str        # exited on this pin number
    kind: str           # "resistor"|"inductor"|"ferrite"|"cap_series"
    dnf: bool           # value == "DNF" (case-insensitive) -> path physically open

@dataclass(frozen=True)
class TracedEndpoint:
    via: tuple[ViaPart, ...]   # ordered series parts crossed (empty == direct)
    endpoint: NodeRef | None   # the sink; None iff terminated on a rail
    rail: str | None           # set iff terminated on power/gnd, e.g. "+3V3"; else None
    dnf: bool                  # any via on this path is DNF -> path open

@dataclass(frozen=True)
class ControllerPin:
    pin: str                            # "46"
    pin_name: str                       # "USB_DM" (libpart-first)
    net: str                            # "Net-(U3-USB_DM)"
    direct_nodes: tuple[NodeRef, ...]   # every OTHER node on `net`
    traced: tuple[TracedEndpoint, ...]  # pass-through-traced sinks (BOTH emitted)

@dataclass(frozen=True)
class ControllerInfo:
    ref: str; part: str; lib: str; pin_count: int
    detected_by: str           # "auto" | "override"

@dataclass(frozen=True)
class RunnerUp:
    ref: str; part: str; lib: str; pin_count: int

@dataclass(frozen=True)
class ControllerMap:
    tool: str                  # "controller_map v0.1.0"
    source: str                # board name = Path(./design/source).stem
    controller: ControllerInfo
    runner_up: RunnerUp | None
    low_confidence: bool
    signal_pins: tuple[ControllerPin, ...]    # sorted by int(pin)
    # power_pins reserved for a future --include-power flag; absent in v1 JSON (see §7).
```

**`direct_nodes` and `traced` are both intentionally emitted per pin.** They answer
different questions: `direct_nodes` is raw, unfiltered net membership (including stub
passives like `R1.1`/`R2.2` on `QSPI_SS`); `traced` is the resolved set of meaningful
sinks reached through those passives (`J2`, the `+3V3` rail). The overlap in the common
direct case (a `GPIO→J3` pin lists `J3` in both) is accepted; both ship.

### Pin-name resolution priority (per controller pin and per endpoint node)
1. **libpart name** by `(lib, part)` → `pins[pin_num].name`, if non-empty. Taken
   **as-is** — including generic tokens like `Pin_4` or a bare number `1`. (No
   "skip-generic, fall through" branch: on real connectors/crystals the pinfunction is the
   *same* generic token plus the KiCad-10 suffix — `J3.4` pinfunction `Pin_4_4` strips to
   `Pin_4`; `Y1.1` `1_1` strips to `1` — so a fallthrough only re-reaches the identical
   string.) Connector/crystal endpoints legitimately retain generic names; expected, not a
   failure. Collision-correct and version-independent (libpart never carries the KiCad-10
   `_<pinnum>` suffix). For the controller it gives clean names: `GPIO0`, `XIN`,
   `QSPI_SD0`, `USB_DM`, `ADC_AVDD`.
2. **`pinfunction`** from the net node (used only when the libpart name is empty), with the
   KiCad-10 suffix stripped **only** by
   `re.sub(r'_' + re.escape(node.pin) + r'$', '', pinfunction)` — anchored to *this node's
   own pin number*. Never the greedy `_.+$` (which over-strips `ADC_AVDD_43`→`ADC` and
   collapses `QSPI_*`→`QSPI`). Per-node, not gated on the export `version` attribute (this
   board is `version="E"` yet has the suffix). **Residual risk (documented):** on a board
   *lacking* the suffix, a legitimate pinfunction genuinely ending in `_<pin>` (e.g. real
   `GPIO_2` on pin 2) would be over-stripped. Safe here because all meaningful controller
   names come from the libpart (priority 1); note it if it surfaces.
3. **bare pin number** (passives whose libpart names are empty and carry no pinfunction).

## 6. Pass-through tracing algorithm

A **fan-out DFS over NETS**, keyed off the controller's signal pins. Connections are nets
(frozensets of nodes), not edges.

### Prefix classification (`re.match(r'^[A-Za-z]+', ref)`)
- **Pass-through hop candidates:** prefix in `{R, L, FB, FL}` **always**; prefix `C`
  **conditionally** (cap rule). A part is a hop **iff** it has exactly 2 connected pins
  (`len(pins_of[ref]) == 2`). Anything with ≠2 connected pins is never a hop.
- **Sink/endpoint prefixes:** `{J, U, Y, X, D, SW, Q, K}`. Reaching one emits a completed
  path. The controller itself is a sink only at depth 0.

### Cap series-vs-stub rule (the critical distinction)
For a 2-pin capacitor reached on `pinA`, inspect the **other** pin's net:
- other net is **power/gnd** ⇒ decoupling/**stub** cap ⇒ **terminate**, do not trace
  through and do not emit it as an endpoint.
- other net is a **signal** net ⇒ **series** (AC-coupling) cap ⇒ trace through
  (`kind="cap_series"`).

Resistors/inductors/ferrites **always** trace through regardless of the far net — a
pull-up/pull-down to a rail is a meaningful terminal (handled by rail-termination below).

**Validation coverage:** all 17 capacitors on this board are stubs (one terminal on
`GND/+3V3/+1V1/VBUS`). The `cap_series` / AC-coupling path is **designed but unexercised by
this fixture**. Implement to spec; do not claim it validated.

### Power-net classification (drives the cap rule and rail termination)
`is_power_net(name)` is a plain hardcoded function (no CLI knob in v1; trivially editable).
Strip a leading `/`, uppercase, then True iff:
- in the GND set `{GND, GNDA, GNDD, AGND, DGND, PGND, SGND, VSS, VSSA, VEE}`, or
- in the rail set `{VBUS, VCC, VDD, VBAT, VIN, VDDA, VREF, VDDIO}`, or
- starts with `+` or `-`, or
- matches anchored `^[+-]?\d+\.?\d*V\d*$` (covers `+3V3`, `+1V1`, `+5V`, `3V3`, `5V0`, `-12V`).

Anchoring avoids misflagging composite signal names like `VDD_EN`. On this board this
flags exactly `+1V1, +3V3, GND, VBUS`.

**Biggest correctness dependency — loud caveat.** This board has **zero** `#PWR`/`#FLG`
power-flag symbols, so power-net classification rests *entirely* on the net-name
regex/sets above. On a schematic that both (a) names a rail unconventionally **and**
(b) omits `#PWR` symbols, both the cap-stub rule and rail-termination silently fail: every
decoupling cap becomes a traced endpoint and the trace fans into the rail's consumers.
This is the single largest correctness risk. If `is_power_net` ever misclassifies in
practice, that is the moment to add a `--power-net-regex` override (one `argparse` line) —
not added speculatively in v1.

### Rail-termination rule (resistor analogue of the cap-stub rule)
When a hop lands on a power/gnd net, **stop and emit one synthetic endpoint**
(`endpoint=None`, `rail="<netname>"`). Do **not** fan out into the rail's consumers. This
collapses `U3.56 →R2(DNF)→ +3V3` into a single "pull-up to +3V3".

### Branching
A net may hold many nodes (`/QSPI_SS` = U3.56, U2.1, R1.1, R2.2). From a net, examine
**every other node**: each sink node is its own completed `TracedEndpoint`; each distinct
passive hop spawns its own continued branch. One controller pin can yield multiple traced
endpoints.

### Guards (all mandatory)
- **visited-net set** (net names, not pins) along the current path — never re-enter a net.
- **`came_from_ref`** — never bounce back through the passive just crossed.
- **`MAX_HOP_DEPTH = 4`** depth cap as cheap defense-in-depth. On exceeding it, **stop the
  branch and emit a stderr warning** naming the controller pin and current path. Do **not**
  inject a synthetic sentinel `ViaPart` into the output — keep the data model clean. No
  in-scope board reaches even depth 2.

### DNF
`value == "DNF"` (case-insensitive) on any via ⇒ `ViaPart.dnf = True` and
`TracedEndpoint.dnf = True`. Still emit the path (topology exists); the flag tells callers
the board is physically open there (e.g. R2, the unpopulated CS pull-up).

### Per-pin procedure
For each signal pin `p` of the controller on net `N`:
1. `direct_nodes` = every node on `N` except the controller's own.
2. `traced` = `dfs(net=N, came_from_ref=controller.ref, via=(), depth=0)`, fanning out per
   the rules above. A node reached on `N` with no intervening passive yields
   `TracedEndpoint(via=(), endpoint=node)`.

### Validated outputs (this board)
- **USB:** `U3.46(USB_DM)` net `Net-(U3-USB_DM)` → R4(27) → `/USB_D-` → `J1.2`;
  `U3.47(USB_DP)` → R3(27) → `/USB_D+` → `J1.3`.
- **Crystal:** `U3.20(XIN)` → `/XIN` → `Y1.1` direct (resolved `pin_name` `"1"`; C2 15p is a
  GND stub, terminated); `U3.21(XOUT)` → R5(1k) → `Net-(C3-Pad1)` → `Y1.3` (C3 stub
  terminated).
- **GPIO:** `U3.2(GPIO0)` → `/GPIO0` → `J3.4` direct (`J3.4` resolved `pin_name` `"Pin_4"`).
- **QSPI:** `U3.52(QSPI_SCLK)` → `/QSPI_SCLK` → `U2.6` direct; `U3.56(QSPI_SS)` →
  `/QSPI_SS` → `U2.1` direct **and** →R1(1k)→`/~{USB_BOOT}`→`J2.1` **and** →R2(DNF)→ rail
  `+3V3` (single synthetic rail endpoint, dnf).

## 7. Power/ground exclusion

A controller pin is **excluded** from `signal_pins` (per-pin UNION rule, evaluated
independently per pin — never per net):

A pin is power/ground if **either**
- **(a)** its libpart electrical `type` ∈ `{power_in, power_out}` (primary; `power_out`
  catches `VREG_VOUT`), **or**
- **(b)** the net it connects to is a power net per `is_power_net` (§6) — catches the
  strapped config pin `TESTEN` tied to `GND`, which type alone misses.

(Signal (c), `#PWR*`/`#FLG*` refs on the net, is bonus confirmation only and **never**
depended upon — none exist on this board.)

When (a) and (b) **disagree** for a pin, emit a stderr warning naming the pin (only
`pin 19 TESTEN` here) and default it to **excluded**.

**Exact U3 exclusion (14 pins):** `{1, 10, 19, 22, 23, 33, 42, 43, 44, 45, 48, 49, 50, 57}`
(IOVDD×6, TESTEN, DVDD×2, ADC_AVDD, VREG_IN, VREG_VOUT, USB_VDD, GND). **43 signal pins
remain** (GPIO0–29/ADC, QSPI_*, USB_DM/DP, XIN, XOUT, SWCLK, SWD, RUN).

**Designed for later re-inclusion without rework (correct restraint, not YAGNI):** the
classifier `classify_pin(pin) -> Literal["signal","power"]` **must** run over **all**
controller pins to do the in-scope v1 exclusion, so the orchestrator partitions into two
lists for free. v1 serializes only `signal_pins`. A future `--include-power` flag flips
serialization of the parallel `power_pins` field (power pins get `direct_nodes` only, not
traced). The only forward-looking cost is one absent dataclass field.

## 8. JSON output schema

Top-level object is the serialized `ControllerMap`. `null` for absent
`endpoint`/`rail`/`runner_up`. Pins sorted by integer pin number; `direct_nodes`,
`traced`, and `via` in deterministic sorted order so output is stable and diffable.
Serialization is hand-rolled via `dataclasses.asdict` + a thin encoder mapping `None`→`null`
and tuples→arrays; sort keys are explicit in the assembly step.

```json
{
  "tool": "controller_map v0.1.0",
  "source": "RP2040_minimal_r2",
  "controller": {"ref":"U3","part":"RP2040","lib":"MCU_RaspberryPi_RP2040","pin_count":57,"detected_by":"auto"},
  "runner_up": {"ref":"U2","part":"W25Q128JVS","lib":"Memory_Flash","pin_count":8},
  "low_confidence": false,
  "signal_pins": [
    {
      "pin": "2", "pin_name": "GPIO0", "net": "/GPIO0",
      "direct_nodes": [{"ref":"J3","pin":"4","pin_name":"Pin_4","value":"Conn_02x18_Odd_Even"}],
      "traced": [
        {"via":[],"endpoint":{"ref":"J3","pin":"4","pin_name":"Pin_4","value":"Conn_02x18_Odd_Even"},"rail":null,"dnf":false}
      ]
    },
    {
      "pin": "20", "pin_name": "XIN", "net": "/XIN",
      "direct_nodes": [
        {"ref":"Y1","pin":"1","pin_name":"1","value":"ABM8-272-T3"},
        {"ref":"C2","pin":"1","pin_name":"","value":"15p"}
      ],
      "traced": [
        {"via":[],"endpoint":{"ref":"Y1","pin":"1","pin_name":"1","value":"ABM8-272-T3"},"rail":null,"dnf":false}
      ]
    },
    {
      "pin": "47", "pin_name": "USB_DP", "net": "Net-(U3-USB_DP)",
      "direct_nodes": [{"ref":"R3","pin":"2","pin_name":"","value":"27"}],
      "traced": [
        {"via":[{"ref":"R3","value":"27","pin_in":"2","pin_out":"1","kind":"resistor","dnf":false}],
         "endpoint":{"ref":"J1","pin":"3","pin_name":"D+","value":"USB_B_Micro"},"rail":null,"dnf":false}
      ]
    },
    {
      "pin": "56", "pin_name": "QSPI_SS", "net": "/QSPI_SS",
      "direct_nodes": [
        {"ref":"U2","pin":"1","pin_name":"~{CS}","value":"W25Q128JVS"},
        {"ref":"R1","pin":"1","pin_name":"","value":"1k"},
        {"ref":"R2","pin":"2","pin_name":"","value":"DNF"}
      ],
      "traced": [
        {"via":[],"endpoint":{"ref":"U2","pin":"1","pin_name":"~{CS}","value":"W25Q128JVS"},"rail":null,"dnf":false},
        {"via":[{"ref":"R1","value":"1k","pin_in":"1","pin_out":"2","kind":"resistor","dnf":false}],
         "endpoint":{"ref":"J2","pin":"1","pin_name":"Pin_1","value":"Conn_01x02"},"rail":null,"dnf":false},
        {"via":[{"ref":"R2","value":"DNF","pin_in":"2","pin_out":"1","kind":"resistor","dnf":true}],
         "endpoint":null,"rail":"+3V3","dnf":true}
      ]
    }
  ]
}
```

`Y1.1` resolves to `pin_name "1"` (its libpart `Crystal_GND24` names pin 1 the bare token
`"1"`; the conceptual signal `XIN` is the name of *U3's* pin 20, not the crystal's), and
`J3.4`/`J2.1` resolve to `Pin_4`/`Pin_1` — the mechanically-correct outputs of §5, not the
conceptual net names. (`U3.52 QSPI_SCLK` → direct `U2.6` follows the GPIO pattern; omitted
for brevity.)

## 9. CLI

Console script `controller_map`. `main()` is a thin wrapper over
`create_controller_map(netlist_path, output_path, main_controller)`.

```
controller_map [--output PATH] [--main-controller REF] kicad_netlist.xml
```

- positional `kicad_netlist_file` — the `kicadxml` netlist.
- `--output PATH` — write JSON here; **stdout if omitted**.
- `--main-controller REF` — escape-hatch override, **exact `ref` match** only (§4).
- `--help` / version string `"controller_map v0.1.0"`.
- **All warnings/errors → stderr** (detection result, runner-up, low-confidence, type/net
  disagreement, DNF notices, MAXDEPTH branch-stop). stdout carries only the JSON, so it
  pipes cleanly into `jq`.

No `--power-net-regex` flag in v1 (see §6 caveat).

## 10. Edge cases & failure handling

- **Missing libpart** for a comp's `(lib, part)`: parser warns to stderr, treats pin count
  as 0 for detection (cannot win), falls back to `pinfunction`/bare-number naming. Never
  crashes.
- **`--main-controller REF` names a nonexistent ref:** error to stderr, exit non-zero.
- **KiCad-10 `pinfunction` suffix:** strip only `_<thisNode's pin number>$` (anchored,
  escaped). Detect per-node, not via the export `version` attribute. Greedy `_.+$`
  forbidden. (Residual over-strip risk on suffix-free boards documented in §5.2.)
- **Branching nets:** fan-out emits one `TracedEndpoint` per sink and one branch per
  passive; one pin → many endpoints (e.g. `QSPI_SS`).
- **Unconnected / no-connect pins:** a controller pin absent from every net is emitted with
  `net=""`, `direct_nodes=()`, `traced=()` so its existence is visible. `#PWR*`/`#FLG*` and
  no-connect refs (`ref` starts with `#`) are never sinks or hops.
- **Multi-pin passive guard:** any R/L/C/FB with ≠2 connected pins is rejected as a hop.
- **4-pin crystal (`Y1`, two GND pins):** 4 connected pins ⇒ never a hop, always an
  endpoint. Dedupe so reaching `Y1` via the `GND` rail does not re-emit it (rail
  termination emits a synthetic rail endpoint, not `Y1`).
- **Multi-sheet sheetpaths:** `sheetpath/@names` recorded but detection/tracing operate on
  the flat global netlist (KiCad nets are already sheet-merged); no special handling in v1.
- **Ties in controller detection:** full-tuple ties broken by `ref` ascending;
  low-confidence warning per §4.
- **MAX_HOP_DEPTH exceeded:** stop the branch, warn to stderr; no sentinel in JSON.
- **DNF series part:** path still emitted, `dnf=True` on the via and the endpoint.
- **Duplicate libpart names** (RP2040 IOVDD×6, DVDD×2): power pins, excluded by §7 before
  reaching `signal_pins`, so the collision never surfaces.

## 11. Build sequence (single implementation plan)

The verification fixture (`RP2040_kicad_netlist.xml`) lives outside this project in
`../minimal/`. Step 0 copies a (trimmed-if-desired) copy into `tests/fixtures/` so the
asserts below are reproducible, and writes them as a runnable `tests/check.py` (this
project has no pytest convention; a plain script is the right weight).

0. **Scaffold the standalone project:** `pyproject.toml` (§2), `uv sync` (own `.venv` +
   `uv.lock`), `__init__.py`, `.gitignore`, `README.md`; copy the RP2040 netlist into
   `tests/fixtures/`. `git init` and commit.
1. **`kicad_parser.py`** — parse the seven element groups (§3) into `_Netlist` + derived
   indices (`net_of`, `net_nodes`, `pins_of`), with `source = Path(design/source).stem`.
   Verify against the fixture: 34 comps, U3 libpart 57 pins, source → `RP2040_minimal_r2`.
2. **`controller_map.py`** — model dataclasses (§5) + deterministic JSON serializer;
   pin-name resolver (libpart-as-is, anchored suffix strip, bare-number fallback — assert
   `Y1.1`→`"1"`, `J3.4`→`"Pin_4"`, `U3.20`→`"XIN"`).
3. **`controller_map.py`** — detection scoring + `{U,IC,A}` IC bonus + tie-break + stderr
   print + low-confidence + `--main-controller` ref-exact override. Assert it picks U3,
   runner-up U2, `low_confidence=False`.
4. **`controller_map.py`** — `is_power_net`, prefix classifier, cap series/stub rule, rail
   termination, fan-out DFS with both guards + depth cap (stderr warn, no sentinel) + DNF;
   and `classify_pin` power/ground exclusion (§7). Assert the four validated traces and the
   exact 14-pin U3 exclusion (43 signal pins remain).
5. **`controller_map.py`** — `create_controller_map()` orchestrator (parse → detect →
   classify-all-pins → partition → trace signal pins → assemble `ControllerMap`) and the
   `argparse` `main()`; wire the console script. Run end-to-end:
   `uv run controller_map ../minimal/RP2040_kicad_netlist.xml --output ../minimal/RP2040_controller_map.json`.

## 12. Implementation addendum — multi-format input + refinements (as built)

The tool was extended to also read **Altium / OrCAD PCB II `.NET`** netlists (to verify the
Nordic nRF52840-DK, an Altium project). Deviations from §1–§11, all driven by real data:

- **Format abstraction.** A shared `netlist_model.py` holds the format-agnostic `_Netlist`;
  `kicad_parser.py` and `altium_parser.py` each produce one. `controller_map.py` sniffs the
  format from file content (`<export`/`<?xml` → KiCad; `( {…Netlist Format}` / leading `(`
  → Altium) and dispatches. So the package is 4 modules + `__init__`, not 2 (§2) — justified
  by the second parser.
- **Graceful degradation (Altium has no libpart).** Altium provides only footprint,
  designator, comment(value), pin number and net name — **no pin names, no pin electrical
  types, no library**. Therefore: pin names fall back to the bare pin number (the net name
  usually carries the signal, e.g. `P0.13`); power classification is **net-name only**; and
  the MCU-ness signal comes from a value/part regex (`_MCU_RE`, matching `nRF5x`, `STM32`,
  `RP2040`, …) in addition to the KiCad `MCU_*` library prefix.
- **`is_power_net` made robust (§6 revised).** The original exact-match sets missed Altium
  rails like `VDD_nRF`, `V5V`, `VSUPPLY`, `VLi-Ion`. Now: GND set; a rail-**prefix** set
  (`VDD`, `VCC`, `VBAT`, `VBUS`, `VIO`, `VREG`, `VEXT`, `VIN`, `VSUPPLY`, …); leading `+`/`-`;
  and a `\d+V\d*` / `V\d+V?\d*` pattern — but a trailing **signal suffix** (`_EN`, `_SENSE`,
  `_DETECT`, `_REF`, `_SEL`, …) forces "signal", so `VBAT_EN`, `VDD_nRF_SENSE`, `VCOM_*` stay
  signals. Conservative: errs toward keeping pins.
- **Sink set dropped; "non-hop ⇒ endpoint" (§6 revised).** Instead of an allowlist
  (`{J,U,Y,X,…}`), any node that is not a series hop is emitted as an endpoint. This handles
  unknown prefixes (`TP` test points, `LED`) honestly.
- **Closed solder bridges / jumpers are traced through (added after verification).** A 2-pin
  `SB*`/`JP*`/`LK*` whose footprint indicates closed/shorted (`"short"`/`"closed"` in the
  footprint, e.g. Altium `Solderbridge_Shorted`) is a pass-through hop (`kind` =
  `solderbridge`/`jumper`/`link`); an open bridge separates the two nets and stays an
  endpoint. Without this, the nRF52840-DK hid ~20 real connections behind `SBxx` endpoints —
  now `P0.13→LED1`, `P0.19→ext-flash U3`, `SWDIO→switch U6` resolve correctly. Conservative:
  bridges with no footprint hint are not traced through.
- **Stub caps excluded from `traced` (bug fixed).** A decoupling/load cap (2-pin C with its
  other terminal on a rail) is neither traced through **nor emitted as a traced endpoint**
  (`_is_stub_cap`); it still appears in `direct_nodes`. (Without this, `XIN` listed its load
  cap `C2` as an endpoint.)
- **Two-MCU detection confirmed.** On the Nordic board auto-detect picks `U2 nRF5340`
  (98 pins, the debugger) over `U1 nRF52840` (74), fires the low-confidence warning, and the
  `--main-controller U1` override selects the target. Working as designed.
- **`natkey` type-tagged.** Sort chunks are `(0,int)`/`(1,str)` so numeric and BGA-grid pins
  (`2` vs `A1`) on one net never compare int-vs-str.
- **`format` field added** to the JSON (`"kicad"` | `"altium"`).
- **Encoding:** Altium files are read UTF-8-first with latin-1 fallback. One real export uses
  a nonstandard byte encoding for `µ`/`Ø`; those `value` glyphs may be mojibake — connectivity
  is unaffected.

Verified end-to-end by `tests/check.py` (21 assertions across both fixtures).
