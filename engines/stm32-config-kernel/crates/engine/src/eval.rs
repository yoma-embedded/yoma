//! Condition-DSL evaluation against the blackboard.
//!
//! Semantics (mirroring CubeMX's observed behavior):
//! - bare identifier: true if it is a raised semaphore, else the truthiness
//!   of the parameter with that name, else false (recorded as unknown)
//! - `lhs = rhs`: lhs resolved through the param store; rhs is a literal
//!   token (enum value or number). Numeric when both sides are numeric,
//!   string equality otherwise.
//! - `<` / `>`: strict numeric; non-numeric operands make the comparison
//!   false (recorded as unknown when a param is missing).
//! - unknown identifiers evaluate false, never abort — the db is sloppy
//!   and CubeMX tolerates it; we surface it via `EvalTrace::unknowns`.

use crate::env::Env;
use std::collections::BTreeSet;
use stm32ck_ir::expr::{CmpOp, Condition, Expr, Num, Verb};

/// Side-channel of an evaluation: identifiers we could not resolve.
#[derive(Debug, Default, Clone)]
pub struct EvalTrace {
    pub unknowns: BTreeSet<String>,
}

pub fn eval(expr: &Expr, env: &Env, trace: &mut EvalTrace) -> bool {
    match expr {
        Expr::Ident(name) => {
            if env.semaphores.contains(name) {
                true
            } else if let Some(v) = env.get(name) {
                v.truthy()
            } else {
                trace.unknowns.insert(name.clone());
                false
            }
        }
        Expr::Number(n) => *n.numer() != 0,
        Expr::Not(e) => !eval(e, env, trace),
        Expr::And(items) => items.iter().all(|e| eval(e, env, trace)),
        Expr::Or(items) => items.iter().any(|e| eval(e, env, trace)),
        Expr::Cmp { op, lhs, rhs } => eval_cmp(*op, lhs, rhs, env, trace),
        // `+` between semaphores is CubeMX's boolean OR — TIM writes
        // `!(Semaphore_Channel1$Ip+Semaphore_Channel2$Ip)` for "no channel
        // active". In boolean position that is the only reading that makes
        // sense; the numeric reading applies inside comparisons, which go
        // through `resolve` instead.
        Expr::Arith {
            op: stm32ck_ir::expr::ArithOp::Add,
            lhs,
            rhs,
        } => eval(lhs, env, trace) || eval(rhs, env, trace),
        // A scaled operand standing alone is truthy when non-zero, the same
        // rule bare numbers follow.
        Expr::Arith { .. } => num_of(&resolve(expr, env, trace)).is_some_and(|n| *n.numer() != 0),
    }
}

/// Evaluate an expression to the string CubeMX would substitute — the
/// blackboard value of an identifier, an evaluated arithmetic operand, or the
/// token itself when nothing backs it (`RCC_HSE_ON`). This is what backs the
/// db's `DefaultValue="=<expr>"` computed defaults.
pub fn eval_value(expr: &Expr, env: &Env, trace: &mut EvalTrace) -> String {
    str_of(&resolve(expr, env, trace))
}

/// Evaluate a `Condition`. Directive conditions (`force:`/`warning:`) do not
/// gate applicability the way plain ones do; for gating purposes we treat
/// them as "matches" only if a `force:` clause holds (conservative reading
/// of the NVIC dialect) — callers that care about warnings inspect them
/// separately via [`directive_warnings`].
pub fn eval_condition(cond: &Condition, env: &Env, trace: &mut EvalTrace) -> bool {
    match cond {
        Condition::Plain(e) => eval(e, env, trace),
        Condition::Directives(dirs) => dirs
            .iter()
            .any(|(verb, e)| *verb == Verb::Force && eval(e, env, trace)),
    }
}

/// Which `warning:` clauses of a directive condition currently hold.
pub fn directive_warnings<'a>(
    cond: &'a Condition,
    env: &Env,
    trace: &mut EvalTrace,
) -> Vec<&'a Expr> {
    match cond {
        Condition::Plain(_) => Vec::new(),
        Condition::Directives(dirs) => dirs
            .iter()
            .filter(|(verb, e)| *verb == Verb::Warning && eval(e, env, trace))
            .map(|(_, e)| e)
            .collect(),
    }
}

