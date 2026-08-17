"""stm32_map — distill a Board IR document into stm32kernel-config-vocabulary
suggestions plus a loadable config seed.

Division of authority (see docs/specs/2026-07-06-board-ir-design.md):
the netlist proves WHERE copper goes; the pad's AF table (describe-mcu `signals`)
proves what a pad CAN do; this module only ever binds a pad to a signal the AF
table offers, ranked by netlist evidence. Firmware intent (peripheral modes,
params, ADC instance choice, pin stacking) is left to the AI + user, iterating
against `stm32kernel validate`.

Output vocabulary matches the kernel's config document: peripheral *instance*
names key the suggestions ("TIM1", "USB_OTG_FS"), pin maps use SHORT signal names
("CH1", not "TIM1_CH1"), pads are bare ("PA8", not "PA8-XYZ").

Evidence comes from two passes: net-name protocol tokens (_group_instances) and,
for the leftover pads, the traced endpoint's device type (_actuator_suggestions —
a DRV8871 IN pin proves PWM intent even when the net is just "/M101"). Actuator
TIM suggestions never reach cfgSeed: the seed contract is db-free facts only, and
a kernel TIM entry needs a CubeMX mode leaf plus prescaler/period/pulse — pure
firmware intent the netlist cannot prove. A wrong seeded PWM would cost the agent
validate-loop churn; an absent one costs a single `stm32kernel candidates TIMx`.
"""

from __future__ import annotations

import re

from .mcu_desc import McuDesc, split_signal
from .netlist_model import natkey

TOOL_NAME = "stm32_map v0.1.0"

# Altium hierarchical exports suffix net names with a sheet-instance ordinal
# ("M0_AH_1"); auto-generated names for unnamed nets look like "NetC2_1" / "NetU5_50".
_AUTO_NET_RE = re.compile(r"^(Net[A-Za-z]{1,4}\d+_\w+|N\$\d+|unconnected-.*)$")
_SHEET_SUFFIX_RE = re.compile(r"_\d+$")

# net token -> TIM channel short (three-phase half-bridge naming: A/B/C x High/Low)
_PHASE_TOKEN = {"AH": "CH1", "BH": "CH2", "CH": "CH3", "AL": "CH1N", "BL": "CH2N", "CL": "CH3N"}
_ANALOG_TOKENS = {"TEMP", "NTC", "THERM", "SENSE", "VSENSE", "SNS", "VBUS", "CUR",
                  "CURRENT", "AMP", "SO", "SO1", "SO2", "AIN", "ADC", "ISENSE", "I"}
_CAN_XCVR_RE = re.compile(r"(?i)SN65HVD|TJA1|MCP25|TCAN|VP23\d|ATA6|SIT104")
_OUTPUT_TOKENS = {"NCS", "CS", "CSN", "SS", "EN", "ENABLE", "CAL", "MOSI?"} - {"MOSI?"}
_INPUT_EXTI_TOKENS = {"FAULT", "NFAULT", "INT", "IRQ", "ALERT", "RDY", "DRDY", "DET", "WAKE", "Z"}
_INPUT_TOKENS = {"BOOT", "BUTTON", "BTN", "SW", "SWITCH"} | _INPUT_EXTI_TOKENS

# --- endpoint-device actuator rules (net names prove nothing on GPIO/PWM boards;
# the traced endpoint's device type is the evidence). Value-first matching; footprint/lib
# only corroborate driver ICs. DRV83xx are 3-phase GATE drivers whose MCU-facing leftover
# pins are enables/faults, not PWM inputs — excluded by (?!3\d\d).
_DRIVER_IC_RE = re.compile(
    r"(?i)\b(DRV8(?!3\d\d)\d{3}\w*|L29[38]\w*|L9110S?\w*|TB6612\w*|A49[89]\d|ULN200[38]\w*"
    r"|ULN2803\w*|STSPIN\d+\w*|TMC\d{4}\w*|MP6550|AT8236|TA6586)\b")
