//! The validation pipeline: config document -> fully resolved model.
//!
//! Order (design §5-§8): device seeding -> peripheral mode activation with
//! semaphore fixpoint -> parameter domains/defaults -> pin allocation ->
//! clock solve/validate -> NVIC. The output [`Resolved`] carries everything
//! codegen needs; codegen adds no decisions of its own.

use crate::clock::{validate_clock, ClockGraph, Propagation};
use crate::clock_solve::{solve_clock, SolveTarget, TargetKind};
use crate::config::*;
use crate::diag::Diagnostic;
use crate::env::{Env, Value};
use crate::eval::{eval_condition, EvalTrace};
use crate::modes::{activate, bind_condition, bind_ident, DemandedSignal};
use crate::params::{
    check_value, effective_domain_bound, mode_chain, resolve_mode_overload, resolve_param,
    resolve_param_bound, ModeChain, ModeSel, Verdict,
};
use crate::pinout::{allocate, DebugPort, PinPlan, SignalReq};
use std::collections::{BTreeMap, BTreeSet};
use stm32ck_ir::expr::Num;
use stm32ck_ir::model::{
    IpDef, IrPack, ModeNode, ModeParameter, NvicVector, Part, RefParameter,
};

#[derive(Debug)]
pub struct Resolved<'a> {
    pub part: &'a Part,
    pub gpio_version: String,
    pub periphs: Vec<ResolvedPeriph<'a>>,
    pub pin_plan: PinPlan,
    pub clock: ClockResolution,
    pub nvic: Vec<ResolvedIrq>,
    /// Resolved DMA requests (plan §P3), document order.
    pub dma: Vec<crate::dma::ResolvedDma>,
    /// HAL timebase timer (project.halTimebase, plan §P4), when configured
    /// and resolvable.
    pub timebase: Option<ResolvedTimebase>,
    pub env: Env,
    pub diags: Vec<Diagnostic>,
}

/// project.halTimebase resolved against the part: the reserved timer, its
/// (possibly shared) interrupt vector and clock-enable macro, and which APB
/// bus feeds it (drives the `APBx` prescaler logic in the timebase file).
#[derive(Debug, Clone)]
pub struct ResolvedTimebase {
    /// "TIM14"
    pub tim: String,
    /// "TIM8_TRG_COM_TIM14_IRQn" — derived from the NVIC table by owner.
    pub irqn: String,
    /// "__HAL_RCC_TIM14_CLK_ENABLE"
    pub clock_enable: String,
    /// true = APB2 timer (TIM1/8/9/10/11/15/16/17/20), else APB1.
    pub apb2: bool,
}

#[derive(Debug)]
pub struct ResolvedPeriph<'a> {
    pub instance: String,
    pub ip_key: String,
    pub ip: &'a IpDef,
    pub active_modes: Vec<String>,
    pub hal_mode: Option<String>,
    /// Codegen block names, base-first (flat view of `config_blocks`).
    pub config_for_mode: Vec<String>,
    /// Codegen blocks with the RefMode that introduced them — codegen
    /// resolves each block's parameters in its owner's mode context.
    pub config_blocks: Vec<ConfigBlock>,
    /// Final parameter values (C literals) for codegen: pinned > user > default.
    /// Flattened across modes — last chain in deterministic mode order wins
    /// for names shared between channel RefModes (TIM `Pulse`).
    pub params: BTreeMap<String, String>,
    /// Per-RefMode final parameter values: mode name -> param -> value.
    /// Shared names (TIM `Pulse`, `OCMode_PWM`, ADC `Channel`) keep their
    /// per-channel/per-conversion identity here.
    pub mode_params: BTreeMap<String, BTreeMap<String, String>>,
    /// Demanded signals (for MSP GPIO init), non-virtual only.
    pub signals: Vec<DemandedSignal>,
    pub clock_enable: Vec<String>,
    pub nvic: Option<NvicCfg>,
}

/// One ConfigForMode block and the RefMode (chain leaf) that introduced it.
#[derive(Debug, Clone)]
pub struct ConfigBlock {
    pub name: String,
    pub owner: String,
    /// Value-lookup scope for codegen: the owning chain's scope. Equal to
    /// `owner` everywhere except per-rank RefMode clones, where it carries
    /// the instance index (`"0#ChannelRegularConversion"`).
    pub scope: String,
}

#[derive(Debug, Default)]
pub struct ClockResolution {
    /// element id -> Hz.
    pub freqs: BTreeMap<String, Num>,
    /// Final parameter assignments (user + solver), C literals/integers.
    pub assignments: BTreeMap<String, String>,
    /// Derived system values published during validation (FLatency, VOS...).
    pub derived: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedIrq {
    pub irqn: String,
    pub owner: String,
    pub preemption_priority: u32,
    pub sub_priority: u32,
    /// Handler templates from the NVIC record (may be empty).
    pub handlers: Vec<String>,
    pub args: String,
    /// Emit the it.c handler function (NvicCfg.generateHandler, default
    /// true). False = NVIC enable only (mine-core Q3 checkbox column 3).
    pub generate_handler: bool,
}

/// Find the part a sales number belongs to.
pub fn find_part<'a>(pack: &'a IrPack, part: &str) -> Option<&'a Part> {
    pack.parts.values().find(|p| {
        p.ref_name == part || p.part_numbers.iter().any(|n| n == part)
    })
}

/// Names closest to `want`, ranked by shared prefix length.
///
/// The miss that actually happens is an **orderable** part number where the
/// db stores CubeMX's wildcard spelling: a schematic says `STM32G473RCT6`
/// (the silicon marking, last digit = flash size) and the pack holds
/// `STM32G473RCTx`. A bare "not found" leaves the caller — often an LLM —
/// with nothing to go on; it guessed that the tool only covered F1/F4 and
/// abandoned an otherwise supported part. Prefix ranking puts the intended
/// spelling first in every such case.
pub fn rank_near<'a>(names: impl IntoIterator<Item = &'a str>, want: &str) -> Vec<String> {
    let want_lc = want.to_ascii_lowercase();
    let shared = |name: &str| {
        name.to_ascii_lowercase()
            .chars()
            .zip(want_lc.chars())
            .take_while(|(a, b)| a == b)
            .count()
    };
    // "STM32" alone is 5 chars and shared by everything; require the family
    // and part line to match so the list stays short and actually useful.
    const MIN_SHARED: usize = 8;
    let mut scored: Vec<(usize, &str)> = names
        .into_iter()
        .map(|n| (shared(n), n))
        .filter(|(s, _)| *s >= MIN_SHARED)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    scored.dedup_by(|a, b| a.1 == b.1);
    scored.into_iter().take(5).map(|(_, n)| n.to_string()).collect()
}

