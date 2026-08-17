//! Clock tree: graph construction, forward frequency propagation,
//! constraint checking, and deterministic target solving.
//!
//! The graph comes from `db/plugins/clock/<tree>.xml` (topology) and the
//! RCC IP def (per-node domains + min/max assertions). Node arithmetic is
//! fully determined by the element kind + its bound RefParameter:
//!
//! - FixedSource:   freq = resolved RefParameter default (HSI/LSI)
//! - VariedSource:  freq = user-supplied value (HSE/LSE), range-checked
//! - Divisor:       out = in / factor   (factor from list `Comment` or int param)
//! - Multiplicator: out = in * factor
//! - MultiplicatorFrac: out = in * (factor + FRACN/2^13) — the fractional
//!   PLL of the H5/H7/U5/N6/WBA-class trees. The FRACN field arrives as a
//!   second input edge from a `Fractional` element (see [`fractional_addend`]).
//! - Fractional:    carries the FRACN field value; contributes no frequency
//!   of its own, only the addend its `multiplicatorFrac` consumer applies.
//! - Multiplexor:   out = selected input (selector enum -> edge refValue)
//! - Output/ActiveOutput: pass-through; resolved RefParameter Min/Max are
//!   the assertions; propagated value is published to the blackboard under
//!   the RefParameter name (that's how `SYSCLKFreq_VALUE > x` conditions
//!   see frequencies).

use crate::diag::Diagnostic;
use crate::env::{Env, Value};
use crate::eval::{eval_condition, EvalTrace};
use std::collections::{BTreeMap, BTreeSet};
use stm32ck_ir::expr::Num;
use stm32ck_ir::model::{ClockElement, ClockElementKind, ClockTree, IpDef};

/// A clock graph specialized for one part + current env (conditional
/// duplicate elements resolved first-match-wins).
pub struct ClockGraph<'a> {
    pub tree: &'a ClockTree,
    pub rcc: &'a IpDef,
    /// element id -> chosen element (doc-order first whose condition holds)
    pub elements: BTreeMap<&'a str, &'a ClockElement>,
    /// RefParameter name -> doc-ordered overloads (hot-path index).
    pub param_index: BTreeMap<&'a str, Vec<&'a stm32ck_ir::model::RefParameter>>,
}

impl<'a> ClockGraph<'a> {
    pub fn build(tree: &'a ClockTree, rcc: &'a IpDef, env: &Env, trace: &mut EvalTrace) -> Self {
        let mut elements: BTreeMap<&str, &ClockElement> = BTreeMap::new();
        for el in &tree.elements {
            if elements.contains_key(el.id.as_str()) {
                continue; // first match already chosen
            }
            let applicable = match &el.condition {
                None => true,
                Some(c) => eval_condition(c, env, trace),
            };
            if applicable {
                elements.insert(el.id.as_str(), el);
            }
        }
        let mut param_index: BTreeMap<&str, Vec<&stm32ck_ir::model::RefParameter>> =
            BTreeMap::new();
        for rp in &rcc.ref_parameters {
            param_index.entry(rp.name.as_str()).or_default().push(rp);
        }
        Self {
            tree,
            rcc,
            elements,
            param_index,
        }
    }

