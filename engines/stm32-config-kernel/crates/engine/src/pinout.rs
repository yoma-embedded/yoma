//! Deterministic pin allocation.
//!
//! Inputs: demanded signals per instance (full names like "USART1_TX"),
//! optional user pin hints (hints are *fixed*, never moved), user GPIO
//! pins, and the debug-port reservation. Constraints: one signal per pin,
//! F1 remap-group consistency (all signals of a peripheral share one AFIO
//! remap configuration), cross-pin exclusion conditions from the MCU file.
//!
//! Pin stacking (mine-core Q5, plan §P4): a pad may host multiple signals
//! iff (a) all of them are analog-class (ADCx_INn shared across ADC1/2/3 —
//! implicit, CubeMX shares analog pads freely), or (b) the pad's user GPIO
//! entry whitelists the co-signals via `sharedWith` (ODrive PA0 = EXTI +
//! UART4_TX). Shared pads produce an info diagnostic PIN_SHARED; everything
//! else stays PIN_CONFLICT. One pad still carries ONE GPIO config — codegen
//! merges the stack (functional signal's io settings + gpio entry's pull).
//!
//! Search: backtracking over signals in deterministic order; candidate
//! pins ordered hint-first then (port, bit) lexicographic; F1 remap group
//! choices ordered default-first then ascending index. First feasible
//! solution wins (order *is* the documented preference).

use crate::diag::Diagnostic;
use crate::env::Env;
use crate::eval::{eval_condition, EvalTrace};
use std::collections::{BTreeMap, BTreeSet};
use stm32ck_ir::model::{AfBinding, GpioIp, Part, PinKind};

/// One signal to place.
#[derive(Debug, Clone)]
pub struct SignalReq {
    /// Full signal name: "USART1_TX".
    pub signal: String,
    /// Owning instance ("USART1") — remap groups are per instance.
    pub instance: String,
    /// User-demanded pin (hint): must be honored or error out.
    pub hint: Option<String>,
    /// Config path for diagnostics.
    pub path: String,
}

/// A placed signal.
#[derive(Debug, Clone, PartialEq)]
pub struct Placement {
    pub signal: String,
    /// Bare pad name from the MCU pin list (may carry suffixes).
    pub pin: String,
    /// F4+: HAL AF macro; F1 non-default remap: AFIO remap macro.
    pub af_macro: Option<String>,
    /// F1: chosen remap block name for the owning peripheral.
    pub remap_block: Option<String>,
}

#[derive(Debug, Default)]
pub struct PinPlan {
    pub placements: Vec<Placement>,
    /// instance -> chosen remap block (F1 only, only when non-default).
    pub remaps: BTreeMap<String, String>,
    pub diags: Vec<Diagnostic>,
}

/// Debug port reservation policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugPort {
    /// Reserve SWD pins (default; SYS_JTMS-SWDIO / SYS_JTCK-SWCLK pins).
    Swd,
    /// No reservation (all pins free).
    None,
}

