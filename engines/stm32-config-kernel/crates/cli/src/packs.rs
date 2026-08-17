//! IR pack discovery and lazy loading. Packs are per-family
//! (`stm32f1.irpack`), postcard + zstd, produced by the importer.

use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use stm32ck_engine::session::{find_part, rank_near};
use stm32ck_ir::model::IrPack;

/// All `*.irpack` files under `data_dir`, sorted by path (deterministic).
pub fn pack_paths(data_dir: &Path) -> Result<Vec<PathBuf>> {
    let entries = fs::read_dir(data_dir)
        .with_context(|| format!("cannot read data dir `{}`", data_dir.display()))?;
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.is_file() && path.extension().is_some_and(|x| x == "irpack") {
            out.push(path);
        }
    }
    out.sort();
    if out.is_empty() {
        bail!("no *.irpack files found in `{}`", data_dir.display());
    }
    Ok(out)
}

/// Load one pack (zstd-compressed postcard). Silent: a lookup may sweep all
/// 27 packs, and 27 "loaded pack" lines drown the actual answer (they used to
/// leak verbatim into agent tool output). Callers announce what matters.
pub fn load(path: &Path) -> Result<IrPack> {
    let compressed =
        fs::read(path).with_context(|| format!("cannot read pack `{}`", path.display()))?;
    let bin = zstd::decode_all(compressed.as_slice())
        .with_context(|| format!("pack `{}` is not valid zstd", path.display()))?;
    let pack: IrPack = postcard::from_bytes(&bin)
        .with_context(|| format!("pack `{}` failed to deserialize", path.display()))?;
    Ok(pack)
}

fn announce(pack: &IrPack, path: &Path) {
    eprintln!(
        "loaded pack {} ({} parts) from {}",
        pack.family,
        pack.parts.len(),
        path.display()
    );
}

/// Load every pack in `data_dir` (path-sorted).
pub fn load_all(data_dir: &Path) -> Result<Vec<IrPack>> {
    let packs: Vec<IrPack> = pack_paths(data_dir)?.iter().map(|p| load(p)).collect::<Result<_>>()?;
    let parts: usize = packs.iter().map(|p| p.parts.len()).sum();
    eprintln!("loaded {} packs ({parts} parts) from {}", packs.len(), data_dir.display());
    Ok(packs)
}

/// Outcome of a part lookup. `resolved` is the canonical name that matched —
/// it differs from the query when a unique prefix completion resolved it
/// (`STM32F103C8` → `STM32F103C8Tx`). The miss carries the closest spellings:
/// ambiguous prefix completions first, then shared-prefix near-misses — a
/// lookup that fails has already loaded every pack, so ranking costs nothing.
pub enum PartLookup {
    Found { pack: Box<IrPack>, resolved: String },
    NotFound { nearest: Vec<String> },
}

/// Find the pack containing `part`, loading lazily: packs whose file stem
/// prefixes the part name (case-insensitive) are tried first, the rest as
/// fallback. A query that is a prefix of exactly one catalogue part resolves
/// to it — schematics often carry `STM32F103C8` where the db distinguishes
/// packages (`STM32F103C8Tx`); bouncing an unambiguous abbreviation back to
/// the caller helps nobody. Two or more completions stay an error.
pub fn for_part(data_dir: &Path, part: &str) -> Result<PartLookup> {
    let lower = part.to_ascii_lowercase();
    let (preferred, rest): (Vec<PathBuf>, Vec<PathBuf>) =
        pack_paths(data_dir)?.into_iter().partition(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| lower.starts_with(&s.to_ascii_lowercase()))
        });
    let mut seen: Vec<String> = Vec::new();
    // one entry per catalogue part (ref_name) that the query is a proper prefix of
    let mut completions: Vec<(PathBuf, String)> = Vec::new();
    for path in preferred.into_iter().chain(rest) {
        let pack = load(&path)?;
        if find_part(&pack, part).is_some() {
            announce(&pack, &path);
            return Ok(PartLookup::Found { pack: Box::new(pack), resolved: part.to_string() });
        }
        for p in pack.parts.values() {
            let prefixed = std::iter::once(&p.ref_name)
                .chain(p.part_numbers.iter())
                .any(|n| n.to_ascii_lowercase().starts_with(&lower));
            if prefixed {
                completions.push((path.clone(), p.ref_name.clone()));
            }
            seen.extend(p.part_numbers.iter().cloned());
        }
    }
    completions.sort_by(|a, b| a.1.cmp(&b.1));
    completions.dedup_by(|a, b| a.1 == b.1);
    if let [(path, name)] = completions.as_slice() {
        let pack = load(path)?;
        eprintln!("resolved part `{part}` to `{name}`");
        announce(&pack, path);
        return Ok(PartLookup::Found { pack: Box::new(pack), resolved: name.clone() });
    }
    let mut nearest: Vec<String> = completions.into_iter().map(|(_, n)| n).take(5).collect();
    for n in rank_near(seen.iter().map(String::as_str), part) {
        if nearest.len() >= 5 {
            break;
        }
        if !nearest.contains(&n) {
            nearest.push(n);
        }
    }
    Ok(PartLookup::NotFound { nearest })
}