    /// The db binds some elements to a comma-separated alias list
    /// ("PLLSourceVirtual,PLLSource"). Canonical name = first alias with a
    /// RefParameter definition, else the first alias verbatim.
    pub fn canonical_param<'n>(&self, name: &'n str) -> &'n str {
        name.split(',')
            .map(str::trim)
            .find(|n| self.param_index.contains_key(n))
            .unwrap_or_else(|| name.split(',').next().unwrap_or(name).trim())
    }

    /// First overload whose condition holds (see params::resolve_overload).
    /// Alias-list aware: tries each comma-separated alias in order.
    pub fn resolve_rcc(
        &self,
        name: &str,
        env: &Env,
        trace: &mut EvalTrace,
    ) -> Option<&'a stm32ck_ir::model::RefParameter> {
        name.split(',').map(str::trim).find_map(|n| {
            crate::params::resolve_overload(
                self.param_index.get(n)?.iter().copied(),
                env,
                trace,
            )
        })
    }

    /// Deterministic topological order (Kahn over input edges, BTreeMap
    /// iteration order breaks ties).
    pub fn topo_order(&self) -> Vec<&'a ClockElement> {
        let mut indeg: BTreeMap<&str, usize> = BTreeMap::new();
        for (id, el) in &self.elements {
            indeg.entry(id).or_insert(0);
            let _ = el;
        }
        for el in self.elements.values() {
            for input in &el.inputs {
                if self.elements.contains_key(input.peer.as_str()) {
                    *indeg.entry(el.id.as_str()).or_insert(0) += 1;
                }
            }
        }
        let mut ready: Vec<&str> = indeg
            .iter()
            .filter(|(_, d)| **d == 0)
            .map(|(id, _)| *id)
            .collect();
        let mut order = Vec::new();
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        while let Some(id) = ready.pop() {
            if !seen.insert(id) {
                continue;
            }
            let el = self.elements[id];
            order.push(el);
            // Decrement consumers (doc-order via outputs, then BTree order).
            let mut consumers: Vec<&str> = self
                .elements
                .values()
                .filter(|c| c.inputs.iter().any(|i| i.peer == id))
                .map(|c| c.id.as_str())
                .collect();
            consumers.sort();
            for c in consumers {
                let d = indeg.get_mut(c).unwrap();
                *d = d.saturating_sub(1);
                if *d == 0 {
                    ready.push(c);
                }
            }
            ready.sort();
        }
        order
    }
}

/// Alias-list aware env lookup (see [`ClockGraph::canonical_param`]).
pub(crate) fn env_get_alias<'e>(env: &'e Env, name: &str) -> Option<&'e Value> {
    name.split(',').map(str::trim).find_map(|n| env.get(n))
}

/// Result of forward propagation.
#[derive(Debug, Default, Clone)]
pub struct Propagation {
    /// element id -> frequency (Hz, exact).
    pub freqs: BTreeMap<String, Num>,
    pub diags: Vec<Diagnostic>,
}

