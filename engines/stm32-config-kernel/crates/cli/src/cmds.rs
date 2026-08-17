//! Command implementations. Every command produces one JSON value plus an
//! ok/error-diagnostics verdict; [`run`] prints the value on stdout and
//! maps the verdict to the process exit code (0 ok / 1 error diagnostics).
//! Anyhow errors bubble to `main` and become exit code 2 (kernel error).

use crate::packs;
use crate::{Cli, Cmd};
use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::ExitCode;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::{has_errors, Diagnostic};
use stm32ck_engine::session::{find_part, validate, Resolved};
use stm32ck_ir::expr::Num;
use stm32ck_ir::model::{AfBinding, GpioIp, GpioPin, IrPack, Part};

/// JSON payload + "no error diagnostics" verdict.
type Out = (Value, bool);

pub fn run(cli: &Cli) -> Result<ExitCode> {
    // The compact schema reference is text, not JSON: bypass
    // print_json/--pretty entirely.
    if let Cmd::Schema { full: false } = &cli.cmd {
        println!(
            "{}",
            crate::schema_doc::render(&serde_json::to_value(schemars::schema_for!(ConfigDoc))?)
        );
        return Ok(ExitCode::SUCCESS);
    }
    let (value, ok) = match &cli.cmd {
        Cmd::ListMcus {
            family,
            package,
            min_flash_kb,
        } => list_mcus(cli, family.as_deref(), package.as_deref(), *min_flash_kb)?,
        Cmd::DescribeMcu { part } => describe_mcu(cli, part)?,
        Cmd::Candidates {
            config,
            part,
            peripheral,
            signal,
        } => candidates(cli, config.as_deref(), part.as_deref(), peripheral, signal.as_deref())?,
        Cmd::SolveClock { config } => solve_clock(cli, config)?,
        Cmd::Validate { config } => cmd_validate(cli, config)?,
        Cmd::Generate {
            config,
            out,
            fw_dir,
        } => generate(cli, config, out, fw_dir)?,
        Cmd::Schema { full: true } => (serde_json::to_value(schemars::schema_for!(ConfigDoc))?, true),
        // `full: false` took the early return above; arm kept only for
        // match exhaustiveness.
        Cmd::Schema { full: false } => unreachable!("compact schema is handled before the match"),
    };
    print_json(&value, cli.pretty)?;
    Ok(if ok { ExitCode::SUCCESS } else { ExitCode::from(1) })
}

fn print_json(v: &Value, pretty: bool) -> Result<()> {
    let text = if pretty {
        serde_json::to_string_pretty(v)?
    } else {
        serde_json::to_string(v)?
    };
    println!("{text}");
    Ok(())
}

// ---------------------------------------------------------------------------
// list-mcus / describe-mcu
// ---------------------------------------------------------------------------

fn list_mcus(
    cli: &Cli,
    family: Option<&str>,
    package: Option<&str>,
    min_flash_kb: Option<u32>,
) -> Result<Out> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Row<'a> {
        ref_name: &'a str,
        part_numbers: &'a [String],
        family: &'a str,
        package: &'a str,
        flash_kb: &'a [u32],
        ram_kb: &'a [u32],
        max_freq_mhz: u32,
        io_count: u32,
    }

    let all = packs::load_all(&cli.data_dir)?;
    let mut rows: Vec<Row<'_>> = Vec::new();
    for pack in &all {
        for part in pack.parts.values() {
            if family.is_some_and(|f| !part.family.eq_ignore_ascii_case(f)) {
                continue;
            }
            if package.is_some_and(|p| {
                !part
                    .package
                    .to_ascii_lowercase()
                    .contains(&p.to_ascii_lowercase())
            }) {
                continue;
            }
            if min_flash_kb
                .is_some_and(|min| part.flash_kb.iter().copied().max().unwrap_or(0) < min)
            {
                continue;
            }
            rows.push(Row {
                ref_name: &part.ref_name,
                part_numbers: &part.part_numbers,
                family: &part.family,
                package: &part.package,
                flash_kb: &part.flash_kb,
                ram_kb: &part.ram_kb,
                max_freq_mhz: part.max_freq_mhz,
                io_count: part.io_count,
            });
        }
    }
    eprintln!("{} MCU(s) across {} pack(s)", rows.len(), all.len());
    Ok((json!({ "mcus": rows }), true))
}

