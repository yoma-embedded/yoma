//! Parameter resolution: condition-ordered overloads, effective value
//! domains, and RefMode inheritance chains.

use crate::env::Env;
use crate::eval::{eval_condition, EvalTrace};
use crate::modes::bind_condition;
use stm32ck_ir::expr::{Condition, Num};
use stm32ck_ir::model::{IpDef, ModeParameter, PossibleValue, PvAction, RefMode, RefParameter};

/// Select the applicable overload of `name` from a doc-ordered slice:
/// first entry whose condition evaluates true wins; a condition-less entry
/// always matches (the db convention puts the fallback last).
pub fn resolve_overload<'a>(
    overloads: impl IntoIterator<Item = &'a RefParameter>,
    env: &Env,
    trace: &mut EvalTrace,
) -> Option<&'a RefParameter> {
    overloads.into_iter().find(|rp| match &rp.condition {
        None => true,
        Some(dc) => eval_condition(&dc.condition, env, trace),
    })
}

/// All overload blocks of one parameter name in an IP def, in doc order.
pub fn overloads_of<'a>(ip: &'a IpDef, name: &str) -> Vec<&'a RefParameter> {
    ip.ref_parameters
        .iter()
        .filter(|rp| rp.name == name)
        .collect()
}

/// Resolve a parameter in one step.
pub fn resolve_param<'a>(
    ip: &'a IpDef,
    name: &str,
    env: &Env,
    trace: &mut EvalTrace,
) -> Option<&'a RefParameter> {
    resolve_overload(overloads_of(ip, name), env, trace)
}

/// Instance-bound overload resolution: `$IpInstance`/`$Index` macros in the
/// overload guards are expanded for `instance` before evaluation (SPI's NSS
/// overloads are guarded by `$IpInstance_NSSHARD_Output` etc. — unbound
/// they can never match).
pub fn resolve_param_bound<'a>(
    ip: &'a IpDef,
    name: &str,
    instance: &str,
    env: &Env,
    trace: &mut EvalTrace,
) -> Option<&'a RefParameter> {
    overloads_of(ip, name).into_iter().find(|rp| match &rp.condition {
        None => true,
        Some(dc) => eval_condition(&bind_condition(&dc.condition, instance), env, trace),
    })
}

/// The current legal domain of a resolved parameter.
#[derive(Debug, Clone)]
pub struct Domain<'a> {
    pub param: &'a RefParameter,
    /// Allowed enum values after per-value Condition+Action filtering
    /// (empty for pure numeric parameters).
    pub values: Vec<&'a PossibleValue>,
    /// Values currently filtered out, with the reason (for diagnostics).
    pub excluded: Vec<(&'a PossibleValue, PvAction, String)>,
    pub min: Option<Num>,
    pub max: Option<Num>,
}

/// Compute the effective domain: PossibleValues whose `condition` is true
/// get their `action` applied (Disable/Remove both exclude the value; the
/// distinction only affects UI presentation, which we surface in diags).
/// Values without action-conditions are always allowed.
pub fn effective_domain<'a>(param: &'a RefParameter, env: &Env, trace: &mut EvalTrace) -> Domain<'a> {
    effective_domain_impl(param, None, env, trace)
}

/// Instance-bound variant of [`effective_domain`]: per-value conditions get
/// `$IpInstance`/`$Index` expanded before evaluation.
pub fn effective_domain_bound<'a>(
    param: &'a RefParameter,
    instance: &str,
    env: &Env,
    trace: &mut EvalTrace,
) -> Domain<'a> {
    effective_domain_impl(param, Some(instance), env, trace)
}

fn effective_domain_impl<'a>(
    param: &'a RefParameter,
    instance: Option<&str>,
    env: &Env,
    trace: &mut EvalTrace,
) -> Domain<'a> {
    let eval_pv = |cond: &Condition, trace: &mut EvalTrace| match instance {
        Some(inst) => eval_condition(&bind_condition(cond, inst), env, trace),
        None => eval_condition(cond, env, trace),
    };
    let mut values = Vec::new();
    let mut excluded = Vec::new();
    for pv in &param.possible_values {
        match (&pv.condition, pv.action) {
            // CubeMX: a PossibleValue Condition that holds means the value
            // is EXCLUDED; Action only selects presentation (ApiDbIP maps
            // it to a diagnostic prefix — "remove" drops the entry, the
            // default "?" — which "Disable" and no-Action both fall into —
            // grays it out un-selectable, "error" paints it red). The db
            // reads that way too: the diagnostics are exclusion reasons
            // ("EXTI0 not configured", "Available when NbrOfConversion is
            // grater than 1"). NVIC IRQn variants are NOT filtered here —
            // the importer lifts them into NvicVector (parse_nvic_vectors)
            // and session/dma consume those directly, so their "static"
            // availability-guard semantics never pass through this match.
            (Some(cond), action) => {
                if eval_pv(cond, trace) {
                    excluded.push((
                        pv,
                        action.unwrap_or(PvAction::Disable),
                        pv.diagnostic.clone(),
                    ));
                } else {
                    values.push(pv);
                }
            }
            (None, _) => values.push(pv),
        }
    }
    Domain {
        param,
        values,
        excluded,
        min: param.min,
        max: param.max,
    }
}