_ADDR_LED_RE = re.compile(r"(?i)WS28\d{2}|SK68\d{2}|NEOPIXEL|APA10[24]")
_TRANSISTOR_VAL_RE = re.compile(
    r"(?i)\b(AO3\d{3}\w*|CJ3\d{3}\w*|IRL\w+|SI23\d{2}\w*|2N7002\w*|BSS138\w*"
    r"|S{1,2}80[25]0\w*|2N2222A?|PN2222A?|MMBT\d{4}\w*|BC8[1-7]\d\w*|S901[2-4]\w*)\b")
_BUZZER_RE = re.compile(r"(?i)BUZZER|\bBUZZ\b|SPEAKER|\bSPKR?\b|MLT-?\d+|SMT-\d{4}")
_SERVO_RE = re.compile(r"(?i)SERVO")
_ACTUATOR_SKIP_TOKENS = (_ANALOG_TOKENS | _INPUT_TOKENS
                         | {"NCS", "CS", "CSN", "SS", "ILIM", "VREF", "MISO", "SCK", "SCL", "SDA"})
_ACTUATOR_DEMOTE_TOKENS = {"EN", "ENABLE", "SLEEP", "NSLEEP", "STBY", "RST", "RESET"}
_EP_NONCTRL_PIN_RE = re.compile(r"(?i)FAULT|ISEN|\bSO\d?\b|OUT|VPROPI|VREF|ILIM|^V(M|CC|DD|S)|GND|DO(UT)?$")
_CATEGORY_PRIORITY = ("motor-driver", "servo", "addressable-led", "buzzer", "transistor")

_MODE_HINTS = {
    "pwm-complementary": "complementary PWM (CubeMX TIM leaves like 'PWM Generation1 CH1 CH1N' per channel; verify with `stm32kernel candidates`)",
    "pwm": "PWM/output-compare on the listed channels (CubeMX TIM leaves like 'PWM Generation3 CH3')",
    "encoder": "quadrature encoder on CH1/CH2 (CubeMX TIM leaf 'Encoder_Interface')",
    "uart": "asynchronous UART (CubeMX leaf 'Asynchronous'); baud rate is user intent",
    "spi": "SPI, MCU almost certainly master (CubeMX leaf 'Full_Duplex_Master'); confirm",
    "i2c": "I2C (CubeMX leaf 'I2C')",
    "can": "CAN (CubeMX F4 leaf 'CAN_Activate'); bitrate is user intent",
    "usb": "USB full-speed; no VBUS sensing wiring implies device-only (CubeMX leaf 'Device_Only')",
}


# ------------------------------------------------------------------- pin context

class _PinCtx:
    def __init__(self, entry: dict, instances: list[str]):
        self.pad: str = entry["pad"]
        self.position: str = entry["position"]
        self.net: str = entry["net"] or ""
        self.auto_named = bool(_AUTO_NET_RE.match(self.net))
        base = self.net.lstrip("/").replace("\\", "")
        if not self.auto_named:
            base = _SHEET_SUFFIX_RE.sub("", base)
        self.net_base: str = base
        self.tokens: set[str] = {t for t in re.split(r"[^A-Za-z0-9]+", base.upper()) if t}
        # "USB_D+" / "USB_D-" style naming: the +/- is the whole signal identity
        u = base.upper()
        if re.search(r"D\+$|DP$", u):
            self.tokens.add("DP")
        if re.search(r"D-$|DM$", u):
            self.tokens.add("DM")
        self.signals: list[str] = entry.get("signals", [])
        self.connections: list[dict] = entry.get("connections", [])
        # (instance, short) candidates offered by the pad's AF table
        self.candidates: list[tuple[str, str]] = []
        for sig in self.signals:
            if sig == "GPIO":
                continue
            parsed = split_signal(sig, instances)
            if parsed is not None:
                self.candidates.append(parsed)

    def endpoints(self) -> list[dict]:
        return [c["endpoint"] for c in self.connections if c.get("endpoint")]

    def rails(self) -> list[dict]:
        return [c for c in self.connections if c.get("rail")]


def _endpoint_texts(ctx: _PinCtx) -> str:
    parts = []
    for ep in ctx.endpoints():
        parts.append(ep.get("value") or "")
        parts.append(ep.get("pin_name") or "")
        parts.append(ep.get("ref") or "")
    return " ".join(parts).upper()


# --------------------------------------------------------------------- scoring