pub fn validate<'a>(pack: &'a IrPack, doc: &ConfigDoc) -> Result<Resolved<'a>, Vec<Diagnostic>> {
    let mut diags: Vec<Diagnostic> = Vec::new();

    if doc.schema_version != CONFIG_SCHEMA_VERSION {
        return Err(vec![Diagnostic::error(
            "DOC_SCHEMA",
            "/schemaVersion",
            format!(
                "config schemaVersion {} != kernel {}",
                doc.schema_version, CONFIG_SCHEMA_VERSION
            ),
        )]);
    }
    let Some(part) = find_part(pack, &doc.mcu.part) else {
        let d = Diagnostic::error(
            "MCU_UNKNOWN",
            "/mcu/part",
            format!("part `{}` not in pack {}", doc.mcu.part, pack.family),
        );
        let near = rank_near(
            pack.parts
                .values()
                .flat_map(|p| p.part_numbers.iter().map(String::as_str)),
            &doc.mcu.part,
        );
        return Err(vec![if near.is_empty() {
            d
        } else {
            d.with_suggestion(format!("did you mean {}?", near.join(", ")))
        }]);
    };

    // ---- environment seeding ---------------------------------------------
    let mut env = Env::new();
    let mut trace = EvalTrace::default();
    env.seed_device(part);
    env.set(
        "VDD_VALUE",
        Value::Num(Num::new(doc.power.vdd_mv as i64, 1000)),
    );
    let mut suppressed: BTreeSet<String> = BTreeSet::from([
        "HSE_VALUE".to_string(),
        "LSE_VALUE".to_string(),
    ]);
    for (name, src) in &doc.clock.sources {
        let pname = format!("{name}_VALUE");
        env.set(pname.clone(), Value::Num(Num::from_integer(src.freq_hz as i64)));
        suppressed.remove(&pname);
        match src.kind {
            ClockSourceKind::Crystal => env.raise(format!("{name}Oscillator")),
            ClockSourceKind::Bypass => env.raise(format!("{name}ByPass")),
        }
    }

    // ---- locate core IP defs ----------------------------------------------
    let ip_key_of = |inst: &str| -> Option<(String, &'a IpDef)> {
        let ii = part.ip_instances.iter().find(|i| i.instance == inst)?;
        let key = format!("{}-{}", ii.name, ii.version);
        pack.ips.get(&key).map(|d| (key, d))
    };
    let Some((_, rcc)) = ip_key_of("RCC") else {
        return Err(vec![Diagnostic::error(
            "IR_RCC",
            "/mcu/part",
            "RCC IP definition missing from pack",
        )]);
    };
    let Some(tree) = pack.clock_trees.get(&part.clock_tree) else {
        return Err(vec![Diagnostic::error(
            "IR_CLOCK",
            "/mcu/part",
            format!("clock tree {} missing from pack", part.clock_tree),
        )]);
    };
    let gpio_version = part
        .ip_instances
        .iter()
        .find(|i| i.name == "GPIO")
        .map(|i| i.version.clone())
        .unwrap_or_default();

    // ---- peripheral activation fixpoint ------------------------------------
    struct PeriphWork<'a> {
        instance: String,
        ip_key: String,
        ip: &'a IpDef,
        cfg: PeriphCfg,
        clock_enable: Vec<String>,
        /// Suffix-mapped user params (`Pulse-CH1` -> Pulse @ its RefMode).
        user_params: Vec<UserParam>,
        /// Non-tree RefModes demanded by this config (ADC's
        /// ChannelRegularConversion & co) — activated each fixpoint round
        /// when their condition holds.
        auto_modes: Vec<String>,
    }
    let mut work: Vec<PeriphWork<'a>> = Vec::new();
    for (instance, cfg) in &doc.peripherals {
        let Some((ip_key, ip)) = ip_key_of(instance) else {
            diags.push(Diagnostic::error(
                "PERIPH_UNKNOWN",
                format!("/peripherals/{instance}"),
                format!("`{instance}` does not exist on {}", part.ref_name),
            ));
            continue;
        };
        let ii = part
            .ip_instances
            .iter()
            .find(|i| i.instance == *instance)
            .expect("checked above");
        // Usage + existence semaphores, and the RCC-side enable params that
        // gate clock-tree output constraints (USBEnable, ADCEnable, ...).
        env.raise(format!("{instance}Used_ForRCC"));
        env.set(format!("{instance}Enable"), Value::Str("true".into()));
        let stem: String = instance.trim_end_matches(|c: char| c.is_ascii_digit()).to_string();
        if stem != *instance {
            env.set(format!("{stem}Enable"), Value::Str("true".into()));
        }
        for s in &ip.semaphores {
            env.raise(bind_ident(s, instance));
        }
        // Structural queries only need each RefMode's parameter shape, but
        // they still have to pick the right same-name overload; the env is
        // partially built here (no fixpoint yet), which is exactly the
        // state the guarded entries are meant to be read against.
        let sel = ModeSel { instance, env: &env };
        let user_params = map_user_params(ip, instance, cfg, sel, &mut diags);
        let auto_modes = auto_demanded_modes(ip, cfg, sel, &user_params);
        work.push(PeriphWork {
            instance: instance.clone(),
            ip_key,
            ip,
            cfg: cfg.clone(),
            clock_enable: ii.clock_enable.clone(),
            user_params,
            auto_modes,
        });
        // User params onto the blackboard: mode-context key when suffixed,
        // instance key otherwise (backward compatible).
        let w = work.last().expect("just pushed");
        for u in &w.user_params {
            match &u.mode {
                Some(m) => env.set_mode_scoped(instance, m, &u.db_name, json_to_value(&u.value)),
                None => env.set_scoped(instance, &u.db_name, json_to_value(&u.value)),
            }
        }
    }

    // Fixpoint: activations publish semaphores that can change other IPs'
    // mode availability and parameter domains — and (audit §二-2) EVERY
    // active chain parameter's final value (pinned > user > default) goes
    // onto the scoped blackboard each round and publishes its selected
    // PossibleValue semaphore. Defaults count: conditions like
    // `TIMode = SPI_TIMODE_DISABLE` or `S_USART2_TX_RX` read them.
    // Values may shift between rounds as semaphores land; the loop runs
    // until (semaphores, params) are stable, capped at 16 rounds.
    #[derive(Default)]
    struct FinalValues {
        flat: BTreeMap<String, String>,
        per_mode: BTreeMap<String, BTreeMap<String, String>>,
    }
    let mut activations: BTreeMap<String, crate::modes::Activation<'a>> = BTreeMap::new();
    let mut final_values: BTreeMap<String, FinalValues> = BTreeMap::new();
    // (instance, parameter) pairs a mode wanted to pin but whose RefParameter
    // this IP def does not define. Used to be an unreported `continue`, so a
    // mode silently degraded to "nothing pinned"; now the last round's set is
    // reported.
    let mut unresolved_pins: BTreeSet<(String, String)> = BTreeSet::new();
    // (instance, parameter) -> every (mode, value) that claimed the flat key.
    // See the collection site for why this is not bookkeeping.
    let mut shadowed: BTreeMap<(String, String), BTreeSet<(String, String)>> = BTreeMap::new();
    let mut converged = work.is_empty();
    for round in 0..16 {
        let before_sems = env.semaphores.clone();
        let before_params = env.params.clone();
        activations.clear();
        for w in &work {
            let path = format!("/peripherals/{}", w.instance);
            let mut act = env.scoped(&w.instance, |env| {
                activate(w.ip, &w.instance, &w.cfg.mode.as_vec(), env, &mut trace, &path)
            });
            // Auto-activated (non-tree) RefModes: ADC's ChannelRegular/
            // InjectedConversion + ADC_Settings live outside the mode tree
            // and activate on demand — appended after the leaf chains, in
            // ip.ref_modes doc order, when their condition holds.
            for name in &w.auto_modes {
                // The applicable overload, or none — a name whose every
                // same-name entry is guarded and unsatisfied is simply not
                // available in this configuration.
                let sel = ModeSel {
                    instance: &w.instance,
                    env: &env,
                };
                let Some(rm) = resolve_mode_overload(w.ip, name, sel) else {
                    continue;
                };
                // ADC regular sequences: the db has ONE ChannelRegularConversion
                // RefMode, but CubeMX instantiates it once per rank (addIPMode,
                // ioc rows `Channel-{i}#ChannelRegularConversion`). Mirror that
                // with one chain per rank, each in its own `{i}#` scope, seeded
                // with its Rank and its Channel. Everything else stays one chain.
                let ranks = if name == "ChannelRegularConversion" {
                    regular_sequence_channels(w.ip, &w.cfg, &w.user_params, sel)
                } else {
                    Vec::new()
                };
                if ranks.is_empty() {
                    let Some(chain) = mode_chain(w.ip, name, sel) else {
                        continue;
                    };
                    for s in &rm.semaphores {
                        act.semaphores.insert(bind_ident(s, &w.instance));
                    }
                    act.active.push(name.clone());
                    act.chains.push(chain);
                } else {
                    let mut instantiated = false;
                    for (i, ch) in ranks.iter().enumerate() {
                        let Some(mut chain) = mode_chain(w.ip, name, sel) else {
                            continue;
                        };
                        chain.scope = format!("{i}#{name}");
                        chain.seeds = vec![
                            ("Rank".to_string(), (i + 1).to_string()),
                            ("Channel".to_string(), ch.clone()),
                        ];
                        act.active.push(chain.scope.clone());
                        act.chains.push(chain);
                        instantiated = true;
                    }
                    if instantiated {
                        for s in &rm.semaphores {
                            act.semaphores.insert(bind_ident(s, &w.instance));
                        }
                    }
                }
            }
            for s in &act.semaphores {
                env.raise(s.clone());
            }
            activations.insert(w.instance.clone(), act);
        }
        // Resolve every active chain parameter to its final value IN ITS
        // CHAIN'S MODE CONTEXT (pinned > user-context > user-bare > default),
        // write it under both the mode-context key and the instance key, and
        // raise the matching PossibleValue semaphore (instance-bound).
        // Chain doc order; later chains win the flattened instance key.
        final_values.clear();
        unresolved_pins.clear();
        shadowed.clear();
        for w in &work {
            let Some(act) = activations.get(&w.instance) else { continue };
            let mut vals = FinalValues::default();
            for chain in &act.chains {
                // The chain's scope (leaf name, or "{i}#RefMode" for rank
                // clones) is the value-context key throughout: blackboard
                // mode keys, per_mode, codegen block lookups.
                let ctx_mode = chain.scope.clone();
                env.scoped_mode(&w.instance, &ctx_mode, |env| {
                    for mp in &chain.parameters {
                        // A guarded pin applies only while its guard holds.
                        if let Some(cond) = &mp.condition {
                            if !eval_condition(
                                &bind_condition(cond, &w.instance),
                                env,
                                &mut trace,
                            ) {
                                continue;
                            }
                        }
                        // `RefParameter` redirects the pin to a differently
                        // named parameter; `Name` alone misses about half of
                        // the db's pairs.
                        let target = mp.target();
                        let Some(rp) =
                            resolve_param_bound(w.ip, target, &w.instance, env, &mut trace)
                        else {
                            if !mp.pinned_values.is_empty() {
                                unresolved_pins
                                    .insert((w.instance.clone(), target.to_string()));
                            }
                            continue;
                        };
                        let value = final_param_value(
                            rp, mp, &w.user_params, &ctx_mode, &w.instance, env, &mut trace,
                        );
                        let Some(value) = value else { continue };
                        if let Some(pv) = rp.possible_values.iter().find(|pv| pv.value == value) {
                            if let Some(sem) = &pv.semaphore {
                                env.raise(bind_ident(sem, &w.instance));
                            }
                        }
                        env.set_mode_scoped(
                            &w.instance, &ctx_mode, target, Value::Str(value.clone()),
                        );
                        env.set_scoped(&w.instance, target, Value::Str(value.clone()));
                        vals.per_mode
                            .entry(ctx_mode.clone())
                            .or_default()
                            .insert(target.to_string(), value.clone());
                        // The flat key is last-chain-wins by design (codegen
                        // falls back to it when a block's own mode scope has
                        // nothing). But when two chains want DIFFERENT values
                        // for the same parameter, "last wins" is not a merge —
                        // it is a silent discard, and the caller asked for
                        // both. Record every claimant, including the first:
                        // recording only writes that collide with a previous
                        // one would omit the value that arrived earliest,
                        // which is usually the one the user typed first.
                        // ...but only from modes that have no block of their
                        // own. A mode WITH a ConfigForMode keeps its value in
                        // its own scope and codegen reads it there — that is
                        // how TIM emits four PWM channels from four modes that
                        // all pin `Channel`. Those collisions are the design
                        // working, not a loss.
                        if chain.config_for_mode.is_empty() {
                            shadowed
                                .entry((w.instance.clone(), target.to_string()))
                                .or_default()
                                .insert((ctx_mode.clone(), value.clone()));
                        }
                        vals.flat.insert(target.to_string(), value);
                    }
                    // Seeds override whatever the parameter pass resolved:
                    // a rank clone's Rank/Channel are the clone's identity
                    // (CubeMX pins them on the cloned row). Scope-only —
                    // the flat view keeps its last-chain-wins semantics for
                    // parameters, not for per-instance identities.
                    for (name, value) in &chain.seeds {
                        if let Some(rp) =
                            resolve_param_bound(w.ip, name, &w.instance, env, &mut trace)
                        {
                            if let Some(pv) =
                                rp.possible_values.iter().find(|pv| pv.value == *value)
                            {
                                if let Some(sem) = &pv.semaphore {
                                    env.raise(bind_ident(sem, &w.instance));
                                }
                            }
                        }
                        env.set_mode_scoped(
                            &w.instance, &ctx_mode, name, Value::Str(value.clone()),
                        );
                        env.set_scoped(&w.instance, name, Value::Str(value.clone()));
                        vals.per_mode
                            .entry(ctx_mode.clone())
                            .or_default()
                            .insert(name.clone(), value.clone());
                    }
                });
            }
            final_values.insert(w.instance.clone(), vals);
        }
        if round > 0 && env.semaphores == before_sems && env.params == before_params {
            converged = true;
            break;
        }
    }
    if !converged {
        diags.push(Diagnostic::error(
            "FIXPOINT_OSCILLATION",
            "/peripherals",
            "peripheral activation did not stabilize within 16 rounds \
             (oscillating semaphores or parameter values in the device data)",
        ));
    }
    // Report the pins that could not be applied. Not an error — the mode is
    // still usable, and the db does carry entries whose RefParameter belongs
    // to an IP def this pack did not import — but silence here is how a mode
    // loses a pinned value with nothing to show for it.
    for (instance, param) in &unresolved_pins {
        diags.push(
            Diagnostic::warning(
                "MODE_PIN_UNRESOLVED",
                format!("/peripherals/{instance}"),
                format!(
                    "mode pins `{param}`, which this device's IP definition does not \
                     declare; the pinned value is not applied"
                ),
            )
            .with_suggestion(
                "usually harmless (the db shares RefModes across devices); \
                 set the value explicitly under `params` if it matters",
            ),
        );
    }
    // A field that ends up unset while active modes were offering real values.
    //
    // Selecting `IN6-Single-Ended` means "this pad is an analog input", not
    // "add it to the conversion sequence" — CubeMX keeps those separate, and
    // so does this kernel, so several IN modes writing the same flat `Channel`
    // key is normal and the last writer is harmless. What is NOT harmless is
    // the last writer being a null sentinel: on G4 the ChannelRegularConversion
    // RefMode defaults `Channel` to `__NULL`, it lands after every IN mode, and
    // codegen then drops the field — leaving `sConfig.Channel` at whatever the
    // `= {0}` initialiser held, i.e. channel 0, which is usually not even a
    // selected input. Naming an explicit `Channel-ChannelRegularConversion`
    // fixes it, so the diagnostic's job is to say that out loud.
    for ((instance, param), claimants) in &shadowed {
        // Per-rank clones seed this parameter in their own `{i}#` scopes; a
        // null flat residue is then expected (G4's `__NULL` Channel default
        // lands after the seeds), not a lost value.
        let seeded = final_values.get(instance).is_some_and(|v| {
            v.per_mode.iter().any(|(scope, vals)| {
                scope.contains('#')
                    && vals
                        .get(param)
                        .is_some_and(|x| !matches!(x.trim(), "" | "null" | "__NULL"))
            })
        });
        if seeded {
            continue;
        }
        let kept = final_values
            .get(instance)
            .and_then(|v| v.flat.get(param))
            .cloned()
            .unwrap_or_default();
        // Only a null winner is a defect; any real value means the block got
        // configured, which is what the parity reference does too.
        if !matches!(kept.trim(), "" | "null" | "__NULL") {
            continue;
        }
        let offered = claimants
            .iter()
            .filter(|(_, v)| !matches!(v.trim(), "" | "null" | "__NULL"))
            .map(|(mode, value)| format!("{value} (`{mode}`)"))
            .collect::<Vec<_>>();
        if offered.is_empty() {
            continue;
        }
        let owner = final_values
            .get(instance)
            .map(|v| {
                v.per_mode
                    .iter()
                    .filter(|(_, params)| params.contains_key(param))
                    .map(|(mode, _)| mode.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let suffix = owner
            .iter()
            .find(|m| m.contains("Conversion"))
            .cloned()
            .unwrap_or_else(|| owner.first().cloned().unwrap_or_default());
        diags.push(
            Diagnostic::warning(
                "PARAM_UNSET",
                format!("/peripherals/{instance}"),
                format!(
                    "`{param}` resolves to a null default and is therefore omitted from the \
                     generated code, leaving the struct's `= {{0}}` initialiser in force; \
                     {} active mode(s) offered a value: {}",
                    offered.len(),
                    offered.join(", ")
                ),
            )
            .with_suggestion(if suffix.is_empty() {
                format!("set `{param}` explicitly under this peripheral's `params`")
            } else {
                format!(
                    "set it explicitly: \"params\": {{ \"{param}-{suffix}\": \"<value>\" }} \
                     — the `-<RefMode>` suffix targets the configuration block that consumes it"
                )
            }),
        );
    }

    // A declared conversion count the generator cannot honour.
    //
    // CubeMX builds a scan sequence by instantiating its rank RefMode once per
    // rank (`Channel-0#ChannelRegularConversion`, `-1#…`, …) and emitting one
    // `HAL_ADC_ConfigChannel` call for each. Regular sequences now do the
    // same; a rank only materialises when it has a channel source (an indexed
    // `Channel-{i}#…` param, or the i-th selected IN mode). Emitting
    // `NbrOfConversion = 4` beside fewer ranks is the one combination that is
    // actively dangerous: the peripheral scans four ranks and the missing
    // ones hold whatever was in the sequencer registers, which reads as
    // plausible data. Refusing to say so is how a config for sixteen sensors
    // turned into firmware that samples one.
    for (instance, vals) in &final_values {
        for (count_param, group) in [
            ("NbrOfConversion", "ChannelRegularConversion"),
            ("InjNumberOfConversion", "ChannelInjectedConversion"),
        ] {
            let Some(n) = vals.flat.get(count_param).and_then(|v| v.trim().parse::<i64>().ok())
            else {
                continue;
            };
            if n <= 1 {
                continue;
            }
            let instantiated = activations
                .get(instance)
                .map(|a| {
                    a.chains
                        .iter()
                        .filter(|c| c.scope.ends_with(&format!("#{group}")))
                        .count() as i64
                })
                .unwrap_or(0)
                .max(1);
            if n <= instantiated {
                continue;
            }
            let suggestion = if group == "ChannelRegularConversion" {
                format!(
                    "give every rank a channel: select the inputs in sequence order under \
                     `mode`, or set `Channel-{{i}}#{group}` per rank (0-based); or lower \
                     {count_param} to {instantiated}"
                )
            } else {
                format!(
                    "set {count_param} to 1 and select the one channel with \
                     `Channel-{group}`, or configure ranks {}..{n} yourself with \
                     HAL_ADCEx_InjectedConfigChannel AFTER MX_{instance}_Init() has run — \
                     never in a USER CODE section ahead of HAL_ADC_Init, where the handle \
                     is still null",
                    instantiated + 1
                )
            };
            diags.push(
                Diagnostic::warning(
                    "ADC_SEQUENCE_TRUNCATED",
                    format!("/peripherals/{instance}/params/{count_param}"),
                    format!(
                        "{count_param} = {n}, but only {instantiated} rank(s) are configured \
                         — ranks {}..{n} keep whatever the sequencer registers already held",
                        instantiated + 1
                    ),
                )
                .with_suggestion(suggestion),
            );
        }
    }

    // Activation diagnostics + parameter validation. Final values come
    // straight from the fixpoint above — no re-derivation.
    let mut periphs: Vec<ResolvedPeriph<'a>> = Vec::new();
    for w in &work {
        let act = activations.remove(&w.instance).unwrap_or_default();
        diags.extend(act.diags.iter().cloned());

        let mut hal_mode = None;
        let mut config_blocks: Vec<ConfigBlock> = Vec::new();
        let finals = final_values.remove(&w.instance).unwrap_or_default();

        for chain in &act.chains {
            if hal_mode.is_none() {
                hal_mode = chain.hal_mode.clone();
            }
            let owner = chain
                .modes
                .first()
                .map(|m| m.name.clone())
                .unwrap_or_default();
            for c in &chain.config_for_mode {
                // Ordinary chains dedup by NAME: TIM's four channel chains
                // share their base blocks (init, MasterConfig, BreakDeadTime)
                // and must contribute them once — the per-channel identity
                // lives in the differently NAMED PWM_ConfigChannel_n blocks.
                // Rank clones (`{i}#` scopes) dedup by (name, scope): they
                // exist precisely to emit the same-named block once per rank.
                let dup = if chain.scope.contains('#') {
                    config_blocks
                        .iter()
                        .any(|b| b.name == *c && b.scope == chain.scope)
                } else {
                    config_blocks.iter().any(|b| b.name == *c)
                };
                if !dup {
                    config_blocks.push(ConfigBlock {
                        name: c.clone(),
                        owner: owner.clone(),
                        scope: chain.scope.clone(),
                    });
                }
            }
        }

        // Validate each user-set param once, against the domain of the
        // chain that consumes it (mode-suffixed keys bind to exactly one
        // chain; bare keys check against the first chain pulling the name).
        // Values referencing a declared project.userConstants name are
        // symbolic C expressions — passed through with an info diag.
        for u in &w.user_params {
            let path = format!("/peripherals/{}/params/{}", w.instance, u.key);
            let value_str = json_to_value(&u.value).as_str();
            let consumer = act.chains.iter().find_map(|chain| {
                let ctx = chain.scope.as_str();
                if let Some(m) = &u.mode {
                    // Exact scope, or the un-indexed RefMode name matching a
                    // rank clone (`-ChannelRegularConversion` broadcasts).
                    if m != ctx && m != scope_base(ctx) {
                        return None;
                    }
                }
                chain
                    .parameters
                    .iter()
                    .find(|mp| mp.name == u.db_name)
                    .map(|mp| (ctx.to_string(), *mp))
            });
            let Some((ctx_mode, mp)) = consumer else { continue };
            if mp.pinned_values.first().is_some() {
                continue; // pinned shadows the user's value; nothing to check
            }
            if is_symbolic(&value_str, &doc.project.user_constants) {
                diags.push(Diagnostic::info(
                    "PARAM_SYMBOLIC",
                    path.clone(),
                    format!(
                        "`{}` = `{value_str}` references project.userConstants; \
                         symbolic value passed through without range validation",
                        u.db_name
                    ),
                ));
                continue;
            }
            let verdict = env.scoped_mode(&w.instance, &ctx_mode, |env| {
                let rp = resolve_param_bound(w.ip, &u.db_name, &w.instance, env, &mut trace)?;
                let value = finals
                    .per_mode
                    .get(&ctx_mode)
                    .and_then(|m| m.get(&u.db_name))
                    .cloned()
                    .unwrap_or_else(|| value_str.clone());
                let dom = effective_domain_bound(rp, &w.instance, env, &mut trace);
                Some(check_value(&dom, &Value::Str(value)))
            });
            match verdict {
                Some(Verdict::Ok) | None => {}
                Some(Verdict::NotInList { allowed }) => {
                    diags.push(
                        Diagnostic::error(
                            "PARAM_VALUE",
                            path.clone(),
                            format!(
                                "`{}` is not a legal value of {} here",
                                finals
                                    .per_mode
                                    .get(&ctx_mode)
                                    .and_then(|m| m.get(&u.db_name))
                                    .cloned()
                                    .unwrap_or(value_str.clone()),
                                u.db_name
                            ),
                        )
                        .with_suggestion(format!("allowed: {}", allowed.join(", "))),
                    );
                }
                Some(Verdict::OutOfRange { min, max }) => {
                    diags.push(Diagnostic::error(
                        "PARAM_RANGE",
                        path.clone(),
                        format!(
                            "{} out of range [{} .. {}]",
                            u.db_name,
                            min.map(fmt_num).unwrap_or_else(|| "-".into()),
                            max.map(fmt_num).unwrap_or_else(|| "-".into()),
                        ),
                    ));
                }
                Some(Verdict::ExcludedValue { diagnostic }) => {
                    diags.push(Diagnostic::error(
                        "PARAM_EXCLUDED",
                        path.clone(),
                        if diagnostic.is_empty() {
                            format!("value of {} is disabled in this configuration", u.db_name)
                        } else {
                            diagnostic
                        },
                    ));
                }
            }
        }

        // Which parameters the selected modes actually consume. Naming these
        // is the only way a caller learns the vocabulary: parameter names are
        // db strings that differ per IP version, nothing lists them, and the
        // ones a mode consumes are a small subset of what the IP declares.
        // Without it, "no parameter `Pulse`" sends the caller guessing
        // (`CH1_Pulse`, `Channel1_Pulse`, `Pulse1`, ...) one round trip at a
        // time.
        let consumed_names = {
            let mut names: BTreeSet<&str> = finals.flat.keys().map(String::as_str).collect();
            for vals in finals.per_mode.values() {
                names.extend(vals.keys().map(String::as_str));
            }
            names.into_iter().collect::<Vec<_>>()
        };
        let consumed_hint = || {
            if consumed_names.is_empty() {
                "the selected mode(s) consume no parameters".to_string()
            } else {
                format!("parameters in effect here: {}", consumed_names.join(", "))
            }
        };

        // Unknown user params (typos) — hard error, we promise determinism.
        for u in &w.user_params {
            let known = w.ip.ref_parameters.iter().any(|rp| rp.name == u.db_name);
            let path = format!("/peripherals/{}/params/{}", w.instance, u.key);
            if !known {
                diags.push(
                    Diagnostic::error(
                        "PARAM_UNKNOWN",
                        path,
                        format!("{} has no parameter `{}`", w.ip.name, u.db_name),
                    )
                    .with_suggestion(consumed_hint()),
                );
            } else {
                let consumed = match &u.mode {
                    // Exact scope, or — for un-indexed RefMode suffixes —
                    // any rank clone of that RefMode (`SamplingTime-Channel
                    // RegularConversion` lands in every `{i}#` scope).
                    Some(m) => finals.per_mode.iter().any(|(scope, vals)| {
                        (scope == m || scope_base(scope) == m)
                            && vals.contains_key(&u.db_name)
                    }),
                    None => finals.flat.contains_key(&u.db_name),
                };
                // A value equal to the parameter's default is a no-op, not
                // an ignored intent (EnableAnalogWatchDog=false stays quiet
                // even though the WatchDog RefMode never activates).
                let is_default = w.ip.ref_parameters.iter().any(|rp| {
                    rp.name == u.db_name
                        && rp.default_value == json_to_value(&u.value).as_str()
                });
                if !consumed && !is_default {
                    diags.push(
                        Diagnostic::warning(
                            "PARAM_INACTIVE",
                            path,
                            format!(
                                "`{}` is not used by the selected mode(s); ignored",
                                u.key
                            ),
                        )
                        .with_suggestion(consumed_hint()),
                    );
                }
            }
        }

        periphs.push(ResolvedPeriph {
            instance: w.instance.clone(),
            ip_key: w.ip_key.clone(),
            ip: w.ip,
            active_modes: act.active.clone(),
            hal_mode,
            config_for_mode: config_blocks.iter().map(|b| b.name.clone()).collect(),
            config_blocks,
            params: finals.flat,
            mode_params: finals.per_mode,
            signals: act.signals.iter().filter(|s| !s.virtual_signal).cloned().collect(),
            clock_enable: w.clock_enable.clone(),
            nvic: w.cfg.nvic.clone(),
        });
    }

    // ---- DMA requests ---------------------------------------------------------
    // After the fixpoint: leaf conditions read the requester semaphores it
    // published (S_UART4_TX_RX, SPI3_DmaReceive, ...).
    let dma = crate::dma::resolve_dma(pack, part, doc, &mut env, &mut trace, &mut diags);

    // ---- pin allocation -----------------------------------------------------
    let mut requests: Vec<SignalReq> = Vec::new();
    // A crystal occupies two pads exactly like a peripheral signal does, and
    // the db lists them as RCC pin signals. Without a request for them, a
    // document that declares an HSE crystal *and* uses the same pads for GPIO
    // gets no conflict diagnostic at all — the generated project silently
    // reconfigures the oscillator pads as I/O.
    for (source, pins) in [
        ("HSE", ["RCC_OSC_IN", "RCC_OSC_OUT"]),
        ("LSE", ["RCC_OSC32_IN", "RCC_OSC32_OUT"]),
    ] {
        let Some(cfg) = doc.clock.sources.get(source) else {
            continue;
        };
        // Bypass mode drives the chip from an external clock on the IN pad
        // only; a crystal needs both.
        let needed: &[&str] = match cfg.kind {
            crate::config::ClockSourceKind::Bypass => &pins[..1],
            crate::config::ClockSourceKind::Crystal => &pins,
        };
        for signal in needed {
            // Only where the allocator could actually place it: the pad must
            // be routed on this package AND be a general-purpose I/O. On many
            // families the oscillator pads are dedicated (`MonoIo`), never
            // contend with GPIO, and so need no request.
            if !part.pins.iter().any(|p| {
                p.kind == stm32ck_ir::model::PinKind::Io
                    && p.signals.iter().any(|s| s.name == *signal)
            }) {
                continue;
            }
            requests.push(SignalReq {
                signal: (*signal).to_string(),
                instance: "RCC".to_string(),
                hint: None,
                path: format!("/clock/sources/{source}"),
            });
        }
    }
    for (instance, cfg) in &doc.peripherals {
        let Some(p) = periphs.iter().find(|p| p.instance == *instance) else {
            continue;
        };
        for sig in &p.signals {
            requests.push(SignalReq {
                signal: format!("{instance}_{}", sig.short),
                instance: instance.clone(),
                hint: cfg.pins.get(&sig.short).cloned(),
                path: format!("/peripherals/{instance}/pins/{}", sig.short),
            });
        }
        for short in cfg.pins.keys() {
            if !p.signals.iter().any(|s| s.short == *short) {
                diags.push(Diagnostic::warning(
                    "PIN_HINT_UNUSED",
                    format!("/peripherals/{instance}/pins/{short}"),
                    format!("signal `{short}` is not demanded by the selected mode(s)"),
                ));
            }
        }
    }
    /// Resolve a `ShareableGroupName` / `ExclusiveGroupName` attribute for one
    /// instance.
    ///
    /// The db spells these as `<group>:<instances the group applies to>`, with
    /// `$IpInstance` in the group name — e.g.
    /// `S_$IpInstance_CH1:TIM1,TIM3,TIM4` (per-instance group, only on those
    /// timers) and `S_TIM2_CH1_ETR:TIM2` (TIM2 alone shares CH1 with ETR).
    /// Comparing the raw attribute would make every timer's CH1 look like the
    /// same group and authorise stacks the device does not have.
    fn group_for(raw: Option<&str>, instance: &str) -> Option<String> {
        let raw = raw?.trim();
        if raw.is_empty() {
            return None;
        }
        let (name, scope) = match raw.rsplit_once(':') {
            Some((n, s)) => (n, s),
            None => (raw, ""),
        };
        let applies = scope.trim().is_empty()
            || scope.split(',').map(str::trim).any(|i| i == instance);
        applies.then(|| crate::modes::bind_ident(name, instance).to_string())
    }

    let occupied: BTreeSet<String> = doc.gpio.keys().cloned().collect();
    let debug = match doc.debug {
        DebugCfg::Swd => DebugPort::Swd,
        DebugCfg::None => DebugPort::None,
    };
    // Pin stacking inputs (plan §P4): analog-class signals share pads
    // implicitly; gpio entries whitelist co-signals via sharedWith.
    let analog: BTreeSet<String> = periphs
        .iter()
        .flat_map(|p| {
            p.signals.iter().filter_map(|s| {
                s.io_mode
                    .as_deref()
                    .is_some_and(|m| m.contains("Analog"))
                    .then(|| format!("{}_{}", p.instance, s.short))
            })
        })
        .collect();
    let requested: BTreeSet<&str> = requests.iter().map(|r| r.signal.as_str()).collect();
    let mut shared_pads: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (pad, cfg) in &doc.gpio {
        if cfg.shared_with.is_empty() {
            continue;
        }
        for sig in &cfg.shared_with {
            if !requested.contains(sig.as_str()) {
                diags.push(Diagnostic::warning(
                    "PIN_SHARED_UNUSED",
                    format!("/gpio/{pad}/sharedWith"),
                    format!(
                        "`{sig}` is not a demanded signal of any configured \
                         peripheral; the whitelist entry has no effect"
                    ),
                ));
            }
        }
        shared_pads.insert(pad.clone(), cfg.shared_with.iter().cloned().collect());
    }
    // The db's own pad-sharing groups, per configured instance. Keyed by full
    // signal name so the allocator can compare occupants directly.
    let mut signal_groups = crate::pinout::SignalGroups::default();
    for w in &work {
        for rs in &w.ip.ref_signals {
            let full = format!("{}_{}", w.instance, rs.name);
            if let Some(g) = group_for(rs.shareable_group.as_deref(), &w.instance) {
                signal_groups.shareable.insert(full.clone(), g);
            }
            if let Some(g) = group_for(rs.exclusive_group.as_deref(), &w.instance) {
                signal_groups.exclusive.insert(full, g);
            }
        }
    }
    let gpio_def = pack.gpio.get(&gpio_version);
    let pin_plan = match gpio_def {
        Some(g) => allocate(
            part,
            g,
            &requests,
            &occupied,
            debug,
            &analog,
            &shared_pads,
            &signal_groups,
        ),
        None => {
            diags.push(Diagnostic::error(
                "IR_GPIO",
                "/mcu/part",
                "GPIO IP definition missing from pack",
            ));
            PinPlan::default()
        }
    };
    diags.extend(pin_plan.diags.iter().cloned());

    // ---- clock ---------------------------------------------------------------
    let mut user_assigned: BTreeSet<String> = BTreeSet::new();
    for (k, v) in &doc.clock.assignments {
        env.set(k.clone(), json_to_value(v));
        user_assigned.insert(k.clone());
    }
    // Sources count as user-assigned; suppressed sources must never default.
    for name in doc.clock.sources.keys() {
        user_assigned.insert(format!("{name}_VALUE"));
    }
    for s in &suppressed {
        user_assigned.insert(s.clone());
    }

    let graph = ClockGraph::build(tree, rcc, &env, &mut trace);

    let mut clock_res = ClockResolution::default();
    if !doc.clock.targets.is_empty() {
        let targets: Vec<SolveTarget> = doc
            .clock
            .targets
            .iter()
            .map(|(node, t)| SolveTarget {
                node: node.clone(),
                hz: Num::from_integer(t.hz as i64),
                kind: match t.kind {
                    ClockTargetKind::Exact => TargetKind::Exact,
                    ClockTargetKind::AtMost => TargetKind::AtMost,
                    ClockTargetKind::AtLeast => TargetKind::AtLeast,
                },
            })
            .collect();
        match solve_clock(&graph, &env, &user_assigned, &targets) {
            Ok(sol) => {
                for (k, v) in &sol.assignments {
                    env.set(k.clone(), Value::Str(v.clone()));
                    user_assigned.insert(k.clone());
                    clock_res.assignments.insert(k.clone(), v.clone());
                }
            }
            Err(e) => diags.extend(e),
        }
    }
    for (k, v) in &doc.clock.assignments {
        clock_res
            .assignments
            .insert(k.clone(), json_to_value(v).as_str());
    }

    let (prop, clock_diags): (Propagation, Vec<Diagnostic>) =
        validate_clock(&graph, &user_assigned, &BTreeSet::new(), &mut env, &mut trace);
    diags.extend(clock_diags);
    clock_res.freqs = prop.freqs.clone();
    // Publish every solved node's frequency under the *parameter* name the
    // clock tree gives it (`<Signal id="VCOInput" refParameter=
    // "VCOInputFreq_Value"/>`). The db's condition-ordered overloads are
    // written against those names, not against element ids: PLL1's input
    // range is five overloads on `VCOInputFreq_Value`, so without this the
    // guards all read false and `PLLRGE` collapsed to the unconditional
    // fallback — the same `RCC_PLL1_VCIRANGE_*` whatever the input frequency.
    for el in &tree.elements {
        let Some(hz) = prop.freqs.get(&el.id) else { continue };
        // The solved value wins: a `*Freq_Value` parameter is a solver output,
        // never a user assignment, and the peripheral fixpoint may already
        // have seeded it from a stale db default.
        let mut publish = |param: &str| {
            if !param.is_empty() {
                env.set(param.to_string(), Value::Num(*hz));
            }
        };
        for edge in &el.outputs {
            if let Some(param) = tree.signals.get(&edge.signal_id) {
                publish(param);
            }
        }
        if let Some(param) = &el.ref_parameter {
            // Only the frequency-carrying spelling: an element's own
            // refParameter is usually its divider/mux *selector*, whose value
            // is an enum, and overwriting that with a frequency would be wrong.
            if param.ends_with("Freq_Value") || param.ends_with("Freq_VALUE") {
                publish(param);
            }
        }
    }
    // The peripheral fixpoint runs *before* the clock is solved, so any RCC
    // parameter whose overloads are guarded on a frequency was decided against
    // the db's placeholder default (`VCOInputFreq_Value` defaults to 4 MHz).
    // Drop those stale values; codegen re-resolves the overload set against
    // the frequencies just published. Without this, PLL1's input range was
    // always the 4-8 MHz band's `RCC_PLL1_VCIRANGE_2`, whatever the PLL input.
    let freq_conditioned: BTreeSet<String> = rcc
        .ref_parameters
        .iter()
        .filter(|rp| {
            rp.condition.as_ref().is_some_and(|dc| {
                dc.condition
                    .idents()
                    .iter()
                    .any(|id| id.ends_with("Freq_Value") || id.ends_with("Freq_VALUE"))
            })
        })
        .map(|rp| rp.name.clone())
        .collect();
    for name in &freq_conditioned {
        // Re-resolve, don't just drop: `validate_clock` computes some of these
        // itself (FLatency, the voltage scale) and its answer must survive when
        // the overload set has nothing better to say.
        let Some(rp) = resolve_param(rcc, name, &env, &mut trace) else {
            continue;
        };
        let d = rp.default_value.trim();
        if d.is_empty() || d == "null" || d.starts_with('+') || d.starts_with('=') {
            continue;
        }
        env.set(name.clone(), Value::Str(d.to_string()));
    }
    for derived in ["FLatency", "PWR_Regulator_Voltage_Scale"] {
        if let Some(v) = env.params.get(derived) {
            clock_res.derived.insert(derived.to_string(), v.as_str());
        }
    }

    // ---- NVIC -----------------------------------------------------------------
    // Priority grouping (plan §P4): validated here, emitted by codegen only
    // when non-default (HAL_Init already programs GROUP_4).
    if let Some(pg) = &doc.nvic.priority_group {
        let known = (0..=4).map(|n| format!("NVIC_PRIORITYGROUP_{n}"));
        if !known.into_iter().any(|k| k == *pg) {
            diags.push(Diagnostic::error(
                "NVIC_PRIORITY_GROUP",
                "/nvic/priorityGroup",
                format!(
                    "`{pg}` is not a priority group (NVIC_PRIORITYGROUP_0 .. \
                     NVIC_PRIORITYGROUP_4)"
                ),
            ));
        }
    }
    // Cortex system handlers (mine spec §2.5): validated names; codegen
    // emits SetPriority in HAL_MspInit (never for SVCall/SysTick).
    const SYSTEM_HANDLERS: [&str; 9] = [
        "NonMaskableInt", "HardFault", "MemoryManagement", "BusFault",
        "UsageFault", "SVCall", "DebugMonitor", "PendSV", "SysTick",
    ];
    for (name, nv) in &doc.nvic.system_handlers {
        let path = format!("/nvic/systemHandlers/{name}");
        if !SYSTEM_HANDLERS.contains(&name.as_str()) {
            diags.push(Diagnostic::error(
                "NVIC_SYSTEM_HANDLER",
                path,
                format!(
                    "`{name}` is not a Cortex system handler (known: {})",
                    SYSTEM_HANDLERS.join(", ")
                ),
            ));
            continue;
        }
        if nv.preemption_priority > 15 || nv.sub_priority > 15 {
            diags.push(Diagnostic::error(
                "NVIC_PRIORITY",
                path,
                format!(
                    "system handler priority {}:{} exceeds the 4-bit range",
                    nv.preemption_priority, nv.sub_priority
                ),
            ));
        }
    }
    // main() init-order override (plan §P4): unknown/duplicate names are
    // errors; codegen appends missing instances in sorted order.
    {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for name in &doc.project.init_order {
            let path = format!("/project/initOrder/{name}");
            if !doc.peripherals.contains_key(name) {
                diags.push(Diagnostic::error(
                    "INIT_ORDER_UNKNOWN",
                    path,
                    format!("`{name}` is not a configured peripheral instance"),
                ));
            } else if !seen.insert(name.as_str()) {
                diags.push(Diagnostic::error(
                    "INIT_ORDER_DUPLICATE",
                    path,
                    format!("`{name}` appears more than once in initOrder"),
                ));
            }
        }
    }

    let mut nvic_out: Vec<ResolvedIrq> = Vec::new();
    let nvic_vectors: Option<&Vec<NvicVector>> = part
        .ip_instances
        .iter()
        .find(|i| i.name == "NVIC" || i.name.starts_with("NVIC"))
        .and_then(|i| pack.nvic_vectors.get(&format!("{}-{}", i.name, i.version)));
    if let Some(vectors) = nvic_vectors {
        // Priority range check under the current priority group.
        let check_prio = |path: &str, pre: u32, sub: u32, diags: &mut Vec<Diagnostic>,
                              env: &Env, trace: &mut EvalTrace| {
            if let Some((_, nvic_ip)) = ip_key_of("NVIC") {
                for (field, val) in [("PreemptionPriority", pre), ("SubPriority", sub)] {
                    if let Some(rp) = resolve_param(nvic_ip, field, env, trace) {
                        if let Some(max) = rp.max {
                            if Num::from_integer(val as i64) > max {
                                diags.push(Diagnostic::error(
                                    "NVIC_PRIORITY",
                                    path.to_string(),
                                    format!(
                                        "{field} {val} exceeds max {} for the current priority grouping",
                                        fmt_num(max)
                                    ),
                                ));
                            }
                        }
                    }
                }
            }
        };
        for p in &periphs {
            let cfg = doc.peripherals.get(&p.instance);
            let interrupts = cfg.map(|c| &c.interrupts).filter(|m| !m.is_empty());
            if let Some(map) = interrupts {
                // Fine-grained per-vector config (multi-vector IPs). Rows
                // resolve in NVIC vector-table order — the order CubeMX
                // emits SetPriority/EnableIRQ in MspInit (CAN1: TX, RX0,
                // RX1, SCE).
                if p.nvic.is_some() {
                    diags.push(Diagnostic::info(
                        "NVIC_SHADOWED",
                        format!("/peripherals/{}/nvic", p.instance),
                        format!(
                            "{} declares `interrupts`; the single `nvic` block is ignored",
                            p.instance
                        ),
                    ));
                }
                let mut matched: BTreeSet<&str> = BTreeSet::new();
                for v in vectors {
                    let Some(nv) = map.get(&v.irqn) else { continue };
                    if !v.owners.iter().any(|o| o == &p.instance) {
                        continue;
                    }
                    if !v
                        .condition
                        .as_ref()
                        .map(|c| eval_condition(c, &env, &mut trace))
                        .unwrap_or(true)
                    {
                        continue;
                    }
                    matched.insert(v.irqn.as_str());
                    if !nv.enabled {
                        continue;
                    }
                    let path = format!("/peripherals/{}/interrupts/{}", p.instance, v.irqn);
                    check_prio(
                        &path, nv.preemption_priority, nv.sub_priority, &mut diags, &env,
                        &mut trace,
                    );
                    nvic_out.push(ResolvedIrq {
                        irqn: v.irqn.clone(),
                        owner: p.instance.clone(),
                        preemption_priority: nv.preemption_priority,
                        sub_priority: nv.sub_priority,
                        handlers: v.handlers.clone(),
                        args: v.args.clone(),
                        generate_handler: nv.generate_handler.unwrap_or(true),
                    });
                }
                for irqn in map.keys() {
                    if !matched.contains(irqn.as_str()) {
                        diags.push(Diagnostic::error(
                            "NVIC_VECTOR",
                            format!("/peripherals/{}/interrupts/{irqn}", p.instance),
                            format!("`{irqn}` is not an interrupt vector owned by {}", p.instance),
                        ));
                    }
                }
                continue;
            }
            let Some(nv) = &p.nvic else { continue };
            if !nv.enabled {
                continue;
            }
            let vec_match = vectors.iter().find(|v| {
                v.user_enableable
                    && v.owners.iter().any(|o| o == &p.instance)
                    && v.condition
                        .as_ref()
                        .map(|c| eval_condition(c, &env, &mut trace))
                        .unwrap_or(true)
            });
            match vec_match {
                Some(v) => {
                    let path = format!("/peripherals/{}/nvic", p.instance);
                    check_prio(
                        &path, nv.preemption_priority, nv.sub_priority, &mut diags, &env,
                        &mut trace,
                    );
                    nvic_out.push(ResolvedIrq {
                        irqn: v.irqn.clone(),
                        owner: p.instance.clone(),
                        preemption_priority: nv.preemption_priority,
                        sub_priority: nv.sub_priority,
                        handlers: v.handlers.clone(),
                        args: v.args.clone(),
                        generate_handler: nv.generate_handler.unwrap_or(true),
                    });
                }
                None => diags.push(Diagnostic::error(
                    "NVIC_VECTOR",
                    format!("/peripherals/{}/nvic", p.instance),
                    format!("no enableable interrupt vector owned by {}", p.instance),
                )),
            }
        }

        // GPIO EXTI pins: the EXTI line is the pad bit number (PC13 -> 13);
        // its vector is the one whose owners contain "EXTI<line>" (F1:
        // EXTI0..4 individual, EXTI9_5, EXTI15_10 shared). Pins sharing a
        // vector collapse to ONE ResolvedIrq — numerically lowest
        // (preemption, sub) priority wins; ties keep the first pad in name
        // order (doc.gpio iterates in pad order).
        let mut exti_by_irqn: BTreeMap<String, ResolvedIrq> = BTreeMap::new();
        for (pad, cfg) in &doc.gpio {
            if cfg.mode != GpioMode::Exti {
                continue;
            }
            let Some(nv) = &cfg.nvic else { continue };
            if !nv.enabled {
                continue;
            }
            let path = format!("/gpio/{pad}/nvic");
            let vec_match = exti_line(pad).and_then(|line| {
                let owner = format!("EXTI{line}");
                vectors.iter().find(|v| {
                    v.user_enableable
                        && v.owners.iter().any(|o| *o == owner)
                        && v.condition
                            .as_ref()
                            .map(|c| eval_condition(c, &env, &mut trace))
                            .unwrap_or(true)
                })
            });
            let Some(v) = vec_match else {
                diags.push(Diagnostic::error(
                    "NVIC_VECTOR",
                    path,
                    format!("no enableable EXTI interrupt vector for pin {pad}"),
                ));
                continue;
            };
            // Priority range check under current priority group (same as
            // peripherals).
            if let Some((_, nvic_ip)) = ip_key_of("NVIC") {
                for (field, val) in [
                    ("PreemptionPriority", nv.preemption_priority),
                    ("SubPriority", nv.sub_priority),
                ] {
                    if let Some(rp) = resolve_param(nvic_ip, field, &env, &mut trace) {
                        if let Some(max) = rp.max {
                            if Num::from_integer(val as i64) > max {
                                diags.push(Diagnostic::error(
                                    "NVIC_PRIORITY",
                                    path.clone(),
                                    format!(
                                        "{field} {val} exceeds max {} for the current priority grouping",
                                        fmt_num(max)
                                    ),
                                ));
                            }
                        }
                    }
                }
            }
            let cand = ResolvedIrq {
                irqn: v.irqn.clone(),
                owner: format!("EXTI{}", exti_line(pad).expect("vector matched")),
                preemption_priority: nv.preemption_priority,
                sub_priority: nv.sub_priority,
                handlers: v.handlers.clone(),
                args: v.args.clone(),
                generate_handler: nv.generate_handler.unwrap_or(true),
            };
            match exti_by_irqn.get_mut(&v.irqn) {
                Some(existing) => {
                    if (cand.preemption_priority, cand.sub_priority)
                        < (existing.preemption_priority, existing.sub_priority)
                    {
                        *existing = cand;
                    }
                }
                None => {
                    exti_by_irqn.insert(v.irqn.clone(), cand);
                }
            }
        }
        nvic_out.extend(exti_by_irqn.into_values());
    }

    // ---- HAL timebase timer (plan §P4) -----------------------------------------
    let mut timebase: Option<ResolvedTimebase> = None;
    if let Some(tb) = &doc.project.hal_timebase {
        let path = "/project/halTimebase".to_string();
        if doc.peripherals.contains_key(tb) {
            diags.push(Diagnostic::error(
                "TIMEBASE_CONFLICT",
                path.clone(),
                format!(
                    "{tb} is reserved as the HAL timebase; remove it from \
                     `peripherals` (the timebase file owns its init)"
                ),
            ));
        }
        let ii = part.ip_instances.iter().find(|i| i.instance == *tb);
        match ii {
            None => diags.push(Diagnostic::error(
                "TIMEBASE_UNKNOWN",
                path,
                format!("`{tb}` does not exist on {}", part.ref_name),
            )),
            Some(ii) => {
                // The timebase vector comes from the NVIC table by owner
                // match (TIM14 -> TIM8_TRG_COM_TIM14_IRQn).
                let vec_match = nvic_vectors.and_then(|vectors| {
                    vectors.iter().find(|v| {
                        v.owners.iter().any(|o| o == tb)
                            && v.condition
                                .as_ref()
                                .map(|c| eval_condition(c, &env, &mut trace))
                                .unwrap_or(true)
                    })
                });
                match vec_match {
                    None => diags.push(Diagnostic::error(
                        "TIMEBASE_VECTOR",
                        path,
                        format!("no interrupt vector owned by {tb} in the NVIC table"),
                    )),
                    Some(v) => {
                        timebase = Some(ResolvedTimebase {
                            tim: tb.clone(),
                            irqn: v.irqn.clone(),
                            clock_enable: ii
                                .clock_enable
                                .first()
                                .cloned()
                                .unwrap_or_else(|| format!("__HAL_RCC_{tb}_CLK_ENABLE")),
                            apb2: is_apb2_tim(tb),
                        });
                    }
                }
            }
        }
    }

    Ok(Resolved {
        part,
        gpio_version,
        periphs,
        pin_plan,
        clock: clock_res,
        nvic: nvic_out,
        dma,
        timebase,
        env,
        diags,
    })
}

/// APB2-fed timers of the F1/F4 families (advanced + 9/10/11 + 15/16/17 +
/// 20). Everything else hangs off APB1. Drives the timebase file's
/// `APBxCLKDivider` / `HAL_RCC_GetPCLKxFreq` selection (mine spec §3.1).
fn is_apb2_tim(instance: &str) -> bool {
    matches!(
        instance,
        "TIM1" | "TIM8" | "TIM9" | "TIM10" | "TIM11" | "TIM15" | "TIM16" | "TIM17" | "TIM20"
    )
}

/// One user config param after suffix mapping: `"OCMode_PWM-CH1"` becomes
/// db name `OCMode_PWM` bound to the RefMode whose pinned Channel is
/// `TIM_CHANNEL_1`; `"Rank-ChannelRegularConversion"` binds `Rank` to that
/// RefMode by name; suffix-less keys stay instance-wide (`mode: None`).
#[derive(Debug, Clone)]
struct UserParam {
    /// db RefParameter name after suffix mapping.
    db_name: String,
    /// RefMode context the value applies to (None = instance-wide).
    mode: Option<String>,
    value: serde_json::Value,
    /// Original config key (diagnostic paths).
    key: String,
}

/// Map user param keys to (db name, RefMode context). `-CHn` suffixes bind
/// via the selected leaf chain whose pinned `Channel` is `*_CHANNEL_n`
/// (fallback: RefMode name containing `"Generation{n} "` or ending `"_{n}"`);
/// the channel key base resolves against the chain's parameter names as
/// `base`, `base_{n}`, or `base_CH{n}`. `-{RefModeName}` suffixes bind by
/// name. Unknown suffixes are PARAM_UNKNOWN errors listing the valid channel
/// suffixes. Keys without `-` (or exactly matching a db parameter) are
/// unchanged — fully backward compatible.
fn map_user_params<'a>(
    ip: &'a IpDef,
    instance: &str,
    cfg: &PeriphCfg,
    sel: ModeSel<'_>,
    diags: &mut Vec<Diagnostic>,
) -> Vec<UserParam> {
    // Chains of the selected leaves, in doc (mode list) order.
    let leaf_chains: Vec<(String, ModeChain<'a>)> = cfg
        .mode
        .as_vec()
        .iter()
        .filter_map(|leaf| mode_chain(ip, leaf, sel).map(|c| (leaf.clone(), c)))
        .collect();
    let channel_of = |chain: &ModeChain<'_>| -> Option<u32> {
        chain
            .parameters
            .iter()
            .find(|p| p.name == "Channel")
            .and_then(|p| p.pinned_values.first())
            .and_then(|v| v.rsplit('_').next())
            .and_then(|d| d.parse().ok())
    };
    let valid_channels = || -> Vec<String> {
        leaf_chains
            .iter()
            .filter_map(|(_, c)| channel_of(c))
            .map(|n| format!("CH{n}"))
            .collect()
    };

    let mut out = Vec::new();
    for (key, value) in &cfg.params {
        // Exact db parameter names always win (future-proof against names
        // that legitimately contain `-`).
        let split = key.split_once('-').filter(|_| {
            !ip.ref_parameters.iter().any(|rp| rp.name == *key)
        });
        let Some((base, suffix)) = split else {
            out.push(UserParam {
                db_name: key.clone(),
                mode: None,
                value: value.clone(),
                key: key.clone(),
            });
            continue;
        };
        let path = format!("/peripherals/{instance}/params/{key}");
        // "-CHn" -> the channel-owning leaf chain.
        if let Some(n) = suffix
            .strip_prefix("CH")
            .filter(|d| d.len() == 1)
            .and_then(|d| d.parse::<u32>().ok())
            .filter(|n| (1..=6).contains(n))
        {
            let chain = leaf_chains
                .iter()
                .find(|(_, c)| channel_of(c) == Some(n))
                .or_else(|| {
                    leaf_chains.iter().find(|(leaf, _)| {
                        leaf.contains(&format!("Generation{n} "))
                            || leaf.ends_with(&format!("_{n}"))
                    })
                });
            let Some((leaf, chain)) = chain else {
                diags.push(Diagnostic::error(
                    "PARAM_UNKNOWN",
                    path,
                    format!(
                        "no active mode of {instance} owns channel CH{n} \
                         (valid channel suffixes: {})",
                        valid_channels().join(", ")
                    ),
                ));
                continue;
            };
            // Channel-indexed db spellings: exact, `_{n}`, `_CH{n}`.
            let candidates = [
                base.to_string(),
                format!("{base}_{n}"),
                format!("{base}_CH{n}"),
            ];
            let Some(db_name) = candidates
                .iter()
                .find(|c| chain.parameters.iter().any(|p| p.name == **c))
            else {
                diags.push(Diagnostic::error(
                    "PARAM_UNKNOWN",
                    path,
                    format!(
                        "mode `{leaf}` on {instance} has no parameter `{base}` \
                         (tried {})",
                        candidates.join(", ")
                    ),
                ));
                continue;
            };
            out.push(UserParam {
                db_name: db_name.clone(),
                mode: Some(leaf.clone()),
                value: value.clone(),
                key: key.clone(),
            });
            continue;
        }
        // "-{RefModeName}" -> that RefMode's context.
        if ip.ref_modes.iter().any(|m| m.name == suffix) {
            out.push(UserParam {
                db_name: base.to_string(),
                mode: Some(suffix.to_string()),
                value: value.clone(),
                key: key.clone(),
            });
            continue;
        }
        // "-{i}#{RefModeName}" -> that rank clone's context (the ioc's own
        // row-id spelling, `Channel-0#ChannelRegularConversion`).
        if let Some((idx, rm_name)) = suffix.split_once('#') {
            if !idx.is_empty()
                && idx.chars().all(|c| c.is_ascii_digit())
                && ip.ref_modes.iter().any(|m| m.name == rm_name)
            {
                out.push(UserParam {
                    db_name: base.to_string(),
                    mode: Some(suffix.to_string()),
                    value: value.clone(),
                    key: key.clone(),
                });
                continue;
            }
        }
        diags.push(Diagnostic::error(
            "PARAM_UNKNOWN",
            path,
            format!(
                "unknown parameter suffix `-{suffix}` on `{key}` \
                 (valid channel suffixes: {}; or a RefMode name)",
                valid_channels().join(", ")
            ),
        ));
    }
    // A sequence written purely with `-{i}#ChannelRegularConversion` rows
    // implies its own length — CubeMX keeps NbrOfConversion consistent with
    // the rank rows in the ioc, so a missing bare count follows the indices.
    let n_idx = out
        .iter()
        .filter_map(|u| u.mode.as_deref()?.split_once('#'))
        .filter(|(_, b)| *b == "ChannelRegularConversion")
        .filter_map(|(i, _)| i.parse::<usize>().ok())
        .map(|i| i + 1)
        .max()
        .unwrap_or(0);
    if n_idx >= 2
        && !out
            .iter()
            .any(|u| u.mode.is_none() && u.db_name == "NbrOfConversion")
    {
        out.push(UserParam {
            db_name: "NbrOfConversion".to_string(),
            mode: None,
            value: serde_json::Value::from(n_idx as i64),
            key: "NbrOfConversion".to_string(),
        });
    }
    out
}

/// `"0#ChannelRegularConversion"` -> `"ChannelRegularConversion"`; scopes
/// without a rank index pass through unchanged.
fn scope_base(scope: &str) -> &str {
    scope.split_once('#').map_or(scope, |(_, base)| base)
}

/// Channel values, in rank order, for an ADC regular-conversion sequence
/// that needs per-rank chain instantiation — empty when the single-chain
/// path applies (no `-{i}#` suffix in play and a rank count below 2).
///
/// Rank count N = max(bare `NbrOfConversion`, highest index + 1). Rank i's
/// Channel: the user's `Channel-{i}#ChannelRegularConversion`, else the
/// i-th selected IN mode's pinned Channel in the USER'S mode-array order
/// (`cfg.mode` — activation walks the tree in doc order, which reorders),
/// else the sequence stops; missing tail ranks are ADC_SEQUENCE_TRUNCATED's
/// business, not the generator's.
fn regular_sequence_channels(
    ip: &IpDef,
    cfg: &PeriphCfg,
    user_params: &[UserParam],
    sel: ModeSel<'_>,
) -> Vec<String> {
    const RM: &str = "ChannelRegularConversion";
    let n_idx = user_params
        .iter()
        .filter_map(|u| u.mode.as_deref()?.split_once('#'))
        .filter(|(_, b)| *b == RM)
        .filter_map(|(i, _)| i.parse::<usize>().ok())
        .map(|i| i + 1)
        .max()
        .unwrap_or(0);
    let n_bare = user_params
        .iter()
        .find(|u| u.mode.is_none() && u.db_name == "NbrOfConversion")
        .and_then(|u| json_to_value(&u.value).as_str().trim().parse::<usize>().ok())
        .unwrap_or(1);
    // The db caps NbrOfConversion at 16; range validation reports larger
    // values, this cap just keeps a typo from instantiating 10000 chains.
    let n = n_bare.max(n_idx).max(1).min(32);
    if n_idx == 0 && n < 2 {
        return Vec::new();
    }
    let indexed = |i: usize| -> Option<String> {
        let scope = format!("{i}#{RM}");
        user_params
            .iter()
            .find(|u| u.db_name == "Channel" && u.mode.as_deref() == Some(scope.as_str()))
            .map(|u| json_to_value(&u.value).as_str())
    };
    // IN-mode leaves (no ConfigForMode of their own, Channel pinned), in
    // the order the user listed them.
    let in_order: Vec<String> = cfg
        .mode
        .as_vec()
        .iter()
        .filter_map(|leaf| mode_chain(ip, leaf, sel))
        .filter(|c| c.config_for_mode.is_empty())
        .filter_map(|c| {
            c.parameters
                .iter()
                .find(|p| p.name == "Channel")
                .and_then(|p| p.pinned_values.first().cloned())
        })
        .collect();
    let mut out = Vec::new();
    for i in 0..n {
        match indexed(i).or_else(|| in_order.get(i).cloned()) {
            Some(ch) => out.push(ch),
            None => break,
        }
    }
    // Degenerate single-source sequences stay on the single-chain path so
    // their output is byte-identical to the pre-instantiation kernel.
    if n_idx == 0 && out.len() < 2 {
        return Vec::new();
    }
    out
}

/// Non-tree RefModes this config demands (ADC's ADC_Settings /
/// ChannelRegularConversion / ChannelInjectedConversion class): non-abstract,
/// not reachable through the mode tree, carrying ConfigForMode blocks, and
/// either named by a `-{RefModeName}` param suffix or pulling a bare-set
/// user param that no tree-reachable chain pulls (so TIM's legacy non-tree
/// One-Pulse/ClockSource RefModes never fire on shared names like `Pulse`).
/// ip.ref_modes doc order — deterministic.
fn auto_demanded_modes(
    ip: &IpDef,
    cfg: &PeriphCfg,
    sel: ModeSel<'_>,
    user_params: &[UserParam],
) -> Vec<String> {
    let mut tree_names: BTreeSet<String> = BTreeSet::new();
    if let Some(root) = &ip.mode_tree {
        collect_mode_names(root, &mut tree_names);
    }
    // Params pulled by any tree-reachable chain (leaf or not — being
    // selectable at all makes a name ambiguous for demand purposes).
    let mut tree_params: BTreeSet<&str> = BTreeSet::new();
    for name in &tree_names {
        if let Some(chain) = mode_chain(ip, name, sel) {
            for p in &chain.parameters {
                tree_params.insert(p.name.as_str());
            }
        }
    }
    let named: BTreeSet<&str> = user_params
        .iter()
        .filter_map(|u| u.mode.as_deref())
        .collect();
    let bare: BTreeMap<&str, String> = user_params
        .iter()
        .filter(|u| u.mode.is_none())
        .map(|u| (u.db_name.as_str(), json_to_value(&u.value).as_str()))
        .collect();
    let selected: BTreeSet<String> = cfg.mode.as_vec().into_iter().collect();

    // A boolean feature switch set to "false" does not demand its mode:
    // CubeMX stores `ADC1.EnableAnalogWatchDog=false` in the ioc yet emits
    // no ADC_AnalogWDGConfig block — an unchecked checkbox is a non-demand
    // (P7 parity fix; the reference adc.c is the ground truth).
    let demands = |name: &str| -> bool {
        match bare.get(name) {
            None => false,
            Some(v) => {
                !(v == "false"
                    && ip
                        .ref_parameters
                        .iter()
                        .any(|rp| rp.name == name && rp.param_type == "boolean"))
            }
        }
    };

    let mut out = Vec::new();
    for rm in &ip.ref_modes {
        if rm.is_abstract || tree_names.contains(&rm.name) || selected.contains(&rm.name) {
            continue;
        }
        let Some(chain) = mode_chain(ip, &rm.name, sel) else { continue };
        if chain.config_for_mode.is_empty() {
            continue;
        }
        let demanded = named.contains(rm.name.as_str())
            // An indexed suffix (`-0#ChannelRegularConversion`) demands the
            // RefMode it clones.
            || named.iter().any(|m| {
                m.split_once('#').is_some_and(|(i, b)| {
                    b == rm.name && !i.is_empty() && i.chars().all(|c| c.is_ascii_digit())
                })
            })
            // A conversion count above 1 demands the rank RefMode even when
            // no rank param names it — the sequence comes from the selected
            // IN modes.
            || (rm.name == "ChannelRegularConversion"
                && bare
                    .get("NbrOfConversion")
                    .and_then(|v| v.trim().parse::<i64>().ok())
                    .is_some_and(|n| n > 1))
            || chain.parameters.iter().any(|p| {
                p.pinned_values.is_empty()
                    && !tree_params.contains(p.name.as_str())
                    && demands(p.name.as_str())
            });
        if demanded {
            out.push(rm.name.clone());
        }
    }
    out
}

fn collect_mode_names(node: &ModeNode, out: &mut BTreeSet<String>) {
    match node {
        ModeNode::Operator { children, .. } => {
            for c in children {
                collect_mode_names(c, out);
            }
        }
        ModeNode::Mode { name, children, .. } => {
            out.insert(name.clone());
            for c in children {
                collect_mode_names(c, out);
            }
        }
    }
}

/// A value is symbolic when any identifier token in it names a declared
/// project.userConstants entry (`TIM_1_8_PERIOD_CLOCKS`,
/// `TIM_APB1_PERIOD_CLOCKS+1`, ...).
fn is_symbolic(value: &str, consts: &BTreeMap<String, String>) -> bool {
    if consts.is_empty() {
        return false;
    }
    value
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|tok| !tok.is_empty() && consts.contains_key(tok))
}

