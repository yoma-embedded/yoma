//! Deterministic clock target solver.
//!
//! Free variables = the RefParameters bound to mux/divider/multiplier nodes
//! that the user did not assign. Domains are finite (enum factor lists or
//! bounded integer ranges). Search = DFS in topological node order with
//! partial-propagation pruning; result selection is by a fixed, documented
//! score, ties broken by first-found under deterministic iteration order:
//!
//! 1. every Exact target hit (mandatory)
//! 2. every atMost/atLeast target as close to its bound as achievable
//!    (atMost: the fastest frequency not above; atLeast: the slowest not
//!    below) — when the bound is not exactly reachable the search runs to
//!    its budget and returns the closest solution found, which stays
//!    deterministic because the budget is a pure function of the config
//! 3. prefer configurations using HSE when an HSE source is configured
//! 4. fewer distinct non-default assignments
//! 5. first found (domain doc-order / ascending integers)
//!
//! Inequality targets forfeit the exhaustive rule-3/4 tie-break below a
//! fully-determined node (first-legal completion, first-found among equal
//! distances) — that trade is what keeps "fastest under the bound" from
//! re-walking the whole tail product per candidate frequency.

use crate::clock::{env_get_alias, validate_clock, ClockGraph};
use crate::diag::Diagnostic;
use crate::env::{Env, Value};
use crate::eval::EvalTrace;
use crate::params::{effective_domain, resolve_param};
use std::collections::{BTreeMap, BTreeSet};
use stm32ck_ir::expr::Num;
use stm32ck_ir::model::ClockElementKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetKind {
    Exact,
    AtMost,
    AtLeast,
}

#[derive(Debug, Clone)]
pub struct SolveTarget {
    /// Element id, RefParameter name, or shorthand ("SYSCLK" matches the
    /// node bound to "SYSCLKFreq_VALUE").
    pub node: String,
    pub hz: Num,
    pub kind: TargetKind,
}

#[derive(Debug, Clone)]
pub struct Solution {
    /// param name -> chosen value (enum literal or integer string).
    pub assignments: BTreeMap<String, String>,
    /// element id -> resulting frequency.
    pub freqs: BTreeMap<String, Num>,
}

/// Bounded domain of one free variable.
struct FreeVar {
    param: String,
    values: Vec<String>,
}

const MAX_INT_DOMAIN: i64 = 1024;

/// Search budget, in states x free-parameters — see [`visit_budget`].
///
/// A flat state count is the wrong currency, because a state is not a fixed
/// amount of work: `dfs` clones the env and re-propagates the whole tree at
/// every node, and that costs ~0.15 ms on an F411 and ~3.2 ms on an H563 — a
/// 20x spread. Dividing by the free-parameter count (20 on F411, 29 on U083,
/// 75 on H563) tracks the spread and turns the budget into something close to
/// a wall-clock bound, while staying a pure function of the config and the
/// pack, so output is still reproducible on any machine.
///
/// The number straddles two very different costs. FINDING a solution is
/// usually cheap — 23 states for the F4 ODrive board, 606 for a G473 motor
/// board — but not always: a U083 at 56 MHz needs 23_949, an H563 at 250 MHz
/// 10_186. PROVING there is none means exhausting the space: 90_990 states to
/// establish that a G071 cannot be driven to 64 MHz from an 8 MHz crystal,
/// and that verdict is worth keeping, because "impossible" beats "gave up".
/// That proof is what sets the constant — 23 free parameters x 90_990 states
/// = 2_092_770 units — and 2_400_000 clears it while capping the
/// hopeless cases near 100 s — where the old flat 5_000_000 ceiling let an
/// unreachable H5 target grind past 600 s without even exhausting itself, so
/// the caller saw a hang rather than an answer.
///
/// 100 s is still poor, and no choice of constant fixes that: the cheapest
/// legitimate budget that keeps U083 solvable is already ~4x the states an
/// H563 can afford in 20 s. The fix is a cheaper state, not a smaller number
/// — `targets_ready_at` is one global depth shared by every target, so
/// nothing prunes until nearly all variables are bound. This constant only
/// bounds the damage until per-target ready depths exist.
const VISIT_BUDGET_UNITS: u64 = 2_400_000;