fn describe_mcu(cli: &Cli, part_arg: &str) -> Result<Out> {
    let (pack, resolved) = match packs::for_part(&cli.data_dir, part_arg)? {
        packs::PartLookup::Found { pack, resolved } => (*pack, resolved),
        packs::PartLookup::NotFound { nearest } => {
            return Ok(diag_only(vec![unknown_part(part_arg, &cli.data_dir, &nearest)]))
        }
    };
    let part = find_part(&pack, &resolved).expect("for_part guarantees presence");

    let pins: Vec<Value> = part
        .pins
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "position": p.position,
                "kind": format!("{:?}", p.kind),
                "signals": p.signals.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            })
        })
        .collect();
    let ip_instances: Vec<Value> = part
        .ip_instances
        .iter()
        .map(|i| {
            json!({
                "instance": i.instance,
                "name": i.name,
                "version": i.version,
                "configFile": i.config_file,
            })
        })
        .collect();
    Ok((
        json!({
            "part": {
                "refName": part.ref_name,
                "partNumbers": part.part_numbers,
                "family": part.family,
                "line": part.line,
                "package": part.package,
                "core": part.core,
                "die": part.die,
                "maxFreqMhz": part.max_freq_mhz,
                "flashKb": part.flash_kb,
                "ramKb": part.ram_kb,
                "ioCount": part.io_count,
                "voltageMv": part.voltage_mv,
                "clockTree": part.clock_tree,
            },
            "pins": pins,
            "ipInstances": ip_instances,
        }),
        true,
    ))
}

// ---------------------------------------------------------------------------
// config-driven commands
// ---------------------------------------------------------------------------

/// Config + pack loading shared by candidates/solve-clock/validate/generate.
/// User-level failures surface as diagnostics, not kernel errors.
enum Loaded {
    Ready(Box<IrPack>, ConfigDoc),
    Failed(Vec<Diagnostic>),
}

fn load_ctx(cli: &Cli, config: &Path) -> Result<Loaded> {
    let mut doc = match load_doc(config) {
        Ok(doc) => doc,
        Err(d) => return Ok(Loaded::Failed(vec![d])),
    };
    match packs::for_part(&cli.data_dir, &doc.mcu.part)? {
        packs::PartLookup::Found { pack, resolved } => {
            // Downstream (session::validate) re-finds the part by doc name, so a
            // prefix-resolved query must be written back or it would miss again.
            doc.mcu.part = resolved;
            Ok(Loaded::Ready(pack, doc))
        }
        packs::PartLookup::NotFound { nearest } => Ok(Loaded::Failed(vec![unknown_part(
            &doc.mcu.part,
            &cli.data_dir,
            &nearest,
        )])),
    }
}

fn load_doc(path: &Path) -> std::result::Result<ConfigDoc, Diagnostic> {
    let text = std::fs::read_to_string(path).map_err(|e| {
        Diagnostic::error("DOC_READ", "/", format!("cannot read `{}`: {e}", path.display()))
    })?;
    serde_json::from_str(&text).map_err(|e| {
        Diagnostic::error(
            "DOC_PARSE",
            "/",
            format!("`{}` is not a valid config document: {e}", path.display()),
        )
    })
}

fn unknown_part(part: &str, data_dir: &Path, nearest: &[String]) -> Diagnostic {
    let d = Diagnostic::error(
        "MCU_UNKNOWN",
        "/mcu/part",
        format!("part `{part}` not found in any pack under `{}`", data_dir.display()),
    );
    if nearest.is_empty() {
        return d.with_suggestion("run `list-mcus --family <F>` for the catalogue");
    }
    // Schematics carry orderable part numbers; the packs carry CubeMX's
    // spelling. Naming the near miss is the whole difference between a
    // caller retrying correctly and one concluding the part is unsupported.
    d.with_suggestion(format!("did you mean {}?", nearest.join(", ")))
}