#[allow(clippy::too_many_arguments)]
pub fn allocate(
    part: &Part,
    gpio: &GpioIp,
    requests: &[SignalReq],
    occupied_by_user: &BTreeSet<String>, // user GPIO pins (exact pad names)
    debug: DebugPort,
    analog: &BTreeSet<String>, // full signal names that are analog-class
    shared_pads: &BTreeMap<String, BTreeSet<String>>, // base pad -> sharedWith
    groups: &SignalGroups,                            // db ShareableGroupName / ExclusiveGroupName
) -> PinPlan {
    let mut plan = PinPlan::default();

    // --- candidate table: signal -> pins carrying it (deterministic order)
    let mut pin_order: Vec<&str> = Vec::new();
    let mut candidates: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for pin in &part.pins {
        if pin.kind != PinKind::Io {
            continue;
        }
        pin_order.push(&pin.name);
        for s in &pin.signals {
            candidates.entry(s.name.as_str()).or_default().push(&pin.name);
        }
    }
    for pins in candidates.values_mut() {
        pins.sort_by_key(|p| pin_sort_key(p));
    }

    // --- reserved pins
    let mut reserved: BTreeSet<&str> = BTreeSet::new();
    if debug == DebugPort::Swd {
        for pin in &part.pins {
            for s in &pin.signals {
                if s.name == "SYS_JTMS-SWDIO" || s.name == "SYS_JTCK-SWCLK" {
                    reserved.insert(pin.name.as_str());
                }
            }
        }
    }
    // Users write base pad names ("PC13"); db pads carry suffixes
    // ("PC13-TAMPER-RTC"). Resolve by exact-then-base match.
    let resolve_pad = |pad: &str| {
        part.pins
            .iter()
            .find(|p| p.name == pad || base_pad(&p.name) == pad)
    };
    for pad in occupied_by_user {
        match resolve_pad(pad) {
            Some(p) if p.kind == PinKind::Io => {}
            Some(p) => {
                plan.diags.push(Diagnostic::error(
                    "PIN_NOT_IO",
                    format!("/gpio/{pad}"),
                    format!("pad `{}` is not an I/O pin", p.name),
                ));
            }
            None => {
                plan.diags.push(Diagnostic::error(
                    "PIN_UNKNOWN",
                    format!("/gpio/{pad}"),
                    format!(
                        "pad `{pad}` does not exist on {} ({})",
                        part.ref_name, part.package
                    ),
                ));
            }
        }
    }

    // --- deterministic request order: fewest candidates first (fail fast),
    //     ties by signal name. Hinted requests are checked, not searched.
    let mut order: Vec<&SignalReq> = requests.iter().collect();
    order.sort_by_key(|r| {
        (
            r.hint.is_none() as u8, // hinted first (they only constrain)
            candidates.get(r.signal.as_str()).map_or(0, |c| c.len()),
            r.signal.clone(),
        )
    });

    // --- backtracking state
    let mut used: BTreeMap<String, Vec<String>> = BTreeMap::new(); // pin -> signals
    for pad in occupied_by_user {
        if let Some(p) = resolve_pad(pad) {
            used.entry(p.name.clone()).or_default().push("GPIO".to_string());
        }
    }
    let mut remap_choice: BTreeMap<String, String> = BTreeMap::new(); // instance -> block
    let mut placements: Vec<Placement> = Vec::new();
    let share = ShareRules {
        analog,
        shared_pads,
        groups,
    };

    if !search(
        &order,
        0,
        &candidates,
        gpio,
        &reserved,
        &share,
        &mut used,
        &mut remap_choice,
        &mut placements,
    ) {
        // Produce an explanation for the first unplaceable request.
        explain_failure(&order, &candidates, gpio, &reserved, &share, &used, &mut plan);
        return plan;
    }

    // Info diagnostic for every deliberately stacked pad (mine-core Q5).
    for (pin, occupants) in &used {
        if occupants.len() > 1 {
            plan.diags.push(Diagnostic::info(
                "PIN_SHARED",
                format!("/pinout/{}", base_pad(pin)),
                format!(
                    "pad {} hosts stacked signals: {} (one shared GPIO config)",
                    base_pad(pin),
                    occupants.join(", ")
                ),
            ));
        }
    }

    // --- cross-pin exclusion conditions from the MCU file
    //
    // Term semantics (F103 PB5: `!(SPI1_MOSI & PB6_I2C1_SCL)`): a bare signal
    // name means "this signal is routed on THIS pin" — the erratum fires only
    // when SPI1_MOSI actually remaps onto PB5 — while `<pad>_<signal>` names
    // another pad explicitly. Bare names are therefore raised per evaluated
    // pin, not globally: the global reading turned every such erratum into a
    // false PIN_EXCLUSION whenever both signals existed anywhere on the
    // package (I2C1+SPI1 on F103C8 being the canonical victim).
    let mut global = Env::new();
    let mut trace = EvalTrace::default();
    for p in &placements {
        global.raise(format!("{}_{}", base_pad(&p.pin), p.signal));
    }
    for pin in &part.pins {
        if pin.conditions.is_empty() {
            continue;
        }
        let mut env = global.clone();
        for p in placements.iter().filter(|p| base_pad(&p.pin) == base_pad(&pin.name)) {
            env.raise(p.signal.clone());
        }
        for dc in &pin.conditions {
            if !eval_condition(&dc.condition, &env, &mut trace) {
                plan.diags.push(
                    Diagnostic::error(
                        "PIN_EXCLUSION",
                        format!("/pinout/{}", pin.name),
                        format!(
                            "hardware exclusion violated on {} ({})",
                            pin.name,
                            if dc.diagnostic.is_empty() { "MCU datasheet constraint" } else { &dc.diagnostic }
                        ),
                    )
                    .with_suggestion("move one of the conflicting signals to an alternative pin"),
                );
            }
        }
    }

    plan.remaps = remap_choice
        .iter()
        .filter(|(_, block)| !block.ends_with("_REMAP0"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    plan.placements = placements;
    plan.placements.sort_by(|a, b| a.signal.cmp(&b.signal));
    plan
}

/// The db's own per-signal pad-sharing groups, keyed by full signal name.
///
/// `ShareableGroupName` marks signals that may legitimately sit on one pad;
/// `ExclusiveGroupName` marks a set of which only one may be routed. Both are
/// declared per `RefSignal` in the IP defs. Until they were read, sharing
/// rested entirely on an analog-class heuristic plus the user's own
/// `sharedWith` whitelist — which could authorise a stack the device forbids.
#[derive(Debug, Default)]
pub struct SignalGroups {
    pub shareable: BTreeMap<String, String>,
    pub exclusive: BTreeMap<String, String>,
}

/// Stacking whitelist context threaded through the search.
struct ShareRules<'a> {
    analog: &'a BTreeSet<String>,
    shared_pads: &'a BTreeMap<String, BTreeSet<String>>,
    groups: &'a SignalGroups,
}

impl ShareRules<'_> {
    /// May `signal` join `pin` given its current `occupants`?
    fn can_join(&self, pin: &str, occupants: &[String], signal: &str) -> bool {
        if occupants.is_empty() {
            return true;
        }
        // An exclusive group overrides every permission below: the db says
        // only one of these may be routed at a time.
        if let Some(g) = self.groups.exclusive.get(signal) {
            if occupants
                .iter()
                .any(|o| self.groups.exclusive.get(o).is_some_and(|h| h == g))
            {
                return false;
            }
        }
        // (a) the db's own shareable group: every member of the stack agrees.
        if let Some(g) = self.groups.shareable.get(signal) {
            if occupants
                .iter()
                .all(|o| self.groups.shareable.get(o).is_some_and(|h| h == g))
            {
                return true;
            }
        }
        // (b) implicit analog stack: every member analog-class.
        if self.analog.contains(signal)
            && occupants.iter().all(|o| self.analog.contains(o))
        {
            return true;
        }
        // (c) the pad's gpio entry whitelists the co-signal(s).
        if let Some(allowed) = self.shared_pads.get(base_pad(pin)) {
            if allowed.contains(signal)
                && occupants.iter().all(|o| o == "GPIO" || allowed.contains(o))
            {
                return true;
            }
        }
        false
    }
}