/// Never go below this, however wide the tree: a budget under the cost of
/// simply walking to the first leaf would fail configurations that have an
/// obvious answer.
const MIN_VISITS: u64 = 5_000;

fn visit_budget(free_params: usize) -> u64 {
    (VISIT_BUDGET_UNITS / free_params.max(1) as u64).max(MIN_VISITS)
}

pub fn solve_clock(
    graph: &ClockGraph<'_>,
    base_env: &Env,
    user_assigned: &BTreeSet<String>,
    targets: &[SolveTarget],
) -> Result<Solution, Vec<Diagnostic>> {
    let mut trace = EvalTrace::default();

    // Resolve target node ids up front.
    let mut resolved_targets: Vec<(String, Num, TargetKind)> = Vec::new();
    for t in targets {
        match resolve_target_node(graph, &t.node) {
            Some(id) => resolved_targets.push((id, t.hz, t.kind)),
            None => {
                return Err(vec![Diagnostic::error(
                    "CLK_TARGET",
                    format!("/clock/targets/{}", t.node),
                    format!("unknown clock target `{}` for this device", t.node),
                )])
            }
        }
    }

    // Collect free variables in topological order (assign upstream first).
    let mut free: Vec<FreeVar> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for el in graph.topo_order() {
        let Some(bound) = el.ref_parameter.as_deref() else {
            continue;
        };
        // Alias lists ("PLLSourceVirtual,PLLSource") collapse to the first
        // alias the RCC IP actually defines.
        let pname = graph.canonical_param(bound);
        if bound
            .split(',')
            .any(|n| user_assigned.contains(n.trim()))
            || !seen.insert(pname.to_string())
        {
            continue;
        }
        // `Fractional` (FRACN) is deliberately NOT searched: its 13-bit
        // domain dwarfs MAX_INT_DOMAIN and leaving it at the default 0 is
        // what makes a fractional PLL behave as an integer one — the ratios
        // users ask for (400/480/250 MHz) are all integer-reachable.
        if !matches!(
            el.kind,
            ClockElementKind::Multiplexor
                | ClockElementKind::Divisor
                | ClockElementKind::Multiplicator
                | ClockElementKind::MultiplicatorFrac
        ) {
            continue;
        }
        let Some(rp) = resolve_param(graph.rcc, pname, base_env, &mut trace) else {
            continue;
        };
        let values: Vec<String> = if !rp.possible_values.is_empty() {
            let dom = effective_domain(rp, base_env, &mut trace);
            dom.values.iter().map(|pv| pv.value.clone()).collect()
        } else {
            match (rp.min, rp.max) {
                (Some(min), Some(max)) if min.is_integer() && max.is_integer() => {
                    let (a, b) = (*min.numer(), *max.numer());
                    if b - a > MAX_INT_DOMAIN {
                        return Err(vec![Diagnostic::error(
                            "CLK_DOMAIN",
                            format!("/clock/{}", el.id),
                            format!(
                                "integer domain of {pname} ({a}..={b}) too large for the v1 solver"
                            ),
                        )]);
                    }
                    (a..=b).map(|v| v.to_string()).collect()
                }
                _ => continue, // unconstrained non-list param: leave to defaults
            }
        };
        if values.len() > 1 {
            // Source preference belongs in the SEARCH ORDER, not in the leaf
            // score: the penalty is only computable at a full assignment, so
            // scoring alone cannot prune the HSI subtree — the solver would
            // exhaust PLLM x PLLN before ever trying an HSE branch. Putting
            // HSE-valued options first on mux selectors makes the first
            // solution found the preferred one, which is also what the
            // zero-penalty early exit needs to stay cheap.
            let mut values = values;
            if el.kind == ClockElementKind::Multiplexor && base_env.get("HSE_VALUE").is_some() {
                values.sort_by_key(|v| !v.to_uppercase().contains("HSE"));
            }
            free.push(FreeVar {
                param: pname.to_string(),
                values,
            });
        }
    }

    // Score rule 2 prefers HSE, but scoring only ranks *complete* solutions:
    // on a big tree (H7: three PLLs, ~60 free variables) the internal-source
    // subtree can outlast the visit budget, so a configured crystal would be
    // silently ignored. Visiting HSE-bearing enum values first makes the
    // first solution found the preferred one — which is also what lets the
    // zero-penalty early exit fire. Stable partition, so the relative order
    // inside each half (and hence determinism) is untouched.
    if base_env.get("HSE_VALUE").is_some() {
        for v in &mut free {
            let (hse, rest): (Vec<String>, Vec<String>) = v
                .values
                .iter()
                .cloned()
                .partition(|value| value.to_uppercase().contains("HSE"));
            v.values = hse.into_iter().chain(rest).collect();
        }
    }

    // Target-aware ordering: variables that can influence a target come
    // first (topo order preserved within each group), so each target
    // becomes checkable at a known depth and mismatching subtrees are cut
    // before the unrelated variables explode combinatorially.
    let upstream_sets: Vec<BTreeSet<String>> = resolved_targets
        .iter()
        .map(|(node, _, _)| upstream_of(graph, node))
        .collect();
    let affects = |param: &str, set: &BTreeSet<String>| -> bool {
        graph.elements.values().any(|el| {
            el.ref_parameter
                .as_deref()
                .is_some_and(|p| p.split(',').any(|n| n.trim() == param))
                && set.contains(el.id.as_str())
        })
    };
    // Selectors of muxes that feed a target directly go FIRST: choosing
    // e.g. SYSCLKSource=HSI determines the target frequency immediately
    // (pending inputs keep the PLL path dark), so wrong sources die at
    // depth 1 instead of after the whole PLL product.
    let direct_selectors: BTreeSet<String> = resolved_targets
        .iter()
        .filter_map(|(node, _, _)| graph.elements.get(node.as_str()))
        .flat_map(|el| el.inputs.iter())
        .filter_map(|edge| graph.elements.get(edge.peer.as_str()))
        .filter(|el| el.kind == ClockElementKind::Multiplexor)
        .filter_map(|el| el.ref_parameter.as_deref())
        .map(|p| graph.canonical_param(p).to_string())
        .collect();
    // Parameters bound to elements in some target's upstream cone. The HSE
    // preference is scored over THESE only: scanning every assignment for an
    // "HSE" substring reads `RCC_RTC_Clock_Source_FROM_HSE =
    // RCC_RTCCLKSOURCE_HSE_DIV2` (a downstream leaf, first value of its
    // domain, so always present) as "the crystal is in use" and zeroes the
    // penalty on the very first leaf.
    let cone_params: BTreeSet<String> = graph
        .elements
        .values()
        .filter(|el| upstream_sets.iter().any(|s| s.contains(el.id.as_str())))
        .filter_map(|el| el.ref_parameter.as_deref())
        .flat_map(|p| p.split(',').map(|n| graph.canonical_param(n.trim()).to_string()))
        .collect();
    let (mut selectors, mut affecting, mut rest): (Vec<FreeVar>, Vec<FreeVar>, Vec<FreeVar>) =
        (Vec::new(), Vec::new(), Vec::new());
    for v in free {
        if direct_selectors.contains(&v.param) {
            selectors.push(v);
        } else if upstream_sets.iter().any(|s| affects(&v.param, s)) {
            affecting.push(v);
        } else {
            rest.push(v);
        }
    }
    let boundary = selectors.len() + affecting.len();
    let free: Vec<FreeVar> = selectors.into_iter().chain(affecting).chain(rest).collect();
    // Per-target ready depth: a target still dark once every variable that
    // can influence it is bound will never light up (its cone is fully
    // decided; the tail contributes no cone frequency). For a single target
    // this equals the old shared boundary; with several targets each one
    // starts pruning at its own depth instead of the deepest one.
    let ready_at: Vec<usize> = upstream_sets
        .iter()
        .map(|set| {
            free.iter()
                .enumerate()
                .filter(|(_, v)| affects(&v.param, set))
                .map(|(i, _)| i + 1)
                .max()
                .unwrap_or(0)
        })
        .collect();

    // Diagnostic paths attributable to some target's cone — element ids and
    // their output signal ids (`check_signal_ranges` reports element paths,
    // the edge-bound loop signal paths). The defaults-completion prune only
    // acts on errors at these paths: a violation OUTSIDE the cone may be
    // fixable by different tail values, one inside it cannot. Per path,
    // remember whether its limit is semaphore-gated (conditionally
    // overloaded): those prunes additionally rest on "db defaults give the
    // widest window", so they are counted and surfaced on an UNSAT verdict.
    let gated = |pname: &str| {
        graph
            .rcc
            .ref_parameters
            .iter()
            .filter(|rp| rp.name == pname)
            .count()
            > 1
    };
    let mut cone_paths: BTreeSet<String> = BTreeSet::new();
    let mut cone_path_gated: BTreeMap<String, bool> = BTreeMap::new();
    for el in graph.elements.values() {
        if !upstream_sets.iter().any(|s| s.contains(el.id.as_str())) {
            continue;
        }
        let mut el_gated = el
            .ref_parameter
            .as_deref()
            .is_some_and(|p| p.split(',').any(|n| gated(n.trim())));
        for edge in &el.outputs {
            let sig_gated = graph
                .tree
                .signals
                .get(&edge.signal_id)
                .is_some_and(|p| !p.is_empty() && gated(p));
            cone_paths.insert(edge.signal_id.clone());
            cone_path_gated.insert(edge.signal_id.clone(), sig_gated);
            el_gated = el_gated || sig_gated;
        }
        cone_paths.insert(el.id.clone());
        cone_path_gated.insert(el.id.clone(), el_gated);
    }

    // A user-pinned cone assignment carrying HSE counts as "HSE used": the
    // leaf score used to scan solver-chosen assignments only, so pinning
    // PLLSourceVirtual=RCC_PLLSOURCE_HSE disabled the zero-penalty early
    // exit and a config with a found solution still ground the full budget.
    let user_hse = user_assigned.iter().any(|k| {
        cone_params.contains(graph.canonical_param(k))
            && matches!(base_env.get(k), Some(Value::Str(s)) if s.to_uppercase().contains("HSE"))
    });

    // DFS.
    let budget = visit_budget(free.len());
    let search = Search {
        graph,
        base_env,
        user_assigned,
        free: &free,
        targets: &resolved_targets,
        ready_at,
        rest_start: boundary,
        cone_params: &cone_params,
        cone_paths,
        cone_path_gated,
        user_hse,
        has_ineq: resolved_targets.iter().any(|(_, _, k)| *k != TargetKind::Exact),
        budget,
    };
    let mut best: Option<(ScoreVec, Solution)> = None;
    let mut stats = SearchStats::default();
    let mut assignment: Vec<(String, String)> = Vec::new();
    dfs(&search, 0, &mut assignment, &mut best, &mut stats);
    let visits = stats.visits;
    // The search cost is invisible from outside — a solve that returns in
    // 0.4 s and one that grinds for minutes look identical until the wall
    // clock says otherwise. Off by default so the budget stays the only
    // thing that decides the result (a wall-clock cutoff would make output
    // depend on the machine, and byte-identical output is the contract).
    if std::env::var_os("STM32CK_DEBUG_SOLVE").is_some() {
        eprintln!(
            "solve: {visits} states over {} free params, budget {budget}{}",
            free.len(),
            if visits > budget { " (EXHAUSTED)" } else { "" }
        );
    }

    match best {
        Some((_, sol)) => Ok(sol),
        // Running out of budget is not a proof of unsatisfiability, and the
        // two need different words. Reporting an exhausted search as
        // CLK_UNSAT told a caller its perfectly reachable target was
        // impossible — and on a big tree that verdict arrived only after the
        // full budget had been burned, so the tool looked hung first and
        // lied second. Name which targets were never met: with a bad one
        // (USART1 asked for its *baud rate* rather than its kernel clock)
        // the list is the whole diagnosis.
        None if visits > budget => {
            let wanted = resolved_targets
                .iter()
                .map(|(node, hz, _)| format!("{node}={}", hz.round()))
                .collect::<Vec<_>>()
                .join(", ");
            Err(vec![Diagnostic::error(
                "CLK_BUDGET",
                "/clock/targets",
                format!(
                    "clock search hit its {budget}-state budget over {} free parameters without \
                     meeting {wanted}; whether those targets are reachable is UNDECIDED",
                    free.len()
                ),
            )
            .with_suggestion(
                "a peripheral target is its kernel clock, not its baud/bit rate — drop targets that \
                 name a data rate, then pin the tree with `clock.assignments` if the search is still too wide",
            )])
        }
        None => {
            let mut suggestion = "check source frequencies (HSE value), relax the target, or \
                 consult `describe-clock` for reachable frequencies"
                .to_string();
            // Transparency for the one prune class whose exactness rests on
            // a db property (defaults = widest window) rather than pure cone
            // monotonicity; on every current family that property holds, so
            // the verdict stands — but say that it was load-bearing.
            if stats.gated_prunes > 0 {
                suggestion.push_str(&format!(
                    "; {} branch(es) were cut by a semaphore-gated frequency window \
                     evaluated with the unassigned tail at db defaults (the widest window \
                     this device data can grant), so no tail choice could have saved them",
                    stats.gated_prunes
                ));
            }
            Err(vec![Diagnostic::error(
                "CLK_UNSAT",
                "/clock/targets",
                format!(
                    "no assignment of {} free clock parameters satisfies the targets within device limits",
                    free.len()
                ),
            )
            .with_suggestion(suggestion)])
        }
    }
}