/// Propagate frequencies through the graph given current env (assignments
/// + source freqs must already be in env under their RefParameter names).
/// Publishes output-node frequencies into `env` under their RefParameter
/// names. Params in `pending` (solver free variables not yet assigned)
/// contribute no frequency — their nodes stay dark instead of defaulting,
/// so partial solver states never raise phantom violations.
pub fn propagate(
    graph: &ClockGraph<'_>,
    env: &mut Env,
    trace: &mut EvalTrace,
    pending: &BTreeSet<String>,
) -> Propagation {
    let mut out = Propagation::default();
    let order = graph.topo_order();

    for el in &order {
        let in_freq = |prop: &Propagation, el: &ClockElement, sel: Option<&str>| -> Option<Num> {
            match sel {
                // Mux: input edge whose refValue == selector value.
                Some(sel) => el
                    .inputs
                    .iter()
                    .find(|e| e.ref_value.as_deref() == Some(sel))
                    .and_then(|e| prop.freqs.get(&e.peer).copied()),
                // Single-input nodes: first input that has a frequency.
                None => el
                    .inputs
                    .iter()
                    .find_map(|e| prop.freqs.get(&e.peer).copied()),
            }
        };

        let freq: Option<Num> = match el.kind {
            ClockElementKind::FixedSource | ClockElementKind::VariedSource => {
                // Value must be present in env under the RefParameter name
                // (HSI default seeded by caller; HSE from user config).
                el.ref_parameter
                    .as_deref()
                    .and_then(|p| env_get_alias(env, p))
                    .and_then(|v| v.as_num())
            }
            ClockElementKind::DistinctValsSource => {
                if el.ref_parameter.as_deref().is_some_and(|p| {
                    p.split(',').any(|n| pending.contains(n.trim()))
                }) {
                    continue;
                }
                el.ref_parameter
                    .as_deref()
                    .and_then(|p| distinct_source_freq(graph, p, env, trace))
            }
            ClockElementKind::Divisor
            | ClockElementKind::Multiplicator
            | ClockElementKind::MultiplicatorFrac => {
                if el.ref_parameter.as_deref().is_some_and(|p| {
                    p.split(',').any(|n| pending.contains(n.trim()))
                }) {
                    continue;
                }
                // The fractional input edge carries no frequency, so the
                // `None` selector below naturally lands on the real input.
                let input = in_freq(&out, el, None);
                let factor = el
                    .ref_parameter
                    .as_deref()
                    .and_then(|p| node_factor(graph, p, env, trace))
                    .map(|f| match el.kind {
                        ClockElementKind::MultiplicatorFrac => {
                            f + fractional_addend(graph, el, env, pending, trace)
                        }
                        _ => f,
                    });
                match (input, factor) {
                    (Some(i), Some(f)) if *f.numer() != 0 => Some(match el.kind {
                        ClockElementKind::Divisor => i / f,
                        _ => i * f,
                    }),
                    _ => None,
                }
            }
            ClockElementKind::Multiplexor => {
                if el.ref_parameter.as_deref().is_some_and(|p| {
                    p.split(',').any(|n| pending.contains(n.trim()))
                }) {
                    continue;
                }
                let sel = el
                    .ref_parameter
                    .as_deref()
                    .and_then(|p| env_get_alias(env, p))
                    .map(|v| v.as_str());
                match sel {
                    Some(sel) => in_freq(&out, el, Some(&sel)),
                    None => None,
                }
            }
            ClockElementKind::Output | ClockElementKind::ActiveOutput => in_freq(&out, el, None),
            // A FRACN register field, not a clock: its value is consumed by
            // the `multiplicatorFrac` node downstream, never propagated.
            ClockElementKind::Fractional => None,
        };

        if let Some(f) = freq {
            out.freqs.insert(el.id.clone(), f);
            // Publish to blackboard under the bound parameter name(s) so
            // conditions like `SYSCLKFreq_VALUE > 24000000` can see it.
            if let Some(p) = el.ref_parameter.as_deref() {
                if matches!(
                    el.kind,
                    ClockElementKind::Output | ClockElementKind::ActiveOutput
                ) {
                    for n in p.split(',') {
                        env.set(n.trim(), Value::Num(f));
                    }
                }
            }
        }
    }
    out
}

/// The frequency a `distinctValsSource` currently produces.
///
/// The selected `PossibleValue`'s comment is the frequency, expressed in the
/// parameter's own `Unit` — `RCC_MSIRANGE_6` comments `4000` on a parameter
/// marked `Unit="KHz"`, i.e. 4 MHz. Same lookup as [`node_factor`]; only the
/// unit scaling differs, because here the number is a frequency rather than a
/// ratio.
fn distinct_source_freq(
    graph: &ClockGraph<'_>,
    param_name: &str,
    env: &Env,
    trace: &mut EvalTrace,
) -> Option<Num> {
    let rp = graph.resolve_rcc(param_name, env, trace)?;
    let scale = match rp.unit.trim().to_ascii_uppercase().as_str() {
        "HZ" | "" => 1,
        "KHZ" => 1_000,
        "MHZ" => 1_000_000,
        _ => 1,
    };
    node_factor(graph, param_name, env, trace).map(|f| f * Num::from_integer(scale))
}