/// Validation verdict for a candidate value against a domain.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Ok,
    NotInList { allowed: Vec<String> },
    OutOfRange { min: Option<Num>, max: Option<Num> },
    ExcludedValue { diagnostic: String },
}

pub fn check_value(domain: &Domain<'_>, value: &crate::env::Value) -> Verdict {
    // Enum-list parameter: value must be one of the allowed literals.
    if !domain.param.possible_values.is_empty() {
        let s = value.as_str();
        if domain.values.iter().any(|pv| pv.value == s) {
            return Verdict::Ok;
        }
        if let Some((pv, _, diag)) = domain
            .excluded
            .iter()
            .find(|(pv, _, _)| pv.value == s)
        {
            let _ = pv;
            return Verdict::ExcludedValue {
                diagnostic: diag.clone(),
            };
        }
        return Verdict::NotInList {
            allowed: domain.values.iter().map(|pv| pv.value.clone()).collect(),
        };
    }
    // Numeric parameter: range check when bounds exist. The value may be an
    // arithmetic expression rather than a bare number — CubeMX accepts
    // `250-1` as a TIM Prescaler and passes the text through to C verbatim —
    // so the bound is checked against its evaluated result.
    if domain.min.is_some() || domain.max.is_some() {
        let n = value
            .as_num()
            .or_else(|| stm32ck_ir::expr::eval_arith(&value.as_str(), &|_| None));
        match n {
            Some(n) => {
                if domain.min.is_some_and(|m| n < m) || domain.max.is_some_and(|m| n > m) {
                    return Verdict::OutOfRange {
                        min: domain.min,
                        max: domain.max,
                    };
                }
            }
            None => {
                return Verdict::OutOfRange {
                    min: domain.min,
                    max: domain.max,
                }
            }
        }
    }
    Verdict::Ok
}

/// A RefMode resolved through its BaseMode inheritance chain:
/// leaf-first list of modes, merged ConfigForMode order (base first, the
/// way CubeMX emits Base_Init before specialized configs), and the union
/// of pulled-in parameters (leaf pinnings win).
#[derive(Debug, Clone)]
pub struct ModeChain<'a> {
    pub modes: Vec<&'a RefMode>,
    pub config_for_mode: Vec<String>,
    pub parameters: Vec<&'a ModeParameter>,
    pub hal_mode: Option<String>,
    /// Value-context identity of this chain. Defaults to the leaf RefMode
    /// name; per-rank clones of one RefMode (ADC regular sequences) carry
    /// `"{i}#{RefMode}"` so every clone keeps its own parameter scope —
    /// the same identity CubeMX stores in the ioc (`Channel-0#Channel
    /// RegularConversion`).
    pub scope: String,
    /// `(parameter, value)` pairs forced into this chain's scope after the
    /// regular parameter pass — the kernel's equivalent of CubeMX's
    /// `addIPMode` pinning `Rank` on each cloned row via setMin/setMax.
    pub seeds: Vec<(String, String)>,
}

/// Evaluation context for narrowing a same-name RefMode overload set:
/// the instance `$IpInstance` binds to, and the blackboard to read.
#[derive(Clone, Copy)]
pub struct ModeSel<'e> {
    pub instance: &'e str,
    pub env: &'e Env,
}

/// Select the applicable overload of RefMode `name` — same discipline as
/// [`resolve_overload`] for parameters: doc order, first entry whose
/// `<Condition>` holds wins, a condition-less entry always matches.
///
/// The db leans on this: `USART-sci3_v2_0` declares `Asynchronous` twice,
/// the first guarded by `$IpInstance_HardwareControl` and carrying no
/// `ConfigForMode` at all, the second unconditional with `Uart_Init`.
/// Taking the first match unconditionally yields a mode with nothing to
/// generate — an empty `MX_USART1_UART_Init`. 942 same-name groups across
/// the db disagree on `ConfigForMode` this way.
pub fn resolve_mode_overload<'a>(
    ip: &'a IpDef,
    name: &str,
    sel: ModeSel<'_>,
) -> Option<&'a RefMode> {
    let mut trace = EvalTrace::default();
    ip.ref_modes
        .iter()
        .filter(|m| m.name == name)
        .find(|m| match &m.condition {
            None => true,
            Some(dc) => {
                let bound = bind_condition(&dc.condition, sel.instance);
                let mut env = sel.env.clone();
                env.scope = Some(sel.instance.to_string());
                eval_condition(&bound, &env, &mut trace)
            }
        })
}