/// Lower is better. [0]=missed-exact-targets (must be 0), [1]=summed Hz
/// distance of inequality targets to their bounds (Exact contributes 0),
/// [2]=HSE unused penalty, [3]=non-default assignment count.
type ScoreVec = [i64; 4];

/// Immutable search context threaded through [`dfs`] — what used to be a
/// 13-argument list, plus the dead-path / defaults-completion machinery.
struct Search<'s> {
    graph: &'s ClockGraph<'s>,
    base_env: &'s Env,
    user_assigned: &'s BTreeSet<String>,
    free: &'s [FreeVar],
    targets: &'s [(String, Num, TargetKind)],
    /// Per-target depth after which a still-dark target counts as missed.
    ready_at: Vec<usize>,
    rest_start: usize,
    cone_params: &'s BTreeSet<String>,
    /// `/clock/`-relative diagnostic paths in some target's cone (element
    /// ids + their output signal ids).
    cone_paths: BTreeSet<String>,
    /// Which of those paths carry a semaphore-gated (conditionally
    /// overloaded) limit.
    cone_path_gated: BTreeMap<String, bool>,
    /// A user-pinned cone assignment already carries HSE.
    user_hse: bool,
    /// Some target is atMost/atLeast: distance scoring, the determined-cone
    /// freeze and the dominance prune are live. False = pure-Exact configs
    /// execute the pre-inequality traversal byte-identically.
    has_ineq: bool,
    budget: u64,
}

