//! Mode-tree activation: XOR exclusivity, availability conditions,
//! signal demands, semaphore publication, `$IpInstance` binding.

use crate::diag::Diagnostic;
use crate::env::Env;
use crate::eval::{eval_condition, EvalTrace};
use crate::params::{mode_chain, ModeChain, ModeSel};
use std::collections::BTreeSet;
use stm32ck_ir::expr::{Condition, Expr};
use stm32ck_ir::model::{IpDef, ModeNode, ModeOp, ModeSignal};

/// The instance index: the TRAILING digit run of an instance name.
/// "I2C1" -> "1" (not "21"!), "TIM13" -> "13", "USB_OTG_FS" -> "" (no
/// trailing digits). Interior digits belong to the IP name, not the index.
pub fn instance_index(instance: &str) -> &str {
    let start = instance
        .rfind(|c: char| !c.is_ascii_digit())
        .map_or(0, |i| i + 1);
    &instance[start..]
}

/// Substitute instance macros in an identifier:
/// `$IpInstance` -> "USART1", `$Index`/`$IpNumber` -> "1";
/// `$ModeExist_<mode>` -> the instance-bound existence semaphore raised by
/// [`activate`] for mode-tree nodes that survive their own RemoveCondition
/// (TIM "Multi-Channels" keeps itself alive while Encoder_Interface exists).
pub fn bind_ident(ident: &str, instance: &str) -> String {
    if !ident.contains('$') {
        return ident.to_string();
    }
    if let Some(rest) = ident.strip_prefix("$ModeExist_") {
        return format!("ModeExist_{rest}_{instance}");
    }
    let digits = instance_index(instance);
    ident
        .replace("$IpInstance", instance)
        .replace("$IpNumber", digits)
        .replace("$Index", digits)
}

pub fn bind_expr(expr: &Expr, instance: &str) -> Expr {
    match expr {
        Expr::Ident(s) => Expr::Ident(bind_ident(s, instance)),
        Expr::Number(n) => Expr::Number(*n),
        Expr::Not(e) => Expr::Not(Box::new(bind_expr(e, instance))),
        Expr::And(v) => Expr::And(v.iter().map(|e| bind_expr(e, instance)).collect()),
        Expr::Or(v) => Expr::Or(v.iter().map(|e| bind_expr(e, instance)).collect()),
        Expr::Cmp { op, lhs, rhs } => Expr::Cmp {
            op: *op,
            lhs: Box::new(bind_expr(lhs, instance)),
            rhs: Box::new(bind_expr(rhs, instance)),
        },
        Expr::Arith { op, lhs, rhs } => Expr::Arith {
            op: *op,
            lhs: Box::new(bind_expr(lhs, instance)),
            rhs: Box::new(bind_expr(rhs, instance)),
        },
    }
}

pub fn bind_condition(cond: &Condition, instance: &str) -> Condition {
    match cond {
        Condition::Plain(e) => Condition::Plain(bind_expr(e, instance)),
        Condition::Directives(d) => Condition::Directives(
            d.iter()
                .map(|(v, e)| (*v, bind_expr(e, instance)))
                .collect(),
        ),
    }
}

/// Result of activating a set of leaf modes on one IP instance.
#[derive(Debug, Default)]
pub struct Activation<'a> {
    /// Leaf mode names actually activated.
    pub active: Vec<String>,
    /// Semaphores published by the active path (already instance-bound).
    pub semaphores: BTreeSet<String>,
    /// Demanded signals: (short name, effective IOMode override, virtual?).
    pub signals: Vec<DemandedSignal>,
    /// RefMode chains of active leaves (params + ConfigForMode + HalMode).
    pub chains: Vec<ModeChain<'a>>,
    pub diags: Vec<Diagnostic>,
}

#[derive(Debug, Clone)]
pub struct DemandedSignal {
    /// Short name ("TX"); full pin signal is `{instance}_{short}`.
    pub short: String,
    /// Mode-level IOMode override, else RefSignal default, else None.
    pub io_mode: Option<String>,
    pub virtual_signal: bool,
    /// Signal direction from the mode tree / RefSignal ("Input"/"Output").
    /// Codegen uses it to split TIM pins between MspInit and MspPostInit.
    pub direction: Option<String>,
}