def _score_candidate(ctx: _PinCtx, inst: str, short: str) -> tuple[int, list[str]]:
    """Evidence score for binding this pad to {inst}_{short}. 0 = no evidence."""
    t = ctx.tokens
    reasons: list[str] = []
    score = 0

    def hit(points: int, why: str) -> None:
        nonlocal score
        score += points
        reasons.append(why)

    fam = re.sub(r"\d+$", "", inst)  # "SPI3"->"SPI", "USB_OTG_FS"->"USB_OTG_FS"

    if fam == "SPI":
        if short == "SCK" and t & {"SCK", "SCLK"}:
            hit(3, "net-token:SCK")
        if short == "MISO" and t & {"MISO", "SDO", "SOMI"}:
            hit(3, "net-token:MISO")
        if short == "MOSI" and t & {"MOSI", "SDI", "SIMO"}:
            hit(3, "net-token:MOSI")
        if short == "NSS" and t & {"NSS", "SS", "CS", "NCS"}:
            hit(2, "net-token:CS")
    elif fam == "I2C":
        if short == "SCL" and "SCL" in t:
            hit(3, "net-token:SCL")
        if short == "SDA" and "SDA" in t:
            hit(3, "net-token:SDA")
    elif fam in ("USART", "UART"):
        if "SPI" not in t and "CAN" not in t:
            if short == "TX" and t & {"TX", "TXD", "UTX"}:
                hit(3, "net-token:TX")
            if short == "RX" and t & {"RX", "RXD", "URX"}:
                hit(3, "net-token:RX")
    elif fam == "CAN":
        can_ish = "CAN" in t or _CAN_XCVR_RE.search(_endpoint_texts(ctx))
        if can_ish:
            if short == "RX" and t & {"R", "RX", "RXD"}:
                hit(3, "net-token:CAN-R/RX")
            if short == "TX" and t & {"D", "TX", "TXD"}:
                hit(3, "net-token:CAN-D/TX")
            # corroboration only — a transceiver on the net must not score
            # token-less pins (its STB/EN control nets also reach the MCU)
            if reasons and _CAN_XCVR_RE.search(_endpoint_texts(ctx)):
                hit(2, "endpoint:CAN-transceiver")
    elif fam == "USB_OTG_FS" or fam == "USB_OTG_HS" or fam == "USB":
        usbish = "USB" in t or "USB" in _endpoint_texts(ctx)
        if short in ("DM",) and (t & {"DM", "DN"} or ("USB" in t and "M" in t)):
            hit(3, "net-token:DM")
        if short in ("DP",) and (t & {"DP",} or ("USB" in t and "P" in t)):
            hit(3, "net-token:DP")
        if short in ("DM", "DP") and usbish and score:
            hit(2, "usb-context")
    elif fam == "TIM":
        phase = next((tok for tok in sorted(t) if tok in _PHASE_TOKEN), None)
        if phase is not None and short == _PHASE_TOKEN[phase]:
            hit(3, f"net-token:{phase}")
        if "ENC" in t:
            if short == "CH1" and "A" in t:
                hit(3, "net-token:ENC_A")
            if short == "CH2" and "B" in t:
                hit(3, "net-token:ENC_B")
        if "PWM" in t and short.startswith("CH"):
            hit(2, "net-token:PWM")
        # bare high/low-side pair naming ("AUX_H"/"AUX_L", "HIN"/"LIN")
        if short.startswith("CH") and not short.endswith("N") and t & {"H", "HIN"}:
            hit(1, "net-token:H(high-side)")
        if short.startswith("CH") and t & {"L", "LIN"} and not (t & {"H", "HIN"}):
            hit(1, "net-token:L(low-side)")

    # generic exact-name agreement (SWO, ETR, MCO_1, D2, CK ...) — suppressed on
    # analog-hinted nets ("ADC_CH1" must stay an analog option, not become TIMx_CH1)
    short_tok = re.sub(r"[^A-Za-z0-9]+", "", short).upper()
    if (short_tok and short_tok in t and not reasons
            and not (t & _ANALOG_TOKENS and not inst.startswith("ADC"))):
        hit(2, f"net-token:{short_tok}")

    return score, reasons


# --------------------------------------------------------------- instance grouping