/// The numeric factor of a divider/multiplier node: from the assigned enum
/// value's `factor` (list domains), or the assigned/default integer value.
fn node_factor(
    graph: &ClockGraph<'_>,
    param_name: &str,
    env: &Env,
    trace: &mut EvalTrace,
) -> Option<Num> {
    let assigned = env_get_alias(env, param_name).cloned();
    let rp = graph.resolve_rcc(param_name, env, trace)?;
    if !rp.possible_values.is_empty() {
        let sel = assigned
            .map(|v| v.as_str())
            .unwrap_or_else(|| rp.default_value.clone());
        return rp
            .possible_values
            .iter()
            .find(|pv| pv.value == sel)
            .and_then(|pv| pv.factor);
    }
    match assigned {
        Some(v) => v.as_num(),
        None => stm32ck_ir::expr::parse_number(rp.default_value.trim()),
    }
}

/// The fractional part a `multiplicatorFrac` node adds to its integer
/// factor: `FRACN / (FRACN_max + 1)`, read off the `fractional` element
/// wired into it. Every family shipping one today uses a 13-bit field
/// (`Max="8191"` -> /8192), but the width is taken from the data rather than
/// assumed, so a future wider field needs no code change.
///
/// Zero when the node has no fractional input, when the field resolves to
/// its default 0, or while FRACN is still an unassigned solver variable —
/// all three mean "integer PLL", which is what CubeMX emits unless the user
/// asks for a fractional ratio.
fn fractional_addend(
    graph: &ClockGraph<'_>,
    el: &ClockElement,
    env: &Env,
    pending: &BTreeSet<String>,
    trace: &mut EvalTrace,
) -> Num {
    let zero = Num::from_integer(0);
    let Some(peer) = el
        .inputs
        .iter()
        .filter_map(|e| graph.elements.get(e.peer.as_str()))
        .find(|p| p.kind == ClockElementKind::Fractional)
    else {
        return zero;
    };
    let Some(pname) = peer.ref_parameter.as_deref() else {
        return zero;
    };
    if pname.split(',').any(|n| pending.contains(n.trim())) {
        return zero;
    }
    let Some(rp) = graph.resolve_rcc(pname, env, trace) else {
        return zero;
    };
    let width = rp.max.map_or(zero, |m| m + Num::from_integer(1));
    if *width.numer() == 0 {
        return zero;
    }
    let value = env_get_alias(env, pname)
        .and_then(|v| v.as_num())
        .or_else(|| stm32ck_ir::expr::parse_number(rp.default_value.trim()))
        .unwrap_or(zero);
    value / width
}

/// refEnable gating: a node with enable parameters only constrains the tree
/// while one of them is truthy. Nodes still propagate a frequency when gated
/// off (the graph has no notion of a dark wire), so every range assertion
/// has to consult this first — the USB 48 MHz window must not fire with USB
/// unused, and `HSERTCDevisor` must not fire with the RTC not on HSE.
fn node_enabled(graph: &ClockGraph<'_>, el: &ClockElement, env: &Env) -> bool {
    if !el.ref_enable.is_empty()
        && !el
            .ref_enable
            .iter()
            .any(|p| env.get(p).is_some_and(|v| v.truthy()) || env.semaphores.contains(p))
    {
        return false;
    }
    // A PLL that nothing consumes is dark even though its nodes carry no
    // refEnable: the db states that separately, as the `<PLL>Used` parameter
    // its own overload guards key off (G0's `PLLRCLKFreq_Value` widens from
    // 16 to 64 MHz only under `PLLUsed=1 & SysSourcePLL`). Without this, a
    // device left on HSI reports its unused PLL's idle frequency as a range
    // violation.
    if let Some(used) = pll_used_param(graph, &el.id) {
        return env
            .get(&used)
            .is_some_and(|v| v.truthy() || v.as_num().is_some_and(|n| *n.numer() != 0));
    }
    true
}