#[derive(Default)]
struct SearchStats {
    visits: u64,
    /// Defaults-completion prunes that hit a semaphore-gated window — the
    /// only prune class whose exactness rests on "db defaults give the
    /// widest window" rather than pure cone monotonicity.
    gated_prunes: u64,
}

/// Returns whether this node was itself feasible — i.e. the assignment so far
/// violates no constraint and misses no already-determined target. The caller
/// uses it to stop searching the target-irrelevant tail (see `rest_start`).
fn dfs(
    s: &Search<'_>,
    idx: usize,
    assignment: &mut Vec<(String, String)>,
    best: &mut Option<(ScoreVec, Solution)>,
    stats: &mut SearchStats,
) -> bool {
    stats.visits += 1;
    if stats.visits > s.budget {
        return false;
    }

    // Evaluate the current (possibly partial) assignment.
    let mut env = s.base_env.clone();
    let mut assigned = s.user_assigned.clone();
    for (k, v) in assignment.iter() {
        let val = match stm32ck_ir::expr::parse_number(v) {
            Some(n) => Value::Num(n),
            None => Value::Str(v.clone()),
        };
        env.set(k.clone(), val);
        assigned.insert(k.clone());
    }
    let pending: BTreeSet<String> = s.free[idx..].iter().map(|v| v.param.clone()).collect();
    let mut trace = EvalTrace::default();
    let (prop, diags) = validate_clock(s.graph, &assigned, &pending, &mut env, &mut trace);

    // Prune: hard constraint violations can only get worse downstream
    // (assignments only ever add frequencies), so cut this branch.
    if diags
        .iter()
        .any(|d| d.severity == crate::diag::Severity::Error)
    {
        return false;
    }

    // Prune on targets. Under pending semantics a propagated frequency is
    // FINAL for this branch (a dark upstream would have blocked it), so a
    // present-but-missing target kills the branch at any depth; an absent
    // frequency counts as a miss once all variables affecting THAT target
    // are assigned — or immediately, however shallow, when the target's
    // input chain is provably dead. The dead-path walk is what stops a
    // bound SYSCLKSource=LSE branch on a board with no LSE from soaking up
    // the entire PLLSource x PLLM x PLLN x PLLR product (23,836 of the U083
    // 56 MHz solve's 23,949 states) before the ready depth said "miss".
    let missed = s
        .targets
        .iter()
        .enumerate()
        .any(|(ti, (node, hz, kind))| match prop.freqs.get(node) {
            Some(f) => match kind {
                TargetKind::Exact => f != hz,
                TargetKind::AtMost => f > hz,
                TargetKind::AtLeast => f < hz,
            },
            None => idx >= s.ready_at[ti] || target_dead(s.graph, node, &env, &pending),
        });
    if missed {
        return false;
    }

    // Inequality targets: a determined frequency is FINAL for this branch
    // (pending semantics, see the missed check above), so once EVERY target
    // is determined the remaining cone variables are legality choices, not
    // search decisions — and a branch whose final distance cannot beat the
    // best in hand is dead. Among equal distances first-found wins; the
    // HSE-first value order makes that the HSE-using one when one exists.
    let det_dist = if s.has_ineq {
        distance_sum(s.targets, &prop.freqs)
    } else {
        None
    };
    if let (Some(d), Some((b, _))) = (det_dist, best.as_ref()) {
        if idx < s.free.len() && d >= b[1] {
            return false;
        }
    }

    // Crossing into the target-irrelevant tail: re-validate this state with
    // the WHOLE tail at db defaults. Semaphore-gated limits can be invisible
    // at this depth — the U0 VCO window only exists once AHBCLKDivider (a
    // tail variable) publishes HCLK and the VOS scale resolves — so a false
    // target hit here used to descend into the tail product (4.5M
    // combinations on a U083), every combination failing at the AHB level,
    // with the DFS unable to learn that the failure was independent of the
    // tail. Under the defaults-completion those windows are visible NOW; a
    // cone error here cannot be repaired by other tail values (the tail
    // contributes no cone frequency, and db-default dividers sit at DIV1 =
    // max HCLK = the widest window), so the branch dies in one state.
    if idx == s.rest_start && idx < s.free.len() {
        let mut shadow = s.base_env.clone();
        let mut shadow_assigned = s.user_assigned.clone();
        for (k, v) in assignment.iter() {
            let val = match stm32ck_ir::expr::parse_number(v) {
                Some(n) => Value::Num(n),
                None => Value::Str(v.clone()),
            };
            shadow.set(k.clone(), val);
            shadow_assigned.insert(k.clone());
        }
        let mut strace = EvalTrace::default();
        let (_sprop, sdiags) = validate_clock(
            s.graph,
            &shadow_assigned,
            &BTreeSet::new(),
            &mut shadow,
            &mut strace,
        );
        let poison = sdiags.iter().find(|d| {
            d.severity == crate::diag::Severity::Error
                && d.path
                    .strip_prefix("/clock/")
                    .is_some_and(|p| s.cone_paths.contains(p))
        });
        if let Some(d) = poison {
            if d.path
                .strip_prefix("/clock/")
                .and_then(|p| s.cone_path_gated.get(p))
                .copied()
                .unwrap_or(false)
            {
                stats.gated_prunes += 1;
            }
            return false;
        }
    }

    if idx == s.free.len() {
        let hse_configured = s.base_env.get("HSE_VALUE").is_some();
        let hse_used = s.user_hse
            || assignment
                .iter()
                .any(|(k, v)| s.cone_params.contains(k) && v.to_uppercase().contains("HSE"));
        // Assignments that differ from the RefParameter's own default. The
        // old `assignment.len()` is `free.len()` at every leaf — a constant,
        // so it never discriminated between solutions.
        let non_default = assignment
            .iter()
            .filter(|(k, v)| {
                s.graph
                    .resolve_rcc(k, &env, &mut trace)
                    .is_none_or(|rp| rp.default_value.trim() != v.as_str())
            })
            .count() as i64;
        // At a leaf every target is determined (a dark one was missed-pruned),
        // so det_dist is Some whenever has_ineq; Exact-only configs carry a
        // constant 0 in the distance column — the old vector, one column
        // wider.
        let score: ScoreVec = [
            0,
            det_dist.unwrap_or(0),
            (hse_configured && !hse_used) as i64,
            non_default,
        ];
        if best.as_ref().is_none_or(|(b, _)| score < *b) {
            *best = Some((
                score,
                Solution {
                    assignments: assignment.iter().cloned().collect(),
                    freqs: prop.freqs.clone(),
                },
            ));
        }
        return true;
    }

    let var = &s.free[idx];
    for v in &var.values {
        assignment.push((var.param.clone(), v.clone()));
        let feasible = dfs(s, idx + 1, assignment, best, stats);
        assignment.pop();
        // Early exit once distance and source preference are both satisfied.
        // Exact-only configs have a constantly-zero distance column, so this
        // reduces to the old hse-only condition; inequality configs keep
        // searching until a solution ON the bound (or the budget returns the
        // closest found). Requiring the non-default column too (every
        // assignment at its db default) is unreachable in practice, so it
        // disabled the cut entirely and the F4 domains — PLLI2SN alone is
        // 50..432 — ran past the visit budget. That column only ranks
        // solutions found before the first zero-penalty one; it is a
        // tie-break, not a global optimum.
        if best.as_ref().is_some_and(|(sc, _)| sc[1] == 0 && sc[2] == 0) {
            return true;
        }
        // Past `rest_start` the variable cannot influence any target — and
        // once every target frequency is determined (det_dist), the
        // remaining CONE variables can't either — so the choice is not a
        // search decision: it only has to be legal. Taking the first legal
        // value and never revisiting it turns this tail from a product of
        // domains into a sum: a single infeasible variable deep in the tail
        // used to force a re-walk of every combination before it (STM32U5
        // at 160 MHz did not finish in ten minutes; STM32L4 at 80 MHz took
        // eleven seconds). The det_dist freeze is what stops an inequality
        // search from soaking the whole PLL product under a
        // SYSCLKSource=HSE branch whose frequency is already fixed.
        if (idx >= s.rest_start || det_dist.is_some()) && feasible {
            return true;
        }
    }
    // No legal value for a target-irrelevant variable: leave it unassigned
    // (it falls back to the db default) rather than backtracking into
    // choices that were already accepted.
    if idx >= s.rest_start || det_dist.is_some() {
        return dfs(s, idx + 1, assignment, best, stats);
    }
    false
}