_SET_BONUS_THRESHOLD = 3
_SINGLE_PIN_THRESHOLD = 4  # single-pin instances need token + corroborating evidence


def _set_bonus(inst: str, shorts: set[str]) -> tuple[int, str | None]:
    fam = re.sub(r"\d+$", "", inst)
    if fam == "TIM":
        comp_pairs = sum(1 for x in ("CH1", "CH2", "CH3", "CH4") if x in shorts and x + "N" in shorts)
        if comp_pairs:
            return 3 * comp_pairs + (3 if comp_pairs >= 3 else 0), "pwm-complementary"
        if {"CH1", "CH2"} <= shorts and not any(s.endswith("N") for s in shorts):
            return 3, "encoder"
        if len({s for s in shorts if s.startswith("CH")}) >= 2:
            return 2, "pwm"  # weak-evidence channel pair (e.g. AUX_H/AUX_L half-bridge)
        return 0, "pwm"
    if fam == "SPI":
        core = {"SCK", "MISO", "MOSI"} & shorts
        return (4 if len(core) == 3 else (1 if len(core) == 2 else 0)), "spi"
    if fam in ("USART", "UART"):
        return (2 if {"TX", "RX"} <= shorts else 0), "uart"
    if fam == "CAN":
        return (3 if {"TX", "RX"} <= shorts else 0), "can"
    if fam.startswith("USB"):
        return (4 if {"DM", "DP"} <= shorts else 0), "usb"
    if fam == "I2C":
        return (3 if {"SCL", "SDA"} <= shorts else 0), "i2c"
    return 0, None


def _group_instances(ctxs: list[_PinCtx]) -> list[dict]:
    """Greedy, deterministic assignment of scored candidates to instances."""
    per_inst: dict[str, dict[str, list[tuple[int, _PinCtx, list[str]]]]] = {}
    for ctx in ctxs:
        for inst, short in ctx.candidates:
            score, reasons = _score_candidate(ctx, inst, short)
            if score <= 0:
                continue
            per_inst.setdefault(inst, {}).setdefault(short, []).append((score, ctx, reasons))

    def _first_token(ctx: _PinCtx) -> str:
        head = ctx.net_base.upper().split("_", 1)[0]
        return head

    def instance_state(inst: str, consumed: set[str]) -> tuple[int, dict[str, tuple[int, _PinCtx, list[str]]]]:
        usable_by_short = {
            short: [o for o in options if o[1].pad not in consumed]
            for short, options in per_inst[inst].items()
        }
        usable_by_short = {s: o for s, o in usable_by_short.items() if o}
        # Net names within one function block share a leading group token ("M0_AH",
        # "M0_BL", … all belong to motor 0). Pick the group that can cover the most
        # shorts (total score breaks ties) so one instance never mixes groups —
        # e.g. TIM1 must take CH1N from M0_AL/PB13, not from M1_AL/PA7.
        coverage: dict[str, tuple[int, int]] = {}
        for short, options in usable_by_short.items():
            for score, ctx, _ in options:
                key = _first_token(ctx)
                covered, total = coverage.get(key, (0, 0))
                coverage[key] = (covered, total + score)
        for key in coverage:
            covered = sum(
                1
                for options in usable_by_short.values()
                if any(_first_token(o[1]) == key for o in options)
            )
            coverage[key] = (covered, coverage[key][1])
        group = (
            max(sorted(coverage), key=lambda k: coverage[k]) if coverage else ""
        )
        chosen: dict[str, tuple[int, _PinCtx, list[str]]] = {}
        used_pads: set[str] = set()
        # strongest shorts pick first, and one pad may satisfy only one short
        for short in sorted(
            usable_by_short,
            key=lambda s: (-max(o[0] for o in usable_by_short[s]), natkey(s)),
        ):
            options = sorted(
                (o for o in usable_by_short[short] if o[1].pad not in used_pads),
                key=lambda o: (-o[0], 0 if _first_token(o[1]) == group else 1, natkey(o[1].pad)),
            )
            if not options:
                continue
            chosen[short] = options[0]
            used_pads.add(options[0][1].pad)
        total = sum(o[0] for o in chosen.values())
        bonus, _ = _set_bonus(inst, set(chosen))
        return total + bonus, chosen

    consumed: set[str] = set()
    accepted: list[dict] = []
    remaining = set(per_inst)
    while remaining:
        ranked = sorted(
            ((instance_state(inst, consumed), inst) for inst in remaining),
            key=lambda x: (-x[0][0], natkey(x[1])),
        )
        (best_score, chosen), inst = ranked[0]
        if not chosen or best_score < _SET_BONUS_THRESHOLD:
            break
        if len(chosen) == 1 and best_score < _SINGLE_PIN_THRESHOLD:
            # a lone pin needs corroboration beyond one name token — a bare "CH"
            # or "TX" token alone must not conjure a peripheral
            remaining.discard(inst)
            continue
        remaining.discard(inst)
        _, kind = _set_bonus(inst, set(chosen))
        if kind == "encoder" and not any(
            "ENC" in r for _, _, reasons in chosen.values() for r in reasons
        ):
            kind = "pwm"  # CH1+CH2 without encoder naming is just two PWM channels
        per_pin_scores = [o[0] for o in chosen.values()]
        strong = all(s >= 3 for s in per_pin_scores)
        confidence = "high" if strong and (len(chosen) >= 2) else ("medium" if min(per_pin_scores) >= 2 else "low")
        evidence = []
        for short in sorted(chosen, key=natkey):
            score, ctx, reasons = chosen[short]
            alternatives = sorted(
                {
                    f"{i}_{s}"
                    for i, s in ctx.candidates
                    if i != inst and _score_candidate(ctx, i, s)[0] > 0
                }
            )
            evidence.append(
                {
                    "pad": ctx.pad,
                    "position": ctx.position,
                    "net": ctx.net,
                    "signal": f"{inst}_{short}",
                    "score": score,
                    "reasons": reasons,
                    "alternatives": alternatives,
                }
            )
        entry = {
            "instance": inst,
            "kind": kind or "peripheral",
            "confidence": confidence,
            "pins": {short: chosen[short][1].pad for short in sorted(chosen, key=natkey)},
            "evidence": evidence,
        }
        hint = _MODE_HINTS.get(kind or "")
        if hint:
            entry["modeHint"] = hint
        accepted.append(entry)
        consumed |= {o[1].pad for o in chosen.values()}

    accepted.sort(key=lambda p: natkey(p["instance"]))
    return accepted, consumed