fn diag_only(diags: Vec<Diagnostic>) -> Out {
    let ok = !has_errors(&diags);
    (json!({ "diagnostics": diags }), ok)
}

fn candidates(
    cli: &Cli,
    config: Option<&Path>,
    part_arg: Option<&str>,
    peripheral: &str,
    signal: Option<&str>,
) -> Result<Out> {
    // --part: pure part-data query, no config document anywhere.
    if let Some(pq) = part_arg {
        let (pack, resolved) = match packs::for_part(&cli.data_dir, pq)? {
            packs::PartLookup::Found { pack, resolved } => (*pack, resolved),
            packs::PartLookup::NotFound { nearest } => {
                return Ok(diag_only(vec![unknown_part(pq, &cli.data_dir, &nearest)]))
            }
        };
        let part = find_part(&pack, &resolved).expect("for_part guarantees presence");
        return Ok(part_candidates(&pack, part, peripheral, signal, None));
    }

    let config = config.expect("clap: --config required when --part absent");
    let (pack, doc) = match load_ctx(cli, config)? {
        Loaded::Ready(pack, doc) => (pack, doc),
        Loaded::Failed(diags) => return Ok(diag_only(diags)),
    };
    // A peripheral the document does not configure is the pre-config
    // question this command exists for ("which pads can host ADC1_IN2") —
    // answer it from part data instead of erroring, and say how to get the
    // mode-aware version.
    if !doc.peripherals.contains_key(peripheral) {
        let part = find_part(&pack, &doc.mcu.part).expect("load_ctx resolved the part");
        let note = Diagnostic::info(
            "PERIPH_UNCONFIGURED",
            format!("/peripherals/{peripheral}"),
            format!(
                "`{peripheral}` is not configured in this document; listing every pad \
                 signal of the instance from part data (mode-agnostic)"
            ),
        )
        .with_suggestion(format!(
            "for mode-aware candidates (demanded signals, IOMode) add \"{peripheral}\": \
             {{\"mode\": \"<Mode>\"}} under /peripherals — `schema` documents the entry, \
             MODE_UNKNOWN suggestions list the mode names"
        ));
        return Ok(part_candidates(&pack, part, peripheral, signal, Some(note)));
    }
    let resolved = match validate(&pack, &doc) {
        Ok(r) => r,
        Err(diags) => return Ok(diag_only(diags)),
    };
    let Some(p) = resolved.periphs.iter().find(|p| p.instance == peripheral) else {
        // Configured but rejected: session already diagnosed WHY (a
        // PERIPH_UNKNOWN "does not exist on {part}" or similar) — surface
        // that instead of a misleading "not configured".
        return Ok(diag_only(resolved.diags));
    };
    let wanted: Vec<_> = p
        .signals
        .iter()
        .filter(|s| signal.is_none_or(|w| s.short == w))
        .collect();
    if let Some(w) = signal {
        if wanted.is_empty() {
            return Ok(diag_only(vec![Diagnostic::error(
                "SIGNAL_UNKNOWN",
                format!("/peripherals/{peripheral}/pins/{w}"),
                format!("signal `{w}` is not demanded by the selected mode(s) of {peripheral}"),
            )]));
        }
    }

    let gpio_def = pack.gpio.get(&resolved.gpio_version);
    let mut signals: Vec<Value> = Vec::new();
    for s in wanted {
        let full = format!("{}_{}", p.instance, s.short);
        signals.push(json!({
            "signal": full,
            "short": s.short,
            "ioMode": s.io_mode,
            "candidates": pad_candidates(resolved.part, gpio_def, &full),
        }));
    }
    // candidates is a query: diagnostics are informational, never exit 1.
    Ok((
        json!({
            "peripheral": p.instance,
            "activeModes": p.active_modes,
            "signals": signals,
            "diagnostics": resolved.diags,
        }),
        true,
    ))
}

