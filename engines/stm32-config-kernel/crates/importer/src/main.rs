//! stm32ck-import — local CubeMX discovery and offline db -> IR pack compiler.

use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;
use stm32ck_importer::{pack, Lint};

#[derive(Parser)]
#[command(about = "Locate local CubeMX and compile its database into local IR packs (not distributed)")]
struct Args {
    /// CubeMX installation, app bundle or db directory (containing mcu/).
    /// Defaults to the local CubeMX installation (see also
    /// `STM32CK_CUBEMX_DB`).
    #[arg(long)]
    cubemx_db: Option<PathBuf>,

    /// Locate the local database and print JSON metadata without generating files.
    #[arg(long, conflicts_with_all = ["all", "smoke", "families"])]
    probe: bool,

    /// Comma-separated families to import (e.g. STM32F1,STM32F4).
    #[arg(long, value_delimiter = ',')]
    families: Vec<String>,

    /// Output directory for .irpack files.
    #[arg(long, default_value = "data")]
    out: PathBuf,

    /// Also write <family>.debug.json next to each pack.
    #[arg(long)]
    json: bool,

    /// Print every lint warning (default: summary + first 30).
    #[arg(long)]
    verbose_lint: bool,

    /// Keep family progress and errors, omit detailed lint warnings.
    #[arg(long, conflicts_with = "verbose_lint")]
    quiet_lint: bool,

    /// Import every family the db exposes.
    #[arg(long)]
    all: bool,

    /// Smoke mode: parse EVERY family in the db, emit nothing.
    #[arg(long)]
    smoke: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();

    let cubemx_db = stm32ck_importer::resolve_db(args.cubemx_db.as_deref())?;

    let discovered = || -> Result<Vec<String>> {
        Ok(pack::scan_families(&cubemx_db.join("mcu"))?
            .into_keys()
            .collect())
    };
    if args.probe {
        let families = discovered()?;
        anyhow::ensure!(
            !families.is_empty(),
            "CubeMX database contains no MCU families: {}",
            cubemx_db.display()
        );
        println!(
            "{}",
            serde_json::json!({
                "dbPath": cubemx_db,
                "dbVersion": pack::read_db_version(&cubemx_db).unwrap_or_else(|| "unknown".into()),
                "families": families,
            })
        );
        return Ok(());
    }
    eprintln!("CubeMX db: {}", cubemx_db.display());
    let families: Vec<String> = if args.all || args.smoke {
        discovered()?
    } else if args.families.is_empty() {
        anyhow::bail!("--families required (or --all / --smoke)");
    } else {
        // Accept the db's own spelling for aliased families ("STM32L4+").
        args.families
            .iter()
            .map(|f| pack::canonical_family(f).to_string())
            .collect()
    };

    let mut total_warn = 0usize;
    for family in &families {
        let mut lint = Lint::default();
        let report = pack::import_family(&cubemx_db, family, &mut lint)?;
        let n_warn = lint.warnings.len();
        total_warn += n_warn;
        eprintln!(
            "{family}: {} parts, {} IP defs, {} clock trees, {} gpio defs, {} config defs, {} NVIC tables, {} memory maps, {n_warn} lint warnings",
            report.parts_imported,
            report.pack.ips.len(),
            report.pack.clock_trees.len(),
            report.pack.gpio.len(),
            report.pack.configs.len(),
            report.pack.nvic_vectors.len(),
            report.pack.memory_maps.len(),
        );
        let show = if args.quiet_lint {
            0
        } else if args.verbose_lint {
            n_warn
        } else {
            30.min(n_warn)
        };
        for w in lint.warnings.iter().take(show) {
            eprintln!("  lint: {w}");
        }
        if !args.quiet_lint && show < n_warn {
            eprintln!("  ... {} more (use --verbose-lint)", n_warn - show);
        }
        if !args.smoke {
            let path = pack::write_pack(&report.pack, &args.out, args.json)?;
            if !args.quiet_lint {
                let size = std::fs::metadata(&path)?.len();
                eprintln!("  wrote {} ({} KiB)", path.display(), size / 1024);
            }
        }
    }
    eprintln!(
        "done: {} families, {total_warn} total lint warnings",
        families.len()
    );
    Ok(())
}