/// Activate `selected` leaf modes of `ip` for `instance` against `env`.
/// `path` is the config-document JSON pointer for diagnostics.
pub fn activate<'a>(
    ip: &'a IpDef,
    instance: &str,
    selected: &[String],
    env: &Env,
    trace: &mut EvalTrace,
    path: &str,
) -> Activation<'a> {
    let mut act = Activation::default();
    let Some(root) = &ip.mode_tree else {
        if !selected.is_empty() {
            act.diags.push(Diagnostic::error(
                "MODE_NONE",
                path,
                format!("IP {} has no selectable modes", ip.name),
            ));
        }
        return act;
    };

    // Device-existence semaphores for `$ModeExist_<mode>` references:
    // raised for every node that survives its OWN RemoveCondition. They
    // land on the global env via the caller (like all activation
    // semaphores), so nested references settle across fixpoint rounds.
    mode_exist_semaphores(root, instance, env, trace, &mut act.semaphores);

    let want: BTreeSet<&str> = selected.iter().map(|s| s.as_str()).collect();
    let mut found: BTreeSet<String> = BTreeSet::new();
    walk(
        root, ip, instance, &want, env, trace, path, &mut act, &mut found, &mut Vec::new(),
    );

    for name in &want {
        if !found.contains(*name) {
            // Mode names are db strings that vary by IP version and carry
            // spaces ("PWM Generation1 CH1 CH1N"); nothing in the CLI lists
            // them, so a bare "does not exist" leaves the caller guessing.
            // Naming what IS selectable here is the only place that
            // information surfaces at all.
            let mut avail: Vec<String> = Vec::new();
            selectable_modes(root, instance, env, trace, &mut avail);
            act.diags.push(
                Diagnostic::error(
                    "MODE_UNKNOWN",
                    path,
                    format!(
                        "mode `{name}` does not exist on {instance} (or was removed for this device)"
                    ),
                )
                .with_suggestion(suggest_modes(&avail, name)),
            );
        }
    }
    act
}

/// Rank the selectable modes against the name that missed, and render a
/// suggestion small enough to act on.
///
/// The raw list is unusable as a suggestion. TIM3 leaves ~110 nodes alive;
/// spelling them all out is 4 KB, it repeats verbatim for every unknown mode
/// in the same document (three TIM3 misses = the same 4 KB three times), and
/// it buries the one entry that matters. Worse, the caller is usually an LLM
/// that pays for every byte and then still has to guess: the miss is almost
/// always a near-miss ("PWM Generation3 CH1" for "PWM Generation1 CH1"), so
/// the answer is one edit away and ranking finds it.
///
/// Shared *words* decide, not shared prefix: mode names are phrases whose
/// distinguishing token sits at the end ("... CH1" vs "... CH3"), so prefix
/// length alone ranks every sibling identically. Ties break on prefix, then
/// document order, so the output stays deterministic.
fn suggest_modes(avail: &[String], want: &str) -> String {
    /// Enough context to choose, short enough to read.
    const NEAR: usize = 8;
    /// When nothing resembles the input, show a slice rather than everything.
    const BLIND: usize = 20;

    let mut uniq: Vec<&str> = Vec::new();
    for m in avail {
        // The tree names a group and its sole child alike ("ExternalOutput"),
        // so document order alone yields duplicates.
        if !uniq.contains(&m.as_str()) {
            uniq.push(m);
        }
    }
    if uniq.is_empty() {
        return "this instance exposes no selectable modes".to_string();
    }

    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(|w| w.to_ascii_lowercase())
            .collect()
    };
    let want_words = words(want);
    let prefix = |s: &str| {
        s.to_ascii_lowercase()
            .chars()
            .zip(want.to_ascii_lowercase().chars())
            .take_while(|(a, b)| a == b)
            .count()
    };

    let mut scored: Vec<(usize, usize, usize, &str)> = uniq
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let shared = words(m).iter().filter(|w| want_words.contains(w)).count();
            (shared, prefix(m), i, *m)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));

    let near = scored.first().is_some_and(|(shared, ..)| *shared > 0);
    let take = if near { NEAR } else { BLIND };
    let shown: Vec<&str> = scored.iter().take(take).map(|(.., m)| *m).collect();
    let rest = uniq.len().saturating_sub(shown.len());
    let lead = if near { "closest modes" } else { "selectable modes" };
    let tail = if rest > 0 {
        format!(" (+{rest} more)")
    } else {
        String::new()
    };
    format!("{lead}: {}{tail}", shown.join(", "))
}

