//! The blackboard: global semaphore set + parameter store the condition DSL
//! evaluates against. One `Env` describes one fully-bound configuration
//! state (device flags + user choices + propagated values).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use stm32ck_ir::expr::Num;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Value {
    /// Enum literal / free string (HAL constants like "RCC_HCLK_DIV1").
    Str(String),
    /// Exact number. Frequencies are Hz; VDD is volts (db convention).
    Num(Num),
}

impl Value {
    pub fn as_num(&self) -> Option<Num> {
        match self {
            Value::Num(n) => Some(*n),
            Value::Str(s) => stm32ck_ir::expr::parse_number(s.trim()),
        }
    }

    pub fn as_str(&self) -> String {
        match self {
            Value::Str(s) => s.clone(),
            Value::Num(n) => {
                if n.is_integer() {
                    n.numer().to_string()
                } else {
                    format!("{n}")
                }
            }
        }
    }

    /// CubeMX truthiness for a bare identifier that names a parameter:
    /// non-zero number, or non-empty / non-"0" / non-"false" string.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Num(n) => *n.numer() != 0,
            Value::Str(s) => {
                let s = s.trim();
                !s.is_empty() && s != "0" && s != "false" && s != "null"
            }
        }
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Str(s.to_string())
    }
}

impl From<i64> for Value {
    fn from(n: i64) -> Self {
        Value::Num(Num::from_integer(n))
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Env {
    pub semaphores: BTreeSet<String>,
    /// Global params use their bare name; per-instance params are keyed
    /// `"{instance}:{name}"` (the db's own cross-instance syntax);
    /// RefMode-scoped params are keyed `"{instance}:{name}@{refmode}"`
    /// (shared names like TIM `Pulse` differ per channel RefMode).
    pub params: BTreeMap<String, Value>,
    /// Current instance scope for bare-identifier resolution: a condition
    /// inside USART1's IP def sees USART1's params first, then globals.
    pub scope: Option<String>,
    /// Current RefMode context inside `scope`: the mode-context key wins
    /// over the instance key, which wins over the bare key.
    pub mode_scope: Option<String>,
}

impl Env {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn raise(&mut self, sem: impl Into<String>) {
        self.semaphores.insert(sem.into());
    }

    pub fn set(&mut self, param: impl Into<String>, value: impl Into<Value>) {
        self.params.insert(param.into(), value.into());
    }

    pub fn set_scoped(&mut self, instance: &str, param: &str, value: impl Into<Value>) {
        self.params.insert(format!("{instance}:{param}"), value.into());
    }

    /// RefMode-context write: `"{instance}:{param}@{mode}"`.
    pub fn set_mode_scoped(
        &mut self,
        instance: &str,
        mode: &str,
        param: &str,
        value: impl Into<Value>,
    ) {
        self.params
            .insert(format!("{instance}:{param}@{mode}"), value.into());
    }

    /// Mode-context-then-scoped-then-bare lookup (see `scope`/`mode_scope`).
    pub fn get(&self, param: &str) -> Option<&Value> {
        if let Some(scope) = &self.scope {
            if !param.contains(':') {
                if let Some(mode) = &self.mode_scope {
                    if let Some(v) = self.params.get(&format!("{scope}:{param}@{mode}")) {
                        return Some(v);
                    }
                }
                if let Some(v) = self.params.get(&format!("{scope}:{param}")) {
                    return Some(v);
                }
            }
        }
        self.params.get(param)
    }

    /// Run `f` with the instance scope set (restored afterwards).
    pub fn scoped<T>(&mut self, instance: &str, f: impl FnOnce(&mut Env) -> T) -> T {
        let prev = self.scope.replace(instance.to_string());
        let out = f(self);
        self.scope = prev;
        out
    }

    /// Run `f` with instance scope AND RefMode context set (both restored).
    pub fn scoped_mode<T>(
        &mut self,
        instance: &str,
        mode: &str,
        f: impl FnOnce(&mut Env) -> T,
    ) -> T {
        let prev_scope = self.scope.replace(instance.to_string());
        let prev_mode = self.mode_scope.replace(mode.to_string());
        let out = f(self);
        self.scope = prev_scope;
        self.mode_scope = prev_mode;
        out
    }

    /// Device-identity flags CubeMX pre-seeds before any evaluation:
    /// family ("STM32F1"), line ("STM32F103"), die ("DIE410"), package,
    /// and one `<INSTANCE>_Exist` semaphore per IP instance on the part.
    pub fn seed_device(&mut self, part: &stm32ck_ir::model::Part) {
        self.raise(part.family.clone());
        self.raise(part.line.clone());
        self.raise(part.die.clone());
        self.raise(part.package.clone());
        for ip in &part.ip_instances {
            self.raise(format!("{}_Exist", ip.instance));
        }
    }
}
