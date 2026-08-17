//! `stm32kernel` — the deterministic STM32 configuration kernel CLI
//! (design §10). Every command prints a single JSON document on stdout;
//! human-oriented progress logs go to stderr.
//!
//! Exit codes: 0 = OK, 1 = error diagnostics present, 2 = kernel/internal
//! error (I/O failure, corrupt pack, bad invocation).

mod cmds;
mod packs;
mod schema_doc;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "stm32kernel",
    version,
    about = "Deterministic STM32 configuration kernel: validate configs, \
             solve clocks, allocate pins, generate compilable HAL projects."
)]
pub struct Cli {
    /// Directory containing the *.irpack IR packs.
    #[arg(long, global = true, default_value = "data", env = "STM32CK_DATA")]
    pub data_dir: PathBuf,

    /// Pretty-print the JSON output.
    #[arg(long, global = true)]
    pub pretty: bool,

    #[command(subcommand)]
    pub cmd: Cmd,
}

#[derive(Subcommand)]
pub enum Cmd {
    /// List MCUs from all IR packs.
    ListMcus {
        /// Only parts of this family (e.g. "STM32F1").
        #[arg(long)]
        family: Option<String>,
        /// Only packages containing this text (e.g. "LQFP48").
        #[arg(long)]
        package: Option<String>,
        /// Only parts whose largest flash variant is at least this many KB.
        #[arg(long)]
        min_flash_kb: Option<u32>,
    },
    /// Describe one part: memory, pins/signals, IP instances, clock tree.
    DescribeMcu {
        /// Sales part number ("STM32F103C8Tx") or RefName group.
        part: String,
    },
    /// List candidate pads (with F1 remap-block info) for a peripheral's
    /// signals. With --config: the configured peripheral's demanded signals
    /// (mode-aware); a peripheral absent from the config falls back to all
    /// its pad signals from part data. With --part: no config needed.
    Candidates {
        /// Configuration document (JSON). Give this or --part.
        #[arg(long, required_unless_present = "part", conflicts_with = "part")]
        config: Option<PathBuf>,
        /// Query from part data without a config, e.g. "STM32F103C8Tx".
        #[arg(long)]
        part: Option<String>,
        /// Peripheral instance, e.g. "USART1".
        #[arg(long)]
        peripheral: String,
        /// Restrict to one short signal name, e.g. "TX".
        #[arg(long)]
        signal: Option<String>,
    },
    /// Solve the clock tree for the config's targets and report the
    /// resulting assignments, frequencies and derived values.
    SolveClock {
        /// Configuration document (JSON).
        #[arg(long)]
        config: PathBuf,
    },
    /// Run the full validation pipeline and report diagnostics + summary.
    Validate {
        /// Configuration document (JSON).
        #[arg(long)]
        config: PathBuf,
    },
    /// Validate, then generate the complete compilable project.
    /// Writes nothing when error diagnostics are present.
    Generate {
        /// Configuration document (JSON).
        #[arg(long)]
        config: PathBuf,
        /// Output project directory.
        #[arg(long)]
        out: PathBuf,
        /// Firmware components dir (<fw-dir>/<family>/{HAL_Driver,...}).
        #[arg(long, default_value = "data/fw")]
        fw_dir: PathBuf,
    },
    /// Print the configuration-document field reference (compact).
    Schema {
        /// Print the full JSON Schema instead of the compact reference.
        #[arg(long)]
        full: bool,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cmds::run(&cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("kernel error: {e:#}");
            println!("{}", serde_json::json!({ "error": format!("{e:#}") }));
            ExitCode::from(2)
        }
    }
}
