//! Diagnostic type — the kernel's only way of saying "no".
//!
//! Every rejection must state *what* rule fired, *where* in the user's
//! config document it applies, and — when the data allows — *how* to fix it.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: Severity,
    /// Stable machine code, e.g. "CLK_RANGE", "PIN_CONFLICT", "PARAM_VALUE".
    pub code: String,
    /// JSON Pointer into the config document, e.g. "/peripherals/USART1/params/BaudRate".
    pub path: String,
    pub message: String,
    /// Related locations (the other side of a conflict).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

impl Diagnostic {
    pub fn error(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Error,
            code: code.to_string(),
            path: path.into(),
            message: message.into(),
            related: Vec::new(),
            suggestion: None,
        }
    }

    pub fn warning(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Warning,
            ..Self::error(code, path, message)
        }
    }

    pub fn info(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Info,
            ..Self::error(code, path, message)
        }
    }

    pub fn with_suggestion(mut self, s: impl Into<String>) -> Self {
        self.suggestion = Some(s.into());
        self
    }

    pub fn with_related(mut self, r: impl Into<String>) -> Self {
        self.related.push(r.into());
        self
    }
}

/// True if any diagnostic is an error (validate/generate fail condition).
pub fn has_errors(diags: &[Diagnostic]) -> bool {
    diags.iter().any(|d| d.severity == Severity::Error)
}