/// Some(summed whole-Hz distance of every target to its bound) when EVERY
/// target frequency is determined; None otherwise. Non-negative on surviving
/// branches (the missed prune ran first). Rounded to whole Hz: the distance
/// is a preference, feasibility stays exact-rational.
fn distance_sum(
    targets: &[(String, Num, TargetKind)],
    freqs: &BTreeMap<String, Num>,
) -> Option<i64> {
    targets.iter().try_fold(0i64, |acc, (node, hz, kind)| {
        let f = freqs.get(node)?;
        let d = match kind {
            TargetKind::Exact => Num::from_integer(0),
            TargetKind::AtMost => *hz - *f,
            TargetKind::AtLeast => *f - *hz,
        };
        Some(acc + d.round().to_integer())
    })
}

/// Whether `node`'s input chain is provably dead under the CURRENT bound
/// mux selections: walking upstream through single-input elements and the
/// SELECTED edge of bound muxes ends at a source with no frequency on the
/// blackboard (LSE on a board that configures no LSE), or at a bound mux
/// whose selector value matches no input edge. A mux whose selector is
/// still in `pending` keeps the branch alive — a later assignment may
/// reroute it. Factors (divider/multiplier values) never make a node dark:
/// their domains exclude zero and integer parameters always have defaults.
///
/// Sound by construction: it only ever follows edges that are already
/// forced, so a `true` verdict cannot be overturned by any deeper
/// assignment — no accepted leaf is ever cut, and first-found solutions
/// (hence golden outputs) are unchanged.
fn target_dead(
    graph: &ClockGraph<'_>,
    node: &str,
    env: &Env,
    pending: &BTreeSet<String>,
) -> bool {
    let mut cur = node.to_string();
    // Chain lengths are ~10; the guard only exists for malformed db cycles,
    // and on falling out we claim "alive" — never dead — to stay sound.
    for _ in 0..64 {
        let Some(el) = graph.elements.get(cur.as_str()) else {
            return false;
        };
        match el.kind {
            ClockElementKind::FixedSource | ClockElementKind::VariedSource => {
                return el
                    .ref_parameter
                    .as_deref()
                    .and_then(|p| env_get_alias(env, p))
                    .and_then(|v| v.as_num())
                    .is_none();
            }
            // Range-selected oscillators (MSI) and FRACN fields always have
            // defaults; treat as alive.
            ClockElementKind::DistinctValsSource | ClockElementKind::Fractional => return false,
            ClockElementKind::Output
            | ClockElementKind::ActiveOutput
            | ClockElementKind::Divisor
            | ClockElementKind::Multiplicator
            | ClockElementKind::MultiplicatorFrac => {
                // Single real input; the FRACN peer edge carries no
                // frequency, so skip Fractional peers.
                let next = el
                    .inputs
                    .iter()
                    .map(|e| e.peer.as_str())
                    .find(|p| {
                        graph
                            .elements
                            .get(*p)
                            .is_none_or(|pe| pe.kind != ClockElementKind::Fractional)
                    });
                match next {
                    Some(p) => cur = p.to_string(),
                    None => return false,
                }
            }
            ClockElementKind::Multiplexor => {
                let Some(pname) = el.ref_parameter.as_deref() else {
                    return false;
                };
                if pname.split(',').any(|n| pending.contains(n.trim())) {
                    return false; // selector still assignable
                }
                let Some(sel) = env_get_alias(env, pname).map(|v| v.as_str()) else {
                    // Bound mux with no selector value at all: this branch
                    // can never route a frequency through it.
                    return true;
                };
                match el
                    .inputs
                    .iter()
                    .find(|e| e.ref_value.as_deref() == Some(sel.as_str()))
                {
                    Some(e) => cur = e.peer.clone(),
                    None => return true,
                }
            }
        }
    }
    false
}