/// Final value of one active chain parameter: pinned > user-in-context >
/// user-bare > default (uniqueElementList takes its first allowed
/// PossibleValue). Returns None when the result is not blackboard material:
/// empty, "null", or a `+`/`=` codegen indirection (those stay unresolved
/// for the emitter).
fn final_param_value(
    rp: &RefParameter,
    mp: &ModeParameter,
    user_params: &[UserParam],
    ctx_mode: &str,
    instance: &str,
    env: &Env,
    trace: &mut EvalTrace,
) -> Option<String> {
    let user = user_params
        .iter()
        .find(|u| u.db_name == mp.name && u.mode.as_deref() == Some(ctx_mode))
        .or_else(|| {
            // Un-indexed RefMode suffixes broadcast into every rank clone:
            // `SamplingTime-ChannelRegularConversion` applies to each
            // `{i}#ChannelRegularConversion` scope that lacks an exact hit.
            let base = scope_base(ctx_mode);
            (base != ctx_mode).then(|| {
                user_params
                    .iter()
                    .find(|u| u.db_name == mp.name && u.mode.as_deref() == Some(base))
            })?
        })
        .or_else(|| {
            user_params
                .iter()
                .find(|u| u.db_name == mp.name && u.mode.is_none())
        });
    let value = if let Some(pin) = mp.pinned_values.first() {
        pin.clone()
    } else if let Some(u) = user {
        json_to_value(&u.value).as_str()
    } else if matches!(rp.param_type.as_str(), "uniqueElementList" | "list")
        && rp.default_value.trim().is_empty()
    {
        // An enumerated parameter with no `DefaultValue` takes the first
        // value still available in this configuration — CubeMX shows that
        // entry preselected in the dialog and publishes its semaphore.
        //
        // TIM's `Dithering` is declared exactly this way, with
        // `Semaphore_DitheringDisable_$IpInstance` on its first value.
        // Treating the empty default as "no value" left that semaphore down,
        // and with it went every parameter guarded on it: `PeriodNoDither`
        // and `PulseNoDither_*` have no applicable overload without it, so a
        // plain PWM timer reported them as inactive and generated Period 0.
        //
        // Self-limiting where the db means "unset": `ClearChannel1` lists the
        // empty value first, so it still resolves to nothing.
        let dom = effective_domain_bound(rp, instance, env, trace);
        dom.values
            .first()
            .map(|pv| pv.value.clone())
            .unwrap_or_else(|| rp.default_value.clone())
    } else {
        rp.default_value.clone()
    };
    let t = value.trim();
    if t.is_empty() || t == "null" || t.starts_with('+') || t.starts_with('=') {
        return None;
    }
    Some(value)
}