# ------------------------------------------------- endpoint-device actuator pass

def _classify_endpoint(ep: dict, comp: dict | None) -> str | None:
    """Actuator category of a traced endpoint, or None. Value text decides;
    footprint/lib only corroborate (eeschema components carry no lib/part)."""
    val = ep.get("value") or ""
    cls = (comp or {}).get("class") or ""
    text = " ".join([val, (comp or {}).get("footprint") or "", (comp or {}).get("lib") or ""])
    if _DRIVER_IC_RE.search(text):
        return "motor-driver"
    if _SERVO_RE.search(text) and cls in ("connector", "switch", "other"):
        return "servo"
    if _ADDR_LED_RE.search(text):
        return "addressable-led"
    if _BUZZER_RE.search(text):
        return "buzzer"
    if cls == "transistor" or _TRANSISTOR_VAL_RE.search(val):
        return "transistor"
    return None


def _actuator_match(ctx: _PinCtx, comps_by_ref: dict) -> tuple[str, str, str, list[str]] | None:
    """-> (category, endpoint ref, confidence, reasons) or None.

    Direction guard, in order: (a) structural — the caller only passes
    role=="signal" ctxs, so MCU pins on power nets (driver VM/OUT sides) never
    enter; (b) skip-token veto (nFAULT/INT/SENSE/SO/CS… = MCU input or analog,
    not a PWM control output); (c) DNF paths ignored; (d) named endpoint pins
    that are fault/output/supply pins ignored (kicadxml-only knowledge);
    (e) highest-priority category across connections wins; (f) motor-driver and
    servo rate medium, the rest low; enable-ish net tokens demote to low so an
    L298 EN_A stays suggestible while a master enable cannot reach medium."""
    if ctx.tokens & _ACTUATOR_SKIP_TOKENS:
        return None
    best: tuple[int, str, str, list[str]] | None = None
    for c in ctx.connections:
        ep = c.get("endpoint")
        if not ep or c.get("dnf"):
            continue
        comp = comps_by_ref.get(ep["ref"])
        pin_name = ep.get("pin_name") or ""
        if pin_name and not pin_name.isdigit() and _EP_NONCTRL_PIN_RE.search(pin_name):
            continue  # kicadxml told us it's a fault/output/power pin
        cat = _classify_endpoint(ep, comp)
        if cat is None:
            continue
        via = "".join(f" via {v['ref']}" for v in (c.get("via") or [])[:1])
        reason = f"endpoint:{cat}({ep['ref']} {ep.get('value') or '?'}{via})"
        prio = _CATEGORY_PRIORITY.index(cat)
        if best is None or prio < best[0]:
            best = (prio, cat, ep["ref"], [reason])
    if best is None:
        return None
    _, cat, ref, reasons = best
    conf = "medium" if cat in ("motor-driver", "servo") else "low"
    if ctx.tokens & _ACTUATOR_DEMOTE_TOKENS:
        conf = "low"
        reasons.append("net-token:enable-ish(demoted)")
    return cat, ref, conf, reasons