/// Element ids upstream of (and including) `node` — reverse reachability
/// over input edges.
fn upstream_of(graph: &ClockGraph<'_>, node: &str) -> BTreeSet<String> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut stack = vec![node.to_string()];
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(el) = graph.elements.get(id.as_str()) {
            for input in &el.inputs {
                stack.push(input.peer.clone());
            }
        }
    }
    seen
}

/// Resolve a user-facing target name to an element id.
fn resolve_target_node(graph: &ClockGraph<'_>, name: &str) -> Option<String> {
    // 1. exact element id
    if graph.elements.contains_key(name) {
        return Some(name.to_string());
    }
    // 2. exact refParameter name (alias-list aware)
    for (id, el) in &graph.elements {
        if el
            .ref_parameter
            .as_deref()
            .is_some_and(|p| p.split(',').any(|n| n.trim() == name))
        {
            return Some((*id).to_string());
        }
    }
    // 3. shorthand: "SYSCLK" matches a refParameter that begins with it,
    //    ignoring case, on an output node ("SYSCLKFreq_VALUE").
    let upper = name.to_uppercase();
    let mut candidates: Vec<&str> = Vec::new();
    for (id, el) in &graph.elements {
        if !matches!(
            el.kind,
            ClockElementKind::Output | ClockElementKind::ActiveOutput
        ) {
            continue;
        }
        if let Some(rp) = el.ref_parameter.as_deref() {
            if rp.to_uppercase().starts_with(&upper) {
                candidates.push(id);
            }
        }
    }
    // Deterministic: unique match only.
    if candidates.len() == 1 {
        return Some(candidates[0].to_string());
    }
    None
}
