//! Memory-map parser: `db/mcu/memory/STM32_<DIE>_<RAM>_<FLASH>.xml` ->
//! [`MemoryRegion`] list.
//!
//! The files are CMSIS-Zone (`<rzone>`) resource descriptions. Only the
//! `<memories>/<memory>` entries carry address-map facts we need; everything
//! else describes TrustZone plumbing or off-chip apertures:
//!
//!   - `<sau_init>`, `<mpc>`, `<mpcwm>`: TrustZone controller block tables —
//!     they restate SRAM/flash bank boundaries as *security* granules, not as
//!     linkable memories;
//!   - `<provisioning>`: external memory windows (FMC/QSPI/OctoSPI) that
//!     exist only once a board wires something to them;
//!   - any `<memory physical=...>`: a second *view* of memory declared
//!     elsewhere — the secure alias (`Flash_S` at 0x0C000000) or the code
//!     alias (`RAM_C_NS` at 0x0A000000) of the same physical bank. Emitting
//!     both would double-count the device's RAM.
//!
//! Contiguous same-kind regions are merged, which is how CubeMX presents
//! them: H5's SRAM1+SRAM2+SRAM3 become one 640K SRAM, H7's AHB SRAM1/2/3
//! become the single 288K bank its linker scripts call `RAM_D2`.

use crate::Lint;
use std::path::Path;
use stm32ck_ir::model::{MemoryKind, MemoryRegion};

/// Parse one rzone file. Returns the merged, start-sorted region list.
pub fn parse_memory_map(
    xml: &str,
    path: &Path,
    lint: &mut Lint,
) -> anyhow::Result<Vec<MemoryRegion>> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|e| anyhow::anyhow!("parsing {}: {e}", path.display()))?;
    let root = doc.root_element();
    if root.tag_name().name() != "rzone" {
        anyhow::bail!(
            "{}: root element is <{}>, expected <rzone>",
            path.display(),
            root.tag_name().name()
        );
    }

    let mut regions: Vec<MemoryRegion> = Vec::new();
    for mem in root
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "memory")
    {
        // Alias view of a bank declared elsewhere — see module docs.
        if mem.attribute("physical").is_some() {
            continue;
        }
        let kind = match mem.attribute("type") {
            Some("RAM") => MemoryKind::Ram,
            Some("ROM") => MemoryKind::Rom,
            other => {
                lint.warn(
                    path,
                    format!("<memory type={other:?}> is neither RAM nor ROM; skipped"),
                );
                continue;
            }
        };
        let (Some(start), Some(size)) = (
            mem.attribute("start").and_then(parse_u64),
            mem.attribute("size").and_then(parse_u64),
        ) else {
            lint.warn(
                path,
                format!(
                    "<memory name={:?}> has unparsable start/size; skipped",
                    mem.attribute("name").unwrap_or("?")
                ),
            );
            continue;
        };
        if size == 0 {
            continue;
        }
        let name = linker_name(
            mem.attribute("name")
                .or_else(|| mem.attribute("info"))
                .unwrap_or("MEM"),
        );
        regions.push(MemoryRegion {
            name,
            start,
            size_bytes: size,
            kind,
        });
    }

    if regions.is_empty() {
        anyhow::bail!("{}: no usable <memory> entries", path.display());
    }
    Ok(merge_contiguous(regions))
}

/// `0x08000000` / `134217728` -> 134217728.
fn parse_u64(text: &str) -> Option<u64> {
    let t = text.trim();
    match t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        Some(hex) => u64::from_str_radix(hex, 16).ok(),
        None => t.parse::<u64>().ok(),
    }
}

/// Make a db name usable as a GNU ld region name: keep alphanumerics and
/// `_`, collapse everything else to `_`, and never start with a digit.
fn linker_name(raw: &str) -> String {
    let mut out = String::new();
    let mut last_us = false;
    for c in raw.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_uppercase());
            last_us = false;
        } else if !last_us {
            out.push('_');
            last_us = true;
        }
    }
    let out = out.trim_matches('_').to_string();
    match out.chars().next() {
        None => "MEM".to_string(),
        Some(c) if c.is_ascii_digit() => format!("M_{out}"),
        _ => out,
    }
}