def _tim_channel_candidates(ctx: _PinCtx) -> list[tuple[str, str]]:
    """TIM channel options the pad's AF table offers — never invent signals;
    pads without any (e.g. a bare enable pin) keep their gpio suggestion."""
    return [(i, s) for i, s in ctx.candidates
            if re.fullmatch(r"TIM\d+", i) and re.fullmatch(r"CH\d+N?", s)]


def _actuator_suggestions(ctxs: list[_PinCtx], comps_by_ref: dict, consumed: set[str],
                          taken_instances: set[str]) -> tuple[list[dict], set[str]]:
    """Suggest TIM/PWM instances for unconsumed pads whose traced endpoint is an
    actuator-type device. Groups by (category, endpoint ref) — except servos,
    which share one instance per board (all headers ride one 20 ms frame) — and
    greedily picks the untaken TIM covering the most pads, preferring plain CH
    over CHxN. Never touches token-based suggestions or their instances."""
    matches = []  # (category, group ref, confidence, reasons, ctx)
    for ctx in ctxs:
        if ctx.pad in consumed or not _tim_channel_candidates(ctx):
            continue
        m = _actuator_match(ctx, comps_by_ref)
        if m:
            matches.append((*m, ctx))
    groups: dict[tuple[str, str], list] = {}
    for cat, ref, conf, reasons, ctx in matches:
        key = (cat, "" if cat == "servo" else ref)
        groups.setdefault(key, []).append((conf, reasons, ctx))
    entries = []
    new_consumed = set(consumed)
    for key in sorted(groups, key=lambda k: (_CATEGORY_PRIORITY.index(k[0]), natkey(k[1]))):
        cat = key[0]
        members = [m for m in groups[key] if m[2].pad not in new_consumed]
        while members:
            # rank instances by (#pads covered, #plain CH, lowest natkey)
            cover: dict[str, dict[str, tuple]] = {}
            for conf, reasons, ctx in members:
                for inst, short in _tim_channel_candidates(ctx):
                    if inst in taken_instances:
                        continue
                    cover.setdefault(inst, {})
                    # prefer plain CH over CHxN for the same pad
                    cur = cover[inst].get(ctx.pad)
                    if cur is None or (cur[0].endswith("N") and not short.endswith("N")):
                        cover[inst][ctx.pad] = (short, conf, reasons, ctx)
            if not cover:
                break

            def rank(inst: str):
                pads = cover[inst]
                plain = sum(1 for s, *_ in pads.values() if not s.endswith("N"))
                return (-len(pads), -plain, natkey(inst))

            inst = min(cover, key=rank)
            pads = cover[inst]
            # one short per pad; collision (two pads, same short) -> first by natkey(pad)
            by_short: dict[str, tuple] = {}
            for pad in sorted(pads, key=natkey):
                short, conf, reasons, ctx = pads[pad]
                if short in by_short:
                    continue
                by_short[short] = (pad, conf, reasons, ctx)

            def alternatives(ctx: _PinCtx) -> list[str]:
                alts = {f"{i}_{s}" for i, s in _tim_channel_candidates(ctx) if i != inst}
                if cat == "addressable-led":  # the classic "TIM or SPI-MOSI" choice
                    alts |= {f"{i}_{s}" for i, s in ctx.candidates if s == "MOSI"}
                return sorted(alts)

            confs = [v[1] for v in by_short.values()]
            entries.append(
                {
                    "instance": inst,
                    "kind": "pwm",
                    "confidence": "medium" if all(c == "medium" for c in confs) else "low",
                    "pins": {s: by_short[s][0] for s in sorted(by_short, key=natkey)},
                    "evidence": [
                        {"pad": v[3].pad, "position": v[3].position, "net": v[3].net,
                         "signal": f"{inst}_{s}", "score": 2 if v[1] == "medium" else 1,
                         "reasons": v[2], "alternatives": alternatives(v[3])}
                        for s, v in sorted(by_short.items(), key=lambda kv: natkey(kv[0]))
                    ],
                    "modeHint": _MODE_HINTS["pwm"],
                }
            )
            taken_instances.add(inst)
            claimed = {v[0] for v in by_short.values()}
            new_consumed |= claimed
            members = [m for m in members if m[2].pad not in claimed]
    return entries, new_consumed