#[allow(clippy::too_many_arguments)]
fn search(
    order: &[&SignalReq],
    idx: usize,
    candidates: &BTreeMap<&str, Vec<&str>>,
    gpio: &GpioIp,
    reserved: &BTreeSet<&str>,
    share: &ShareRules<'_>,
    used: &mut BTreeMap<String, Vec<String>>,
    remap_choice: &mut BTreeMap<String, String>,
    placements: &mut Vec<Placement>,
) -> bool {
    let Some(req) = order.get(idx) else {
        return true;
    };
    let empty = Vec::new();
    let cands = candidates.get(req.signal.as_str()).unwrap_or(&empty);

    let pins: Vec<&str> = match &req.hint {
        Some(h) => cands
            .iter()
            .copied()
            .filter(|p| *p == h.as_str() || base_pad(p) == h.as_str())
            .collect(),
        None => cands.clone(),
    };

    for pin in pins {
        if reserved.contains(pin) {
            continue;
        }
        let occupants = used.get(pin).map(Vec::as_slice).unwrap_or(&[]);
        if !share.can_join(pin, occupants, &req.signal) {
            continue;
        }
        // AF/remap binding options for this (pin, signal).
        for binding in binding_options(gpio, pin, &req.signal) {
            // F1 remap consistency: peripheral's block choice must agree.
            if let Some(block) = &binding.remap_block {
                match remap_choice.get(&req.instance) {
                    Some(chosen) if chosen != block => continue,
                    Some(_) => {}
                    None => {
                        remap_choice.insert(req.instance.clone(), block.clone());
                    }
                }
            }
            used.entry(pin.to_string()).or_default().push(req.signal.clone());
            placements.push(Placement {
                signal: req.signal.clone(),
                pin: pin.to_string(),
                af_macro: binding.af_macro.clone(),
                remap_block: binding.remap_block.clone(),
            });
            if search(
                order, idx + 1, candidates, gpio, reserved, share, used, remap_choice, placements,
            ) {
                return true;
            }
            placements.pop();
            if let Some(v) = used.get_mut(pin) {
                v.pop();
                if v.is_empty() {
                    used.remove(pin);
                }
            }
            if let Some(block) = &binding.remap_block {
                // Only undo the group choice if we introduced it here.
                if placements
                    .iter()
                    .all(|p| p.remap_block.as_ref() != Some(block))
                {
                    remap_choice.remove(&req.instance);
                }
            }
        }
    }
    false
}