/// `PLLR` -> `PLLUsed`, `PLL2M` -> `PLL2Used` — the `<PLL><n>Used` parameter
/// covering an element, if the RCC def has one. `None` for elements outside
/// a PLL.
fn pll_used_param(graph: &ClockGraph<'_>, id: &str) -> Option<String> {
    let rest = id.strip_prefix("PLL")?;
    let index: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let name = format!("PLL{index}Used");
    let has = |n: &str| graph.rcc.ref_parameters.iter().any(|rp| rp.name == n);
    if has(&name) {
        Some(name)
    } else if !index.is_empty() && has("PLLUsed") {
        Some("PLLUsed".to_string())
    } else {
        None
    }
}

/// Per-*wire* range assertions. The tree's `<Signals>` catalog binds edge
/// signal ids to RefParameters, and for intermediate wires that is the ONLY
/// place their limits live — an element carries the parameter that shapes it
/// (`DIVM1`, `DIVN1`), while the signal carries what the wire may reach
/// (`VCOInput1Freq_Value` 1..16 MHz, `VCO1OutputFreq_Value` 150..960 MHz).
/// A wire's frequency is the frequency of the element driving it.
fn check_signal_ranges(
    graph: &ClockGraph<'_>,
    prop: &Propagation,
    env: &Env,
    trace: &mut EvalTrace,
) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    // (driving element, signal) pairs — an element fanning the same signal
    // out to three consumers must not report the same violation three times.
    let mut seen: BTreeSet<(&str, &str)> = BTreeSet::new();
    for (id, freq) in &prop.freqs {
        let el = graph.elements[id.as_str()];
        if !node_enabled(graph, el, env) {
            continue;
        }
        for edge in &el.outputs {
            if !seen.insert((id.as_str(), edge.signal_id.as_str())) {
                continue;
            }
            let Some(pname) = graph.tree.signals.get(&edge.signal_id) else {
                continue;
            };
            if pname.is_empty() {
                continue;
            }
            let Some(rp) = graph.resolve_rcc(pname, env, &mut *trace) else {
                continue;
            };
            if rp.param_type != "double" && rp.param_type != "integer" {
                continue;
            }
            // Min==Max marks a fixed constant, not a window.
            if rp.min.is_some() && rp.min == rp.max {
                continue;
            }
            let over = rp.max.is_some_and(|m| *freq > m);
            let under = rp.min.is_some_and(|m| *freq < m);
            if !over && !under {
                continue;
            }
            let (bound, word, fix) = if over {
                (rp.max.unwrap(), "exceeds the maximum", "lower")
            } else {
                (rp.min.unwrap(), "is below the minimum", "raise")
            };
            diags.push(
                Diagnostic::error(
                    "CLK_RANGE",
                    format!("/clock/{id}"),
                    format!(
                        "{} = {} Hz {word} {} Hz ({})",
                        edge.signal_id,
                        fmt_num(*freq),
                        fmt_num(bound),
                        nonempty(&rp.comment, pname),
                    ),
                )
                .with_suggestion(format!(
                    "{fix} {} to {} {} Hz",
                    edge.signal_id,
                    if over { "at most" } else { "at least" },
                    fmt_num(bound),
                )),
            );
        }
    }
    diags
}

