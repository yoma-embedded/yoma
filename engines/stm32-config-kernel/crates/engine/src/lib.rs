//! Deterministic semantics engine — a faithful Rust implementation of the
//! CubeMX data-model semantics (see docs/design.md §5):
//! semaphore blackboard + condition DSL evaluation + first-match-wins
//! parameter overloads + OR/XOR mode trees + fixed-point propagation.
//!
//! Determinism rules (workspace-wide law):
//! - ordered containers only (BTreeMap/BTreeSet or doc-order Vec)
//! - frequencies are integer Hz; exact rationals where division demands it
//! - no floating point in any decision path

pub mod clock;
pub mod clock_solve;
pub mod config;
pub mod diag;
pub mod dma;
pub mod env;
pub mod eval;
pub mod modes;
pub mod params;
pub mod pinout;
pub mod session;

pub use diag::{Diagnostic, Severity};
pub use env::{Env, Value};