# ------------------------------------------------------------------- fallbacks

def _gpio_suggestion(ctx: _PinCtx) -> dict:
    t = ctx.tokens
    ep_text = _endpoint_texts(ctx)
    mode, init_high, exti, conf, why = "input", False, False, "low", "default"
    if t & {"NCS", "CS", "CSN", "SS"}:
        mode, init_high, conf, why = "output", True, "medium", "chip-select naming"
    elif t & {"EN", "ENABLE", "CAL"} or "GATE" in t:
        mode, conf, why = "output", "medium", "enable/control naming"
    elif "LED" in t or "LED" in ep_text:
        mode, conf, why = "output", "medium", "LED load"
    elif t & _INPUT_EXTI_TOKENS:
        mode, exti, conf, why = "input", True, "medium", "interrupt/flag naming"
    elif t & _INPUT_TOKENS:
        mode, conf, why = "input", False, "medium", "input naming"

    pulls = []
    for c in ctx.rails():
        via = c.get("via") or []
        if via and all(v.get("kind") == "resistor" for v in via):
            pulls.append(f"external pull to {c['rail']} via {'/'.join(v['ref'] for v in via)}")

    label = re.sub(r"[^A-Za-z0-9_]+", "_", ctx.net_base).strip("_") or ctx.pad
    suggest: dict = {"mode": mode, "label": label}
    if init_high:
        suggest["initHigh"] = True
    af = sorted({f"{i}_{s}" for i, s in ctx.candidates})
    out = {
        "pad": ctx.pad,
        "net": ctx.net,
        "suggest": suggest,
        "extiCandidate": exti,
        "confidence": conf,
        "evidence": [why] + pulls,
        "afAvailable": af,
    }
    if why == "LED load":
        tims = sorted({f"{i}_{s}" for i, s in ctx.candidates
                       if re.fullmatch(r"TIM\d+", i) and re.fullmatch(r"CH\d+N?", s)}, key=natkey)
        if tims:
            out["pwmOptions"] = tims  # PWM-dimmable; informational, not consumed
    return out


# ------------------------------------------------------------------- top level