/// After propagation: check every frequency-bearing node against the
/// resolved Min/Max of its RefParameter (this is where per-die SYSCLK
/// maxima, VCO windows and the USB ±0.25% window live).
pub fn check_constraints(
    graph: &ClockGraph<'_>,
    prop: &Propagation,
    env: &Env,
    trace: &mut EvalTrace,
) -> Vec<Diagnostic> {
    let mut diags = check_signal_ranges(graph, prop, env, trace);
    for (id, freq) in &prop.freqs {
        let el = graph.elements[id.as_str()];
        if !node_enabled(graph, el, env) {
            continue;
        }
        // Edge-bound bounds. CubeMX hangs a second family of frequency
        // limits on the *signals* (edges), not on the nodes: on F4 the whole
        // PLL VCO window lives there (`<Signal id="VCOInput"
        // refParameter="VCOInputFreq_Value"/>`) and no element binds it.
        // `Element.checkConstraints` walks `getOutputSignals()` for every
        // node whose own field is not editable, so the check has to run
        // before the per-kind early returns below — a divider's factor check
        // must not swallow its output-signal check. 0 Hz is exempt, matching
        // `Signal.checkSignalFreqConstraints` (an unrouted branch is not a
        // violation).
        for edge in &el.outputs {
            if *freq.numer() == 0 {
                break;
            }
            let Some(sig_param) = graph.tree.signals.get(&edge.signal_id) else {
                continue;
            };
            if sig_param.is_empty() {
                continue;
            }
            let Some(srp) = graph.resolve_rcc(sig_param, env, &mut *trace) else {
                continue;
            };
            if srp.param_type != "double" && srp.param_type != "integer" {
                continue;
            }
            if srp.min.is_some() && srp.min == srp.max {
                continue;
            }
            for (bound, over) in [(srp.min, false), (srp.max, true)] {
                let Some(m) = bound else { continue };
                if (over && *freq <= m) || (!over && *freq >= m) {
                    continue;
                }
                let (rel, fix) = if over { ("exceeds", "lower") } else { ("is below", "raise") };
                diags.push(
                    Diagnostic::error(
                        "CLK_RANGE",
                        format!("/clock/{}", edge.signal_id),
                        format!(
                            "{} = {} Hz {} the {} {} Hz ({})",
                            edge.signal_id,
                            fmt_num(*freq),
                            rel,
                            if over { "maximum" } else { "minimum" },
                            fmt_num(m),
                            nonempty(&srp.comment, sig_param),
                        ),
                    )
                    .with_suggestion(format!(
                        "{fix} {} to {} {} Hz",
                        edge.signal_id,
                        if over { "at most" } else { "at least" },
                        fmt_num(m)
                    )),
                );
            }
        }
        let Some(pname) = el.ref_parameter.as_deref() else {
            continue;
        };
        let Some(rp) = graph.resolve_rcc(pname, env, &mut *trace) else {
            continue;
        };
        // Divider/multiplier params bound their FACTOR (PLLN 50..432), not
        // the node's output frequency — validate the factor and move on.
        // A fractional multiplier is checked on its integer part: FRACN has
        // its own Min/Max on the `fractional` element's parameter.
        if matches!(
            el.kind,
            ClockElementKind::Divisor
                | ClockElementKind::Multiplicator
                | ClockElementKind::MultiplicatorFrac
        ) {
            if rp.possible_values.is_empty() {
                if let Some(f) = node_factor(graph, pname, env, trace) {
                    if rp.min.is_some_and(|m| f < m) || rp.max.is_some_and(|m| f > m) {
                        diags.push(Diagnostic::error(
                            "CLK_FACTOR",
                            format!("/clock/{id}"),
                            format!(
                                "{pname} = {} outside its legal range [{} .. {}]",
                                fmt_num(f),
                                rp.min.map(fmt_num).unwrap_or_else(|| "-".into()),
                                rp.max.map(fmt_num).unwrap_or_else(|| "-".into()),
                            ),
                        ));
                    }
                }
            }
            continue;
        }
        if el.kind == ClockElementKind::Multiplexor {
            continue;
        }
        // Only frequency-typed params carry meaningful Hz bounds here.
        if rp.param_type != "double" && rp.param_type != "integer" {
            continue;
        }
        let (min, max) = (rp.min, rp.max);
        // Skip pure-fixed factor params (Min==Max used as constants).
        if min.is_some() && min == max {
            continue;
        }
        if let Some(m) = min {
            if *freq < m {
                diags.push(
                    Diagnostic::error(
                        "CLK_RANGE",
                        format!("/clock/{id}"),
                        format!(
                            "{id} = {} Hz is below the minimum {} Hz ({})",
                            fmt_num(*freq),
                            fmt_num(m),
                            nonempty(&rp.comment, pname),
                        ),
                    )
                    .with_suggestion(format!("raise {id} to at least {} Hz", fmt_num(m))),
                );
            }
        }
        if let Some(m) = max {
            if *freq > m {
                diags.push(
                    Diagnostic::error(
                        "CLK_RANGE",
                        format!("/clock/{id}"),
                        format!(
                            "{id} = {} Hz exceeds the maximum {} Hz ({})",
                            fmt_num(*freq),
                            fmt_num(m),
                            nonempty(&rp.comment, pname),
                        ),
                    )
                    .with_suggestion(format!("lower {id} to at most {} Hz", fmt_num(m))),
                );
            }
        }
    }
    diags
}