/// Sort by (start, size) and fuse runs where one region ends exactly where
/// the next begins and both are the same kind. The merged region keeps the
/// first constituent's name — the db lists banks low-address first, so that
/// is the bank the datasheet names the aperture after.
fn merge_contiguous(mut regions: Vec<MemoryRegion>) -> Vec<MemoryRegion> {
    regions.sort_by_key(|r| (r.start, r.size_bytes));
    let mut out: Vec<MemoryRegion> = Vec::new();
    for r in regions {
        match out.last_mut() {
            Some(prev)
                if prev.kind == r.kind && prev.start + prev.size_bytes == r.start =>
            {
                prev.size_bytes += r.size_bytes;
            }
            // Exact duplicate (the db occasionally lists a bank twice).
            Some(prev) if *prev == r => {}
            _ => out.push(r),
        }
    }
    out
}

/// The db's memory-map file stem for a part: die + declared RAM/flash sizes
/// in KB, e.g. `("DIE450", 864, 2048) -> "STM32_DIE450_864_2048"`.
pub fn map_id(die: &str, ram_kb: u32, flash_kb: u32) -> String {
    format!("STM32_{die}_{ram_kb}_{flash_kb}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(name: &str) -> Option<(Vec<MemoryRegion>, Lint)> {
        let db = crate::test_db()?;
        let path = db.join("mcu").join("memory").join(name);
        if !path.is_file() {
            eprintln!("skip: {} not present", path.display());
            return None;
        }
        let xml = crate::read_text(&path).unwrap();
        let mut lint = Lint::default();
        let regions = parse_memory_map(&xml, &path, &mut lint).unwrap();
        Some((regions, lint))
    }

    fn find(regions: &[MemoryRegion], start: u64) -> Option<&MemoryRegion> {
        regions.iter().find(|r| r.start == start)
    }

    /// H743: DTCM stays separate at 0x20000000, the AXI SRAM is the big
    /// bank at 0x24000000, and the three AHB SRAMs fuse into 288K.
    #[test]
    fn h743_map_merges_ahb_srams() {
        let Some((regions, _)) = parse("STM32_DIE450_864_2048.xml") else {
            return;
        };
        let flash = find(&regions, 0x0800_0000).expect("user flash");
        assert_eq!(flash.kind, MemoryKind::Rom);
        assert_eq!(flash.size_bytes, 2048 * 1024, "two 1M banks are contiguous");

        assert_eq!(find(&regions, 0x2000_0000).unwrap().size_bytes, 128 * 1024);
        assert_eq!(find(&regions, 0x2400_0000).unwrap().size_bytes, 512 * 1024);
        assert_eq!(
            find(&regions, 0x3000_0000).unwrap().size_bytes,
            288 * 1024,
            "AHB SRAM1+2+3"
        );
        assert_eq!(find(&regions, 0x3800_0000).unwrap().size_bytes, 64 * 1024);
        // The system-memory ROM at 0x1FF00000 is a real region, not dropped.
        assert!(find(&regions, 0x1ff0_0000).is_some());
    }

    /// H563 is a TrustZone part: only the non-secure views survive, so its
    /// 640K SRAM is counted once.
    #[test]
    fn h563_map_drops_secure_aliases() {
        let Some((regions, _)) = parse("STM32_DIE484_640_2048.xml") else {
            return;
        };
        assert_eq!(
            find(&regions, 0x2000_0000).unwrap().size_bytes,
            640 * 1024,
            "SRAM1+2+3 merged"
        );
        assert_eq!(find(&regions, 0x0800_0000).unwrap().size_bytes, 2048 * 1024);
        // Secure / code aliases of the same banks must not be emitted.
        for aliased in [0x0c00_0000, 0x0a00_0000, 0x3000_0000, 0x5003_6400] {
            assert!(
                find(&regions, aliased).is_none(),
                "alias at {aliased:#x} leaked into the map"
            );
        }
        let ram: u64 = regions
            .iter()
            .filter(|r| r.kind == MemoryKind::Ram && r.start >= 0x2000_0000)
            .map(|r| r.size_bytes)
            .sum();
        assert_eq!(ram, 640 * 1024 + 4096, "SRAM + backup SRAM, counted once");
    }

    #[test]
    fn linker_names_are_safe() {
        assert_eq!(linker_name("RAM_AXI"), "RAM_AXI");
        assert_eq!(linker_name("AHB SRAM1"), "AHB_SRAM1");
        assert_eq!(linker_name("Flash memory Bank1"), "FLASH_MEMORY_BANK1");
        assert_eq!(linker_name("2ndRAM"), "M_2NDRAM");
        assert_eq!(linker_name(""), "MEM");
    }

    #[test]
    fn map_id_matches_db_naming() {
        assert_eq!(map_id("DIE450", 864, 2048), "STM32_DIE450_864_2048");
    }
}