def build_stm32_map(ir: dict, desc: McuDesc) -> dict:
    mcu = ir.get("mcu")
    if not mcu:
        raise ValueError("board IR has no mcu section; supply --mcu-desc")
    instances = desc.instances()

    pins = mcu["pins"]
    signal_ctxs = [_PinCtx(p, instances) for p in pins if p["role"] == "signal" and p.get("net")]

    # clock sources from crystal-role pins
    clock: list[dict] = []
    for source, marker in (("HSE", "OSC_IN"), ("LSE", "OSC32_IN")):
        ins = [p for p in pins if p["role"] == "crystal" and marker in p["padFull"]]
        outs = [
            p for p in pins
            if p["role"] == "crystal" and marker.replace("_IN", "_OUT") in p["padFull"]
        ]
        if source == "HSE":  # don't let OSC32 pads match the plain OSC marker
            ins = [p for p in ins if "OSC32" not in p["padFull"]]
            outs = [p for p in outs if "OSC32" not in p["padFull"]]
        if not ins:
            continue
        xt = ins[0].get("crystal") or {}
        # OSC_IN driven with OSC_OUT unused = external active oscillator (bypass)
        kind = "crystal" if outs else "bypass"
        clock.append(
            {
                "source": source,
                "kind": kind,
                "freqHz": xt.get("freqHz"),
                "pads": [p["pad"] for p in ins + outs],
                "evidence": [
                    f"{xt.get('ref', '?')} on {'/'.join(p['pad'] for p in ins + outs)}"
                ],
            }
        )

    peripherals, consumed = _group_instances(signal_ctxs)
    # endpoint-device pass: only leftover pads, never touches token-based suggestions
    comps_by_ref = {c["ref"]: c for c in ir.get("components", [])}
    actuators, consumed = _actuator_suggestions(
        signal_ctxs, comps_by_ref, set(consumed), {p["instance"] for p in peripherals})
    peripherals = sorted(peripherals + actuators, key=lambda p: natkey(p["instance"]))

    analog: list[dict] = []
    gpio: list[dict] = []
    unexplained: list[dict] = []
    for ctx in signal_ctxs:
        if ctx.pad in consumed:
            continue
        adc_opts = sorted(
            {f"{i}_{s}" for i, s in ctx.candidates if re.match(r"^ADC\d*$", i) and s.startswith("IN")},
            key=natkey,
        )
        if adc_opts and (ctx.tokens & _ANALOG_TOKENS):
            analog.append(
                {
                    "pad": ctx.pad,
                    "net": ctx.net,
                    "options": adc_opts,
                    "evidence": [f"analog-ish net name '{ctx.net_base}'"],
                }
            )
            continue
        if ctx.auto_named:
            unexplained.append(
                {"pad": ctx.pad, "net": ctx.net, "note": "connected, but the net is unnamed — inspect the Board IR connections"}
            )
            continue
        gpio.append(_gpio_suggestion(ctx))

    gpio.sort(key=lambda g: natkey(g["pad"]))
    analog.sort(key=lambda a: natkey(a["pad"]))

    reserved = {
        "swd": sorted({p["pad"] for p in pins if p["role"] == "swd"}, key=natkey),
        "boot": sorted({p["pad"] for p in pins if p["role"] == "boot"}, key=natkey),
        "reset": sorted({p["pad"] for p in pins if p["role"] == "reset"}, key=natkey),
        "crystal": sorted({p["pad"] for p in pins if p["role"] == "crystal"}, key=natkey),
    }

    part = mcu["part"]["resolved"]
    seed: dict = {"schemaVersion": 1, "mcu": {"part": part}}
    sources = {
        c["source"]: {"kind": c["kind"], "freqHz": c["freqHz"]}
        for c in clock
        if c.get("freqHz")
    }
    if sources:
        seed["clock"] = {"sources": sources}
    seed_gpio: dict[str, dict] = {}
    used_labels: set[str] = set()
    for g in gpio:  # already pad-sorted; dedupe labels (kernel emits them as #defines)
        if g["confidence"] not in ("high", "medium"):
            continue
        suggest = dict(g["suggest"])
        if suggest["label"] in used_labels:
            suggest["label"] = f"{suggest['label']}_{g['pad']}"
        used_labels.add(suggest["label"])
        seed_gpio[g["pad"]] = suggest
    if seed_gpio:
        seed["gpio"] = seed_gpio
    if reserved["swd"]:
        seed["debug"] = "swd"
    seed["project"] = {"name": re.sub(r"[^A-Za-z0-9_]+", "_", ir["source"]["board"]).strip("_").lower() or "board"}

    return {
        "schemaVersion": 1,
        "tool": TOOL_NAME,
        "source": ir["source"],
        "mcu": {"part": part, "package": mcu["part"].get("package"),
                "verificationScore": mcu["verification"].get("score")},
        "clock": clock,
        "peripherals": peripherals,
        "analog": analog,
        "gpio": gpio,
        "reserved": reserved,
        "unexplained": unexplained,
        "cfgSeed": seed,
    }