/// Resolve defaults for RCC parameters that the user did not assign and
/// that have a forced/conditional default (PLLUsed, APBxTimCLKDivider,
/// FLatency, VOS...). Returns true if env changed (fixpoint driver).
/// Publish the `PossibleValue@Semaphore` flag of every parameter *bound to a
/// clock element* whose current value selects one, and retract the ones this
/// pass published earlier that no longer apply.
///
/// CubeMX raises these the instant a selection lands, and a whole family of
/// constraints keys off them. The PLL input and VCO windows of the
/// H5/H7/U5-class trees are the sharp case: their Min/Max live *only* on an
/// overload conditioned on `SYSCLKSOURCE_PLLCLK`, so without the flag the
/// unconstrained fallback overload wins and nothing stops the solver from
/// picking a 64 MHz PLL input driving a 1.6 GHz VCO.
///
/// Two kinds of parameter qualify:
///
/// * bound to a clock element — they describe how the tree is wired
///   (`SYSCLKSource` -> `SYSCLKSOURCE_PLLCLK`);
/// * condition-selected, i.e. carrying at least one conditioned overload —
///   the db *computes* these from device state, so their selection is a fact
///   about the configuration. H7's `PWR_Regulator_Voltage_Scale` picks
///   `scale1` from the CPU frequency, and `scale1` is what unlocks the
///   FLatency overload that says 200 MHz HCLK needs 2 wait states.
///
/// Everything else is excluded, because an RCC def also carries parameters
/// that never reach the graph and whose single unconditional `DefaultValue`
/// is a UI placeholder: F4's `FamilyName` defaults to the value publishing
/// `TM`, which would flip `SYSCLKFreq_VALUE` onto its 84 MHz overload and
/// make 168 MHz unreachable on an F405.
///
/// Ownership is tracked in `owned` so that a flag already raised by another
/// mechanism (the peripheral fixpoint) is never retracted here. Returns true
/// when the published set changed — the caller's fixpoint must then
/// re-resolve overloads.
fn sync_value_semaphores(
    graph: &ClockGraph<'_>,
    env: &mut Env,
    trace: &mut EvalTrace,
    owned: &mut BTreeSet<String>,
) -> bool {
    let mut eligible: BTreeSet<&str> = graph
        .elements
        .values()
        .filter_map(|el| el.ref_parameter.as_deref())
        .flat_map(|p| p.split(',').map(str::trim))
        .collect();
    eligible.extend(
        graph
            .param_index
            .iter()
            .filter(|(_, overloads)| overloads.iter().any(|rp| rp.condition.is_some()))
            .map(|(name, _)| *name),
    );
    let mut want: BTreeSet<String> = BTreeSet::new();
    for name in eligible {
        let Some(value) = env_get_alias(env, name).map(|v| v.as_str()) else {
            continue;
        };
        let Some(rp) = graph.resolve_rcc(name, env, trace) else {
            continue;
        };
        if let Some(sem) = rp
            .possible_values
            .iter()
            .find(|pv| pv.value == value)
            .and_then(|pv| pv.semaphore.as_ref())
        {
            want.insert(sem.clone());
        }
    }
    let mut changed = false;
    for stale in owned.difference(&want).cloned().collect::<Vec<_>>() {
        env.semaphores.remove(&stale);
        owned.remove(&stale);
        changed = true;
    }
    for sem in &want {
        // Leave flags raised elsewhere alone — they are not ours to retract.
        if env.semaphores.insert(sem.clone()) {
            owned.insert(sem.clone());
            changed = true;
        }
    }
    changed
}