/// Candidate pads of one full signal name, from part data + the GPIO def
/// (AF macro / F1 remap blocks). Shared verbatim by the config-driven and
/// part-only paths so their JSON stays field-identical.
fn pad_candidates(part: &Part, gpio_def: Option<&GpioIp>, full: &str) -> Vec<Value> {
    let mut cands: Vec<Value> = Vec::new();
    for pin in &part.pins {
        if !pin.signals.iter().any(|ps| ps.name == full) {
            continue;
        }
        let mut af: Option<&str> = None;
        let mut remap_blocks: Vec<Value> = Vec::new();
        if let Some(binding) = gpio_def
            .and_then(|g| lookup_gpio_pin(g, &pin.name))
            .and_then(|gp| gp.signals.iter().find(|x| x.signal == full))
            .map(|x| &x.binding)
        {
            match binding {
                AfBinding::Af { macro_name } => af = Some(macro_name),
                AfBinding::Remap { blocks } => {
                    for b in blocks {
                        remap_blocks.push(json!({
                            "block": b.block,
                            "defaultRemap": b.default_remap,
                            "afMacro": b.af_macro,
                        }));
                    }
                }
                AfBinding::None => {}
            }
        }
        cands.push(json!({
            "pin": pin.name,
            "position": pin.position,
            "af": af,
            "remapBlocks": remap_blocks,
        }));
    }
    cands
}

/// Config-free candidates: every pad signal of `peripheral` on `part` (or
/// just `signal`), mode-agnostic — no ioMode, no activeModes, no occupancy
/// view. `note` carries the PERIPH_UNCONFIGURED pointer when the caller got
/// here through a config that lacks the peripheral.
fn part_candidates(
    pack: &IrPack,
    part: &Part,
    peripheral: &str,
    signal: Option<&str>,
    note: Option<Diagnostic>,
) -> Out {
    if !part.ip_instances.iter().any(|i| i.instance == peripheral) {
        return diag_only(vec![Diagnostic::error(
            "PERIPH_UNKNOWN",
            format!("/peripherals/{peripheral}"),
            format!("`{peripheral}` does not exist on {}", part.ref_name),
        )
        .with_suggestion(format!(
            "run `describe-mcu {}` for the instance list",
            part.ref_name
        ))]);
    }
    let gpio_version = part
        .ip_instances
        .iter()
        .find(|i| i.name == "GPIO")
        .map(|i| i.version.clone())
        .unwrap_or_default();
    let gpio_def = pack.gpio.get(&gpio_version);

    let prefix = format!("{peripheral}_");
    let mut shorts: Vec<&str> = part
        .pins
        .iter()
        .flat_map(|p| &p.signals)
        .filter_map(|s| s.name.strip_prefix(&prefix))
        .collect();
    shorts.sort_unstable();
    shorts.dedup();
    if let Some(w) = signal {
        if !shorts.contains(&w) {
            return diag_only(vec![Diagnostic::error(
                "SIGNAL_UNKNOWN",
                format!("/peripherals/{peripheral}/pins/{w}"),
                format!("no pad of {} carries `{peripheral}_{w}`", part.ref_name),
            )
            .with_suggestion(format!(
                "pad signals of {peripheral}: {}",
                shorts.join(", ")
            ))]);
        }
        shorts.retain(|s| *s == w);
    }

    let mut signals: Vec<Value> = Vec::new();
    for short in shorts {
        let full = format!("{peripheral}_{short}");
        signals.push(json!({
            "signal": full,
            "short": short,
            "ioMode": Value::Null,
            "candidates": pad_candidates(part, gpio_def, &full),
        }));
    }
    (
        json!({
            "peripheral": peripheral,
            "activeModes": [],
            "signals": signals,
            "diagnostics": note.into_iter().collect::<Vec<_>>(),
        }),
        true,
    )
}