/// Names of every mode node the current device/env leaves in the tree, in
/// document order. Mirrors the RemoveCondition pruning `walk` applies, so
/// the list never advertises a mode that would then be rejected.
fn selectable_modes(
    node: &ModeNode,
    instance: &str,
    env: &Env,
    trace: &mut EvalTrace,
    out: &mut Vec<String>,
) {
    match node {
        ModeNode::Operator { children, .. } => {
            for c in children {
                selectable_modes(c, instance, env, trace, out);
            }
        }
        ModeNode::Mode {
            name,
            remove_condition,
            children,
            ..
        } => {
            if let Some(rc) = remove_condition {
                if eval_condition(&bind_condition(rc, instance), env, trace) {
                    return;
                }
            }
            out.push(name.clone());
            for c in children {
                selectable_modes(c, instance, env, trace, out);
            }
        }
    }
}

/// Collect `ModeExist_<name>_<instance>` semaphores for every mode node
/// whose own RemoveCondition is absent or false under the current env.
/// Existence is monotone (never lowered) — CubeMX's `$ModeExist_*` macros
/// describe device-static facts ($IpNumber, family flags).
fn mode_exist_semaphores(
    node: &ModeNode,
    instance: &str,
    env: &Env,
    trace: &mut EvalTrace,
    out: &mut BTreeSet<String>,
) {
    match node {
        ModeNode::Operator { children, .. } => {
            for c in children {
                mode_exist_semaphores(c, instance, env, trace, out);
            }
        }
        ModeNode::Mode {
            name,
            remove_condition,
            children,
            ..
        } => {
            let removed = remove_condition.as_ref().is_some_and(|rc| {
                eval_condition(&bind_condition(rc, instance), env, trace)
            });
            if !removed {
                out.insert(format!("ModeExist_{name}_{instance}"));
            }
            for c in children {
                mode_exist_semaphores(c, instance, env, trace, out);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn walk<'a>(
    node: &'a ModeNode,
    ip: &'a IpDef,
    instance: &str,
    want: &BTreeSet<&str>,
    env: &Env,
    trace: &mut EvalTrace,
    path: &str,
    act: &mut Activation<'a>,
    found: &mut BTreeSet<String>,
    ancestors: &mut Vec<String>,
) {
    match node {
        ModeNode::Operator { op, children } => {
            // XOR: at most one child subtree may contain activated leaves.
            if *op == ModeOp::Xor {
                let mut hit: Vec<String> = Vec::new();
                for child in children {
                    let names = leaves_in(child);
                    if names.iter().any(|n| want.contains(n.as_str())) {
                        hit.push(names.into_iter().find(|n| want.contains(n.as_str())).unwrap());
                    }
                }
                if hit.len() > 1 {
                    act.diags.push(
                        Diagnostic::error(
                            "MODE_XOR",
                            path,
                            format!(
                                "modes {} are mutually exclusive on {instance}",
                                hit.join(", ")
                            ),
                        )
                        .with_suggestion("keep exactly one of them"),
                    );
                }
            }
            for child in children {
                walk(child, ip, instance, want, env, trace, path, act, found, ancestors);
            }
        }
        ModeNode::Mode {
            name,
            remove_condition,
            conditions,
            signals,
            semaphores,
            children,
            ..
        } => {
            // Statically removed for this device?
            if let Some(rc) = remove_condition {
                let bound = bind_condition(rc, instance);
                if eval_condition(&bound, env, trace) {
                    return; // pruned subtree; leaves inside can't be found
                }
            }
            let selected_here = want.contains(name.as_str());
            let subtree_selected = selected_here
                || leaves_in(node)
                    .iter()
                    .any(|n| want.contains(n.as_str()));

            if subtree_selected {
                // Availability conditions apply to any node on the path.
                for dc in conditions {
                    let bound = bind_condition(&dc.condition, instance);
                    if !eval_condition(&bound, env, trace) {
                        act.diags.push(Diagnostic::error(
                            "MODE_UNAVAILABLE",
                            path,
                            format!(
                                "mode `{name}` on {instance} requires: {}",
                                if dc.diagnostic.is_empty() {
                                    format!("{}", bound_display(&bound))
                                } else {
                                    dc.diagnostic.clone()
                                }
                            ),
                        ));
                    }
                }
                for s in semaphores {
                    act.semaphores.insert(bind_ident(s, instance));
                }
                for sig in signals {
                    act.signals.push(demanded(ip, sig));
                }
            }

            if selected_here {
                found.insert(name.clone());
                act.active.push(name.clone());
                if let Some(chain) = mode_chain(ip, name, ModeSel { instance, env }) {
                    act.chains.push(chain);
                } else if ip.ref_modes.iter().any(|_| true) {
                    // Leaf without RefMode is legal (pure pinout modes);
                    // nothing to configure.
                }
            }

            ancestors.push(name.clone());
            for child in children {
                walk(child, ip, instance, want, env, trace, path, act, found, ancestors);
            }
            ancestors.pop();
        }
    }
}

fn demanded(ip: &IpDef, sig: &ModeSignal) -> DemandedSignal {
    let refsig = ip.ref_signals.iter().find(|r| r.name == sig.name);
    DemandedSignal {
        short: sig.name.clone(),
        io_mode: sig
            .io_mode
            .clone()
            .or_else(|| refsig.and_then(|r| r.io_mode.clone())),
        virtual_signal: refsig.is_some_and(|r| r.virtual_signal),
        direction: sig
            .direction
            .clone()
            .or_else(|| refsig.and_then(|r| r.direction.clone())),
    }
}

/// All leaf mode names inside a subtree (leaf = Mode with no Mode
/// descendants through operators).
fn leaves_in(node: &ModeNode) -> Vec<String> {
    let mut out = Vec::new();
    collect_leaves(node, &mut out);
    out
}

fn collect_leaves(node: &ModeNode, out: &mut Vec<String>) {
    match node {
        ModeNode::Operator { children, .. } => {
            for c in children {
                collect_leaves(c, out);
            }
        }
        ModeNode::Mode { name, children, .. } => {
            if children.is_empty() {
                out.push(name.clone());
            } else {
                // A named group is also selectable in some IPs; treat the
                // node itself as selectable when it has its own RefMode
                // *and* recurse for nested leaves.
                out.push(name.clone());
                for c in children {
                    collect_leaves(c, out);
                }
            }
        }
    }
}

fn bound_display(c: &Condition) -> String {
    match c {
        Condition::Plain(e) => format!("{e}"),
        Condition::Directives(_) => "(directive condition)".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_instance_macros() {
        assert_eq!(bind_ident("$IpInstance_Asynchronous", "USART1"), "USART1_Asynchronous");
        assert_eq!(bind_ident("S_$IpInstance_TX", "USART2"), "S_USART2_TX");
        assert_eq!(bind_ident("plain", "USART1"), "plain");
        assert_eq!(bind_ident("$IpNumber", "USART6"), "6");
        // Interior digits are part of the IP name (audit §二-3: I2C1 must
        // expand to "1", not "21").
        assert_eq!(bind_ident("$Index", "I2C1"), "1");
        assert_eq!(bind_ident("I2S$IpNumber_Used", "SPI2"), "I2S2_Used");
    }

    #[test]
    fn instance_index_trailing_digit_run_only() {
        assert_eq!(instance_index("I2C1"), "1");
        assert_eq!(instance_index("USART6"), "6");
        assert_eq!(instance_index("TIM13"), "13");
        assert_eq!(instance_index("ADC1"), "1");
        assert_eq!(instance_index("USB_OTG_FS"), "");
        assert_eq!(instance_index("RCC"), "");
    }
}
