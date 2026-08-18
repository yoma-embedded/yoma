# controller_map

Extract a board's **main-controller pin connections** from a netlist — with **zero
schematic annotation** — and emit them as JSON. For every signal pin of the auto-detected
controller it reports both the **raw direct net** and the **pass-through-traced endpoints**
(the meaningful sinks reached through series resistors / inductors / ferrites / coupling
caps).

It reads:
- a **KiCad** `kicadxml` netlist (`kicad-cli sch export netlist --format kicadxml ...`), or
- an **Altium / OrCAD PCB II** `.NET` netlist, or
- an **Altium Smart PDF** containing the exported `Components` / `Nets` / `Pins`
  outline metadata.

The input format is auto-detected from the file content.

## Why

The sibling `kicad_firmware_generation` project requires per-component `GroupType`
annotations in KiCad that most schematics lack. `controller_map` needs none: it identifies
the controller heuristically and walks the netlist.

## Install / run (uv)

```sh
cd controller_map
uv sync
uv run controller_map <netlist> [--output out.json] [--main-controller REF]
```

Examples:

```sh
# KiCad
uv run controller_map tests/fixtures/RP2040_kicad_netlist.xml --output out/rp2040.json

# Altium / OrCAD .NET (this board has two MCUs — see below)
uv run controller_map tests/fixtures/pca10056.NET --main-controller U1 --output out/nrf52840.json

# Altium Smart PDF (ordinary/scanned PDFs are rejected rather than guessed)
uv run controller_map board.pdf --main-controller U1 --output out/board.json
```

JSON goes to stdout (or `--output`); all diagnostics go to stderr, so it pipes cleanly into
`jq`.

## Controller detection

Auto-detected with a transparent score `(looks-like-MCU, ref-is-IC, pin-count)`; the choice
and runner-up are printed to stderr. When two parts score closely (e.g. a board with two
MCUs) it prints a **low-confidence** warning. Override with `--main-controller <ref>` (exact
ref).

> The Nordic **nRF52840-DK** (`pca10056.NET`) carries two MCUs: `U2 nRF5340` (98 pins, the
> on-board debugger) and `U1 nRF52840` (74 pins, the target). Auto-detect picks the
> higher-pin `U2` and flags low confidence; pass `--main-controller U1` for the target MCU.

## Output (per signal pin)

```jsonc
{
  "pin": "47", "pin_name": "USB_DP", "net": "Net-(U3-USB_DP)",
  "direct_nodes": [ /* every other node on the pin's net (raw truth) */ ],
  "traced": [        // meaningful sinks reached through series passives
    { "via": [ {"ref":"R3","value":"27","kind":"resistor","dnf":false, ...} ],
      "endpoint": {"ref":"J1","pin":"3","pin_name":"D+","value":"USB_B_Micro"},
      "rail": null, "dnf": false }
  ]
}
```

- A series **R/L/ferrite** is always traced through; a **capacitor** only if its other
  terminal is on a signal net (a cap to a rail is decoupling/load — excluded from `traced`,
  still shown in `direct_nodes`).
- A pull to a power/ground net terminates as a single `{"endpoint": null, "rail": "+3V3"}`.
- Unpopulated series parts (`DNF`, `N.C.`, …) are still reported, flagged `"dnf": true`.
- Power/ground pins of the controller are excluded from `signal_pins`.

## Two views (`connections`)

`connections` is a post-processor over the JSON above. It re-expresses each pin's
connections as two complementary, **lossless** views (no component value is dropped; no
electrical interpretation is added):

- **destinations (去向)** — where each pin ultimately goes, and to what kind of device
  (`connector` / `ic` / `led` / `testpoint` / `crystal` / `rail` / …).
- **paths (途经电路)** — what circuit each of those connections crosses (the series
  resistors / bridges / etc., with their values preserved verbatim).

```sh
# pipe straight from controller_map (JSON on stdout pipes cleanly)
uv run controller_map tests/fixtures/pca10056.NET --main-controller U1 \
  | uv run connections --view destinations

# or from a saved map; --split writes <stem>_{connections,destinations,paths}.json
uv run connections out/nordic_nRF52840_controller_map.json --output out/nrf52840.json --split
```

`--view canonical` (default) emits one flat list where each record carries both the
destination and the via path — lean, one line of meaning per connection:

```json
{ "pin": "AA24", "net": "SWDCLK",
  "to": "U6.4", "class": "ic", "value": "FSA2466UMX",
  "via": [ { "ref": "SB55", "value": "Solderbridge", "kind": "solderbridge" } ],
  "dnf": false }
```

`to` is `"REF.PIN"` for a device or the rail name for a power/gnd termination (`class` says
which; `value` is `null` for a rail). Component values in `via` are preserved verbatim. See
`docs/specs/2026-06-09-controller-connections-design.md` §11.

## Known limitations

- **PDF support is intentionally limited to Altium Smart PDF.** Ordinary vector PDFs and
  scanned pages do not contain reliable pin/net semantics and are rejected explicitly.
  Connectivity comes from the outline; Comment/Footprint properties follow the matching
  per-page component-link order emitted by Altium, and are left empty with a warning if
  the counts do not match.
- Smart PDF nets are keyed by their exported outline title. Hierarchical designs that
  reuse an undisambiguated local net title in independent sheet instances are not yet
  supported.
- **Altium `.NET` carries no pin names/types/library.** Pin names degrade to pin numbers
  (the net name usually carries the signal, e.g. `P0.13`), and power classification is by
  net name only (conservative — errs toward keeping signals).
- **Power-net classification is name-based.** Robust for conventional names; a board that
  names rails unconventionally *and* omits power-flag symbols may misclassify.
- **Solder bridges / jumpers (`SB*`/`JP*`/`LK*`)** are traced through only when the
  footprint says they are closed/shorted (e.g. Altium `Solderbridge_Shorted`); an open
  bridge stays an endpoint (it genuinely separates the two nets). On the nRF52840-DK this
  correctly reveals `P0.13 → LED1`, `P0.19 → external flash`, `SWDIO → analog switch`, etc.
- **Series coupling caps** are supported but unexercised by the bundled fixtures.
- Some Altium exports use a nonstandard byte encoding; exotic `value` glyphs (`µ`, `Ø`) may
  render as mojibake. Connectivity is unaffected.

## Verify

```sh
uv run python tests/check.py    # 21 assertions across both fixtures
```

See `docs/specs/2026-06-06-controller-map-design.md` for the full design.