/// GPIO-def pins may carry name suffixes ("PC13-TAMPER-RTC"); match the
/// part pad exactly first, then by the bare `-`-stripped name.
fn lookup_gpio_pin<'a>(g: &'a GpioIp, pad: &str) -> Option<&'a GpioPin> {
    if let Some(p) = g.pins.get(pad) {
        return Some(p);
    }
    let bare = pad.split('-').next().unwrap_or(pad);
    g.pins
        .iter()
        .find(|(k, _)| k.split('-').next().unwrap_or(k) == bare)
        .map(|(_, v)| v)
}

fn solve_clock(cli: &Cli, config: &Path) -> Result<Out> {
    let (pack, doc) = match load_ctx(cli, config)? {
        Loaded::Ready(pack, doc) => (pack, doc),
        Loaded::Failed(diags) => return Ok(diag_only(diags)),
    };
    let resolved = match validate(&pack, &doc) {
        Ok(r) => r,
        Err(diags) => return Ok(diag_only(diags)),
    };
    let freqs: BTreeMap<&str, Value> = resolved
        .clock
        .freqs
        .iter()
        .map(|(id, hz)| (id.as_str(), num_json(*hz)))
        .collect();
    let ok = !has_errors(&resolved.diags);
    Ok((
        json!({
            "assignments": resolved.clock.assignments,
            "freqs": freqs,
            "derived": resolved.clock.derived,
            "diagnostics": resolved.diags,
        }),
        ok,
    ))
}

fn cmd_validate(cli: &Cli, config: &Path) -> Result<Out> {
    let (pack, doc) = match load_ctx(cli, config)? {
        Loaded::Ready(pack, doc) => (pack, doc),
        Loaded::Failed(diags) => return Ok(diag_only(diags)),
    };
    let resolved = match validate(&pack, &doc) {
        Ok(r) => r,
        Err(diags) => return Ok(diag_only(diags)),
    };
    let placements: BTreeMap<&str, &str> = resolved
        .pin_plan
        .placements
        .iter()
        .map(|p| (p.signal.as_str(), p.pin.as_str()))
        .collect();
    let ok = !has_errors(&resolved.diags);
    Ok((
        json!({
            "diagnostics": resolved.diags,
            "summary": {
                "part": resolved.part.ref_name,
                "sysclkHz": sysclk_hz(&resolved),
                "placements": placements,
            },
        }),
        ok,
    ))
}

fn generate(cli: &Cli, config: &Path, out: &Path, fw_dir: &Path) -> Result<Out> {
    let (pack, doc) = match load_ctx(cli, config)? {
        Loaded::Ready(pack, doc) => (pack, doc),
        Loaded::Failed(diags) => return Ok(diag_only(diags)),
    };
    let resolved = match validate(&pack, &doc) {
        Ok(r) => r,
        Err(diags) => return Ok(diag_only(diags)),
    };
    if has_errors(&resolved.diags) {
        eprintln!("configuration has error diagnostics; nothing written");
        return Ok(diag_only(resolved.diags));
    }
    let manifest = stm32ck_codegen::generate_project(
        &pack,
        &resolved,
        &doc,
        fw_dir,
        out,
        env!("CARGO_PKG_VERSION"),
    )?;
    eprintln!("generated {} file(s) under {}", manifest.files.len(), out.display());
    let mut diags = resolved.diags;
    diags.extend(manifest.diags.iter().cloned());
    let ok = !has_errors(&diags);
    Ok((json!({ "files": manifest.files, "diagnostics": diags }), ok))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Exact rational -> JSON: integers as numbers, non-integers as the exact
/// "num/den" string (never floats — workspace law).
fn num_json(n: Num) -> Value {
    if n.is_integer() {
        json!(*n.numer())
    } else {
        json!(format!("{n}"))
    }
}

/// First propagated frequency whose element id contains "SYSCLK"
/// (BTreeMap order — deterministic), when it is a whole positive Hz count.
fn sysclk_hz(resolved: &Resolved<'_>) -> Option<u64> {
    resolved
        .clock
        .freqs
        .iter()
        .find(|(id, _)| id.to_uppercase().contains("SYSCLK"))
        .and_then(|(_, hz)| {
            if hz.is_integer() {
                u64::try_from(*hz.numer()).ok()
            } else {
                None
            }
        })
}