fn eval_cmp(op: CmpOp, lhs: &Expr, rhs: &Expr, env: &Env, trace: &mut EvalTrace) -> bool {
    let lhs_val = resolve(lhs, env, trace);
    let rhs_val = resolve(rhs, env, trace);
    match op {
        CmpOp::Eq => match (num_of(&lhs_val), num_of(&rhs_val)) {
            (Some(a), Some(b)) => a == b,
            _ => str_of(&lhs_val) == str_of(&rhs_val),
        },
        CmpOp::Lt => match (num_of(&lhs_val), num_of(&rhs_val)) {
            (Some(a), Some(b)) => a < b,
            _ => false,
        },
        CmpOp::Gt => match (num_of(&lhs_val), num_of(&rhs_val)) {
            (Some(a), Some(b)) => a > b,
            _ => false,
        },
        CmpOp::Le => match (num_of(&lhs_val), num_of(&rhs_val)) {
            (Some(a), Some(b)) => a <= b,
            _ => false,
        },
        CmpOp::Ge => match (num_of(&lhs_val), num_of(&rhs_val)) {
            (Some(a), Some(b)) => a >= b,
            _ => false,
        },
        // `<>` mirrors Eq's numeric-else-string fallback so `A<>ENUM` is
        // exactly the negation of `A=ENUM` (CubeMX __notequals is the
        // double-negated __equals; the kernel keeps its established
        // enum-token string semantics symmetric).
        CmpOp::Ne => match (num_of(&lhs_val), num_of(&rhs_val)) {
            (Some(a), Some(b)) => a != b,
            _ => str_of(&lhs_val) != str_of(&rhs_val),
        },
    }
}

/// A comparison operand, resolved as far as the blackboard allows.
enum Resolved {
    Num(Num),
    Str(String),
}

fn resolve(e: &Expr, env: &Env, trace: &mut EvalTrace) -> Resolved {
    match e {
        Expr::Number(n) => Resolved::Num(*n),
        Expr::Arith { op, lhs, rhs } => {
            // A scaled operand is only meaningful numerically; if either side
            // is a bare enum token (or an unset parameter), there is nothing
            // to scale and the comparison must not silently succeed against a
            // fabricated 0.
            let (Some(a), Some(b)) = (
                num_of(&resolve(lhs, env, trace)),
                num_of(&resolve(rhs, env, trace)),
            ) else {
                return Resolved::Str(e.to_string());
            };
            match op {
                stm32ck_ir::expr::ArithOp::Mul => Resolved::Num(a * b),
                stm32ck_ir::expr::ArithOp::Add => Resolved::Num(a + b),
                stm32ck_ir::expr::ArithOp::Div if *b.numer() != 0 => Resolved::Num(a / b),
                stm32ck_ir::expr::ArithOp::Div => Resolved::Str(e.to_string()),
            }
        }
        Expr::Ident(name) => {
            if let Some(v) = env.get(name) {
                match v.as_num() {
                    Some(n) => Resolved::Num(n),
                    None => Resolved::Str(v.as_str()),
                }
            } else {
                // Literal token (enum value) — not an error. Only record as
                // unknown when it *looks like* a parameter reference used
                // numerically; comparisons against enum literals are the norm.
                Resolved::Str(name.clone())
            }
        }
        // Nested comparison/boolean inside a comparison is not part of the
        // observed grammar; evaluate to 0/1 defensively.
        other => {
            let b = eval(other, env, trace);
            Resolved::Num(Num::from_integer(b as i64))
        }
    }
}

fn num_of(r: &Resolved) -> Option<Num> {
    match r {
        Resolved::Num(n) => Some(*n),
        Resolved::Str(s) => stm32ck_ir::expr::parse_number(s.trim()),
    }
}