pub fn apply_rcc_defaults(
    graph: &ClockGraph<'_>,
    user_assigned: &BTreeSet<String>,
    env: &mut Env,
    trace: &mut EvalTrace,
) -> bool {
    let mut changed = false;
    for name in graph.param_index.keys().copied().collect::<Vec<_>>() {
        if user_assigned.contains(name) {
            continue;
        }
        let Some(rp) = graph.resolve_rcc(name, env, trace) else {
            continue;
        };
        let dv = rp.default_value.trim();
        if dv.is_empty() || dv == "null" || dv.starts_with('+') || dv.starts_with('=') {
            continue; // codegen indirections are not blackboard values
        }
        // uniqueElementList (FLatency style): the conditioned overload's
        // single PossibleValue *is* the forced value.
        let value = if rp.param_type == "uniqueElementList" {
            match rp.possible_values.first() {
                Some(pv) => pv.value.clone(),
                None => dv.to_string(),
            }
        } else {
            dv.to_string()
        };
        let new = match stm32ck_ir::expr::parse_number(&value) {
            Some(n) => Value::Num(n),
            None => Value::Str(value),
        };
        if env.get(name) != Some(&new) {
            if std::env::var("STM32CK_TRACE").is_ok() {
                eprintln!(
                    "  default flip: {name}: {:?} -> {:?}",
                    env.get(name).map(|v| v.as_str()),
                    new.as_str()
                );
            }
            env.set(name.to_string(), new);
            changed = true;
        }
    }
    changed
}

/// Full clock validation: fixpoint of {propagate, defaults}, then checks.
pub fn validate_clock(
    graph: &ClockGraph<'_>,
    user_assigned: &BTreeSet<String>,
    pending: &BTreeSet<String>,
    env: &mut Env,
    trace: &mut EvalTrace,
) -> (Propagation, Vec<Diagnostic>) {
    // Params bound to output nodes are *computed* by propagation; the
    // defaults pass must never fight over them (their RefParameter default
    // is only the UI's initial display value).
    let mut assigned_or_computed = user_assigned.clone();
    for el in graph.elements.values() {
        if matches!(
            el.kind,
            ClockElementKind::Output | ClockElementKind::ActiveOutput
        ) {
            if let Some(p) = el.ref_parameter.as_deref() {
                assigned_or_computed.insert(p.to_string());
            }
        }
    }
    let mut prop = Propagation::default();
    // Semaphores this loop published from list-parameter selections; tracked
    // so a default that flips between rounds retracts its stale flag.
    let mut owned_sems: BTreeSet<String> = BTreeSet::new();
    for _round in 0..64 {
        prop = propagate(graph, env, trace, pending);
        let mut changed = sync_value_semaphores(graph, env, trace, &mut owned_sems);
        changed |= apply_rcc_defaults(graph, &assigned_or_computed, env, trace);
        if !changed {
            let mut diags = check_constraints(graph, &prop, env, trace);
            diags.extend(prop.diags.clone());
            return (prop, diags);
        }
    }
    let mut diags = vec![Diagnostic::error(
        "CLK_FIXPOINT",
        "/clock",
        "clock parameter propagation did not converge within 64 rounds (oscillating db conditions)",
    )];
    diags.extend(prop.diags.clone());
    (prop, diags)
}

fn fmt_num(n: Num) -> String {
    if n.is_integer() {
        n.numer().to_string()
    } else {
        format!("{n}")
    }
}

fn nonempty<'x>(s: &'x str, fallback: &'x str) -> &'x str {
    if s.is_empty() {
        fallback
    } else {
        s
    }
}