/// Ways a signal can bind on a pin, deterministic order:
/// AF macro (single), else remap blocks default-first then ascending.
struct BindingOption {
    af_macro: Option<String>,
    remap_block: Option<String>,
}

fn binding_options(gpio: &GpioIp, pin: &str, signal: &str) -> Vec<BindingOption> {
    let gp = gpio
        .pins
        .get(pin)
        .or_else(|| gpio.pins.get(base_pad(pin)))
        .or_else(|| {
            gpio.pins
                .iter()
                .find(|(k, _)| base_pad(k) == base_pad(pin))
                .map(|(_, v)| v)
        });
    let Some(gp) = gp else {
        // No GPIO IP data for the pin (e.g. analog-only): bind AF-less.
        return vec![BindingOption { af_macro: None, remap_block: None }];
    };
    let Some(ps) = gp.signals.iter().find(|s| s.signal == signal) else {
        return vec![BindingOption { af_macro: None, remap_block: None }];
    };
    match &ps.binding {
        AfBinding::Af { macro_name } => vec![BindingOption {
            af_macro: Some(macro_name.clone()),
            remap_block: None,
        }],
        AfBinding::Remap { blocks } => {
            let mut opts: Vec<&stm32ck_ir::model::RemapBlockRef> = blocks.iter().collect();
            opts.sort_by_key(|b| (!b.default_remap, b.block.clone()));
            opts.into_iter()
                .map(|b| BindingOption {
                    af_macro: b.af_macro.clone(),
                    remap_block: Some(b.block.clone()),
                })
                .collect()
        }
        AfBinding::None => vec![BindingOption { af_macro: None, remap_block: None }],
    }
}

fn explain_failure(
    order: &[&SignalReq],
    candidates: &BTreeMap<&str, Vec<&str>>,
    _gpio: &GpioIp,
    reserved: &BTreeSet<&str>,
    share: &ShareRules<'_>,
    used: &BTreeMap<String, Vec<String>>,
    plan: &mut PinPlan,
) {
    for req in order {
        let empty = Vec::new();
        let cands = candidates.get(req.signal.as_str()).unwrap_or(&empty);
        if cands.is_empty() {
            plan.diags.push(Diagnostic::error(
                "PIN_NO_CANDIDATE",
                &req.path,
                format!("signal {} is not available on any pin of this package", req.signal),
            ));
            return;
        }
        let mut blockers: Vec<String> = Vec::new();
        for pin in cands {
            let occupants = used.get(*pin).map(Vec::as_slice).unwrap_or(&[]);
            if !occupants.is_empty() && !share.can_join(pin, occupants, &req.signal) {
                blockers.push(format!("{pin} taken by {}", occupants.join("+")));
            } else if reserved.contains(pin) {
                blockers.push(format!("{pin} reserved for the debug port"));
            }
        }
        if blockers.len() == cands.len() && !cands.is_empty() {
            let mut d = Diagnostic::error(
                "PIN_CONFLICT",
                &req.path,
                format!("no free pin for {}: {}", req.signal, blockers.join("; ")),
            )
            .with_suggestion(
                "free one of the listed pins, drop the debug-port reservation, or (F1) allow a different remap group",
            );
            for b in &blockers {
                d = d.with_related(b.clone());
            }
            plan.diags.push(d);
            return;
        }
    }
    plan.diags.push(Diagnostic::error(
        "PIN_UNSAT",
        "/pinout",
        "pin allocation failed: remap-group or hint constraints are jointly unsatisfiable",
    ));
}