fn str_of(r: &Resolved) -> String {
    match r {
        Resolved::Num(n) => {
            if n.is_integer() {
                n.numer().to_string()
            } else {
                format!("{n}")
            }
        }
        Resolved::Str(s) => s.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stm32ck_ir::expr::{parse_condition, parse_expr};

    fn env_f103() -> Env {
        let mut env = Env::new();
        env.raise("STM32F103");
        env.raise("HSEOscillator");
        env.set("PLLUsed", 1);
        env.set("SYSCLKSource", "RCC_SYSCLKSOURCE_PLLCLK");
        env.set("SYSCLKFreq_VALUE", 72_000_000);
        env.set("VDD_VALUE", crate::env::Value::Num(stm32ck_ir::expr::parse_number("3.3").unwrap()));
        env
    }

    fn ev(src: &str, env: &Env) -> bool {
        eval(&parse_expr(src).unwrap(), env, &mut EvalTrace::default())
    }

    #[test]
    fn semaphore_and_param_eq() {
        let env = env_f103();
        assert!(ev("PLLUsed=1 & STM32F103", &env));
        assert!(!ev("PLLUsed=1 & STM32F102", &env));
    }

    #[test]
    fn enum_equality_is_string_eq() {
        let env = env_f103();
        assert!(ev("SYSCLKSource=RCC_SYSCLKSOURCE_PLLCLK", &env));
        assert!(!ev("SYSCLKSource=RCC_SYSCLKSOURCE_HSE", &env));
    }

    #[test]
    fn le_encoding() {
        let env = env_f103();
        assert!(ev(
            "((SYSCLKFreq_VALUE < 72000000)|((SYSCLKFreq_VALUE =72000000)))",
            &env
        ));
        assert!(!ev("SYSCLKFreq_VALUE < 72000000", &env));
        assert!(ev("SYSCLKFreq_VALUE > 24000000", &env));
    }

    #[test]
    fn decimal_compare() {
        let env = env_f103();
        assert!(!ev("(VDD_VALUE < 2.1)", &env));
        assert!(ev("(VDD_VALUE > 2.7)", &env));
    }

    #[test]
    fn le_ge_boundary() {
        let env = env_f103();
        assert!(ev("SYSCLKFreq_VALUE <= 72000000", &env));
        assert!(ev("SYSCLKFreq_VALUE >= 72000000", &env));
        assert!(!ev("SYSCLKFreq_VALUE <= 71999999", &env));
        assert!(!ev("SYSCLKFreq_VALUE >= 72000001", &env));
    }

    #[test]
    fn ne_string_and_numeric() {
        let env = env_f103();
        assert!(ev("SYSCLKSource <> RCC_SYSCLKSOURCE_HSE", &env));
        assert!(!ev("SYSCLKSource <> RCC_SYSCLKSOURCE_PLLCLK", &env));
        assert!(!ev("PLLUsed <> 1", &env));
        assert!(ev("PLLUsed <> 2", &env));
    }

    #[test]
    fn not_eq_flip_semantics() {
        // The F102/F105 PREFETCH_ENABLE overload guard: `!A=B` == `!(A=B)`.
        let mut env = Env::new();
        env.set("AHBCLKDivider", "RCC_SYSCLK_DIV2");
        assert!(ev("!AHBCLKDivider=RCC_SYSCLK_DIV1", &env));
        env.set("AHBCLKDivider", "RCC_SYSCLK_DIV1");
        assert!(!ev("!AHBCLKDivider=RCC_SYSCLK_DIV1", &env));
    }

    #[test]
    fn unknown_ident_is_false_and_traced() {
        let env = env_f103();
        let mut trace = EvalTrace::default();
        let e = parse_expr("USBUsed_ForRCC | STM32F103").unwrap();
        assert!(eval(&e, &env, &mut trace));
        assert!(trace.unknowns.contains("USBUsed_ForRCC"));
    }

    #[test]
    fn directive_condition_gating() {
        let mut env = env_f103();
        let c = parse_condition("force:(COMP1_EXTI_IT_ENABLED);warning:COMP_IRQn").unwrap();
        let mut trace = EvalTrace::default();
        assert!(!eval_condition(&c, &env, &mut trace));
        env.raise("COMP1_EXTI_IT_ENABLED");
        assert!(eval_condition(&c, &env, &mut trace));
        env.raise("COMP_IRQn");
        assert_eq!(directive_warnings(&c, &env, &mut trace).len(), 1);
    }

    #[test]
    fn truthy_bare_param() {
        let mut env = Env::new();
        env.set("HSEByPass", 0);
        assert!(!ev("HSEByPass", &env));
        env.set("HSEByPass", 1);
        assert!(ev("HSEByPass", &env));
    }
}