pub fn mode_chain<'a>(ip: &'a IpDef, leaf: &str, sel: ModeSel<'_>) -> Option<ModeChain<'a>> {
    let mut modes: Vec<&RefMode> = Vec::new();
    let mut cursor = Some(leaf.to_string());
    let mut guard = 0;
    while let Some(name) = cursor {
        guard += 1;
        if guard > 16 {
            break; // cycle in db data; lint-level issue, refuse to loop
        }
        let m = resolve_mode_overload(ip, &name, sel)?;
        modes.push(m);
        // An empty BaseMode="" (DMA's abstract DMA_Request) ends the chain.
        cursor = m.base_mode.clone().filter(|b| !b.is_empty());
    }

    // Base-first for codegen ordering.
    let mut config_for_mode = Vec::new();
    for m in modes.iter().rev() {
        for c in &m.config_for_mode {
            if !config_for_mode.contains(c) {
                config_for_mode.push(c.clone());
            }
        }
    }

    // Parameters: leaf declarations shadow base ones with the same name.
    let mut parameters: Vec<&ModeParameter> = Vec::new();
    for m in &modes {
        for p in &m.parameters {
            if !parameters.iter().any(|q| q.name == p.name) {
                parameters.push(p);
            }
        }
    }

    let hal_mode = modes.iter().find_map(|m| m.hal_mode.clone());
    Some(ModeChain {
        modes,
        config_for_mode,
        parameters,
        hal_mode,
        scope: leaf.to_string(),
        seeds: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Value;
    use stm32ck_ir::expr::{parse_condition, Num};
    use stm32ck_ir::model::DiagCondition;

    fn rp(name: &str, cond: Option<&str>, max: i64) -> RefParameter {
        RefParameter {
            name: name.into(),
            comment: String::new(),
            default_value: String::new(),
            param_type: "double".into(),
            min: None,
            max: Some(Num::from_integer(max)),
            unit: String::new(),
            group: String::new(),
            visible: false,
            condition: cond.map(|c| DiagCondition {
                condition: parse_condition(c).unwrap(),
                diagnostic: String::new(),
            }),
            possible_values: Vec::new(),
        }
    }

    #[test]
    fn first_match_wins_with_fallback() {
        // Mirrors HSE_VALUE: bypass overload first, crystal fallback last.
        let a = rp("HSE_VALUE", Some("HSEByPass"), 25_000_000);
        let b = rp("HSE_VALUE", None, 16_000_000);
        let overloads = vec![&a, &b];

        let mut env = Env::new();
        let mut tr = EvalTrace::default();
        let got = resolve_overload(overloads.clone(), &env, &mut tr).unwrap();
        assert_eq!(got.max, Some(Num::from_integer(16_000_000)));

        env.raise("HSEByPass");
        let got = resolve_overload(overloads, &env, &mut tr).unwrap();
        assert_eq!(got.max, Some(Num::from_integer(25_000_000)));
    }

    #[test]
    fn range_check() {
        let p = rp("X", None, 100);
        let env = Env::new();
        let mut tr = EvalTrace::default();
        let d = effective_domain(&p, &env, &mut tr);
        assert_eq!(check_value(&d, &Value::from(50)), Verdict::Ok);
        assert!(matches!(
            check_value(&d, &Value::from(101)),
            Verdict::OutOfRange { .. }
        ));
    }

    #[test]
    fn value_filtering_disable_action() {
        // Mirrors ADC DiscontinuousConvMode: ENABLE disabled when
        // ContinuousConvMode = ENABLE.
        let mut p = rp("DiscontinuousConvMode", None, 0);
        p.max = None;
        p.param_type = "list".into();
        p.possible_values = vec![
            PossibleValue {
                value: "DISABLE".into(),
                comment: "Disabled".into(),
                factor: None,
                semaphore: None,
                condition: None,
                action: None,
                diagnostic: String::new(),
            },
            PossibleValue {
                value: "ENABLE".into(),
                comment: "Enabled".into(),
                factor: None,
                semaphore: None,
                condition: Some(parse_condition("ContinuousConvMode = ENABLE").unwrap()),
                action: Some(PvAction::Disable),
                diagnostic: "Continuous and Discontinuous cannot combine".into(),
            },
        ];

        let mut env = Env::new();
        env.set("ContinuousConvMode", "ENABLE");
        let mut tr = EvalTrace::default();
        let d = effective_domain(&p, &env, &mut tr);
        assert_eq!(d.values.len(), 1);
        assert!(matches!(
            check_value(&d, &Value::from("ENABLE")),
            Verdict::ExcludedValue { .. }
        ));

        env.set("ContinuousConvMode", "DISABLE");
        let d = effective_domain(&p, &env, &mut tr);
        assert_eq!(d.values.len(), 2);
        assert_eq!(check_value(&d, &Value::from("ENABLE")), Verdict::Ok);
    }

    fn pv(value: &str, cond: Option<&str>, diag: &str) -> PossibleValue {
        PossibleValue {
            value: value.into(),
            comment: String::new(),
            factor: None,
            semaphore: None,
            condition: cond.map(|c| parse_condition(c).unwrap()),
            action: None,
            diagnostic: diag.into(),
        }
    }

    /// CubeMX semantics: a no-Action condition that HOLDS excludes the value
    /// (grayed out, un-selectable — ComboBoxEditor's "?" handling). U0 ADC
    /// verbatim: scan mode choices are gated on NbrOfConversion.
    #[test]
    fn no_action_condition_excludes_when_true() {
        let mut p = rp("ScanConvMode", None, 0);
        p.max = None;
        p.param_type = "list".into();
        p.possible_values = vec![
            pv(
                "ADC_SCAN_DISABLE",
                Some("(NbrOfConversion >1)"),
                "Available when NbrOfConversion is 1",
            ),
            pv(
                "ADC_SCAN_ENABLE",
                Some("(NbrOfConversion =1)"),
                "Available when NbrOfConversion is grater than 1",
            ),
        ];

        let mut env = Env::new();
        env.set("NbrOfConversion", 1);
        let mut tr = EvalTrace::default();
        let d = effective_domain(&p, &env, &mut tr);
        assert_eq!(d.values.len(), 1);
        assert_eq!(d.values[0].value, "ADC_SCAN_DISABLE");
        assert!(matches!(
            check_value(&d, &Value::from("ADC_SCAN_ENABLE")),
            Verdict::ExcludedValue { .. }
        ));

        env.set("NbrOfConversion", 3);
        let d = effective_domain(&p, &env, &mut tr);
        assert_eq!(d.values.len(), 1);
        assert_eq!(d.values[0].value, "ADC_SCAN_ENABLE");
    }

    /// F405 SPI (spi2s1_v2_2, in the ODrive pack) verbatim: TI mode is
    /// excluded until hardware NSS is on — a parenthesized `!` condition, so
    /// it must be stable across the `!`-precedence change too.
    #[test]
    fn spi_timode_excluded_without_hard_nss() {
        let mut p = rp("TIMode", None, 0);
        p.max = None;
        p.param_type = "list".into();
        p.possible_values = vec![
            pv("SPI_TIMODE_DISABLE", None, ""),
            pv(
                "SPI_TIMODE_ENABLE",
                Some("!(VirtualNSS = VM_NSSHARD)"),
                "Hardware NSS signal must be enabled first",
            ),
        ];

        let env = Env::new();
        let mut tr = EvalTrace::default();
        let d = effective_domain(&p, &env, &mut tr);
        assert_eq!(d.values.len(), 1, "TI mode gone without hard NSS");
        match check_value(&d, &Value::from("SPI_TIMODE_ENABLE")) {
            Verdict::ExcludedValue { diagnostic, .. } => {
                assert!(diagnostic.contains("Hardware NSS"), "diagnostic: {diagnostic}")
            }
            other => panic!("expected ExcludedValue, got {other:?}"),
        }

        let mut env = Env::new();
        env.set("VirtualNSS", "VM_NSSHARD");
        let d = effective_domain(&p, &env, &mut tr);
        assert_eq!(d.values.len(), 2, "hard NSS makes TI mode selectable");
    }

    /// G4 DMAMUX request generators verbatim: `!GPIO_EXTIn_SEM` — the
    /// semaphore being DOWN excludes the choice, raising it frees it.
    #[test]
    fn dmamux_semaphore_gate() {
        let mut p = rp("Request", None, 0);
        p.max = None;
        p.param_type = "list".into();
        p.possible_values = vec![pv(
            "HAL_DMAMUX1_REQ_GEN_EXTI0",
            Some("!GPIO_EXTI0_SEM"),
            "EXTI0 not configured",
        )];

        let env = Env::new();
        let mut tr = EvalTrace::default();
        let d = effective_domain(&p, &env, &mut tr);
        assert!(d.values.is_empty(), "semaphore down => excluded");
        assert_eq!(d.excluded.len(), 1);
        assert_eq!(d.excluded[0].1, PvAction::Disable, "no-Action presents as Disable");

        let mut env = Env::new();
        env.raise("GPIO_EXTI0_SEM");
        let d = effective_domain(&p, &env, &mut tr);
        assert_eq!(d.values.len(), 1, "semaphore up => available");
    }
}
