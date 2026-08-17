//! IR types shared by the importer (producer) and engine/codegen (consumers).
//!
//! The IR is a normalized, faithful projection of the CubeMX database:
//! it preserves CubeMX semantics (condition-ordered parameter overloads,
//! OR/XOR mode trees, semaphores, clock DAG) without interpreting them.
//! Interpretation lives in `stm32ck-engine`.

pub mod expr;
pub mod model;

/// Bumped whenever the IR layout changes incompatibly. Packs carry this and
/// consumers refuse mismatches.
pub const SCHEMA_VERSION: u32 = 4;