fn json_to_value(v: &serde_json::Value) -> Value {
    match v {
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Num(Num::from_integer(i))
            } else {
                Value::Str(n.to_string())
            }
        }
        serde_json::Value::String(s) => {
            let t = s.trim();
            // Hex literals stay strings: `as_num` parses them lazily for
            // range checks, while codegen keeps the C spelling verbatim
            // (CubeMX emits `Period = 0xffff;`, not `65535`).
            if t.starts_with("0x") || t.starts_with("0X") {
                Value::Str(s.clone())
            } else {
                match stm32ck_ir::expr::parse_number(t) {
                    Some(n) => Value::Num(n),
                    None => Value::Str(s.clone()),
                }
            }
        }
        // db boolean lists spell their values "true"/"false" (ADC
        // EnableAnalogWatchDog); JSON booleans map onto those literals.
        serde_json::Value::Bool(b) => Value::Str(b.to_string()),
        other => Value::Str(other.to_string()),
    }
}

/// EXTI line of a pad: the pin bit number ("PC13" -> 13).
fn exti_line(pad: &str) -> Option<u32> {
    let b = pad.as_bytes();
    if b.len() >= 3 && b[0] == b'P' && b[1].is_ascii_alphabetic() {
        pad[2..].parse().ok()
    } else {
        None
    }
}

fn fmt_num(n: Num) -> String {
    if n.is_integer() {
        n.numer().to_string()
    } else {
        format!("{n}")
    }
}