/// "PA0-WKUP" -> "PA0"
fn base_pad(name: &str) -> &str {
    name.split(['-', '/']).next().unwrap_or(name)
}

/// Sort key: (port letter, bit number, full name) — PA0 < PA2 < PA10 < PB0.
fn pin_sort_key(name: &str) -> (char, u32, String) {
    let base = base_pad(name);
    let bytes = base.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'P' && bytes[1].is_ascii_uppercase() {
        let port = bytes[1] as char;
        let bit: u32 = base[2..].parse().unwrap_or(u32::MAX);
        (port, bit, name.to_string())
    } else {
        ('~', u32::MAX, name.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pad_sorting_and_base() {
        assert_eq!(base_pad("PA0-WKUP"), "PA0");
        assert!(pin_sort_key("PA2") < pin_sort_key("PA10"));
        assert!(pin_sort_key("PA10") < pin_sort_key("PB0"));
    }

    fn groups(shareable: &[(&str, &str)], exclusive: &[(&str, &str)]) -> SignalGroups {
        SignalGroups {
            shareable: shareable
                .iter()
                .map(|(s, g)| (s.to_string(), g.to_string()))
                .collect(),
            exclusive: exclusive
                .iter()
                .map(|(s, g)| (s.to_string(), g.to_string()))
                .collect(),
        }
    }

    /// The db's `ShareableGroupName` authorises a stack; `ExclusiveGroupName`
    /// vetoes one, and the veto outranks every other permission — including a
    /// user `sharedWith` whitelist, which cannot make a device route two
    /// mutually exclusive signals to one pad.
    #[test]
    fn db_groups_authorise_and_veto_stacking() {
        let analog: BTreeSet<String> = BTreeSet::new();
        let mut shared_pads: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        shared_pads.insert(
            "PA0".to_string(),
            ["TIM2_CH1".to_string(), "TIM2_ETR".to_string()]
                .into_iter()
                .collect(),
        );

        // Same shareable group -> allowed even with no whitelist entry.
        let g = groups(
            &[("ADC1_IN0", "ADCx_IN0"), ("ADC2_IN0", "ADCx_IN0")],
            &[],
        );
        let rules = ShareRules {
            analog: &analog,
            shared_pads: &shared_pads,
            groups: &g,
        };
        assert!(rules.can_join("PC0", &["ADC1_IN0".to_string()], "ADC2_IN0"));

        // Different shareable groups -> no permission from the db.
        let g = groups(
            &[("ADC1_IN0", "ADCx_IN0"), ("ADC2_IN1", "ADCx_IN1")],
            &[],
        );
        let rules = ShareRules {
            analog: &analog,
            shared_pads: &shared_pads,
            groups: &g,
        };
        assert!(!rules.can_join("PC0", &["ADC1_IN0".to_string()], "ADC2_IN1"));

        // Exclusive group beats the user's own sharedWith whitelist.
        let g = groups(
            &[],
            &[
                ("TIM2_CH1", "S_TIM2_CH1_ETR"),
                ("TIM2_ETR", "S_TIM2_CH1_ETR"),
            ],
        );
        let rules = ShareRules {
            analog: &analog,
            shared_pads: &shared_pads,
            groups: &g,
        };
        assert!(
            !rules.can_join("PA0", &["TIM2_CH1".to_string()], "TIM2_ETR"),
            "an exclusive group must not be overridable by sharedWith"
        );
    }
}
