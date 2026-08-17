//! Family import orchestration: walk the CubeMX db, parse every artifact a
//! family's parts reference, assemble an [`IrPack`], and emit it
//! (postcard + zstd, plus optional JSON debug dump).

use crate::{clock, configs, gpio, ip_modes, mcu, memory, Lint};
use anyhow::{bail, Context, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use stm32ck_ir::model::IrPack;

pub struct ImportReport {
    pub pack: IrPack,
    pub parts_imported: usize,
}

/// Import one family, named as [`canonical_family`] spells it ("STM32F1").
pub fn import_family(db: &Path, family: &str, lint: &mut Lint) -> Result<ImportReport> {
    let mcu_dir = db.join("mcu");
    let ip_dir = mcu_dir.join("IP");
    let clock_dir = db.join("plugins").join("clock");
    let config_dir = mcu_dir.join("config");

    let db_version = read_db_version(db).unwrap_or_else(|| "unknown".to_string());

    let mut pack = IrPack {
        schema_version: stm32ck_ir::SCHEMA_VERSION,
        family: family.to_string(),
        db_version,
        parts: BTreeMap::new(),
        gpio: BTreeMap::new(),
        ips: BTreeMap::new(),
        clock_trees: BTreeMap::new(),
        nvic_vectors: BTreeMap::new(),
        configs: BTreeMap::new(),
        memory_maps: BTreeMap::new(),
    };

    // ---- 1. parts --------------------------------------------------------
    let mut by_family = scan_families(&mcu_dir)?;
    let entries = by_family.remove(family).unwrap_or_default();
    if entries.is_empty() {
        bail!(
            "no MCU XML files for family {family} under {} (known: {})",
            mcu_dir.display(),
            by_family.keys().cloned().collect::<Vec<_>>().join(", ")
        );
    }

    for path in &entries {
        let xml = crate::read_text(path)?;
        match mcu::parse_part(&xml, path, lint) {
            Ok(part) => {
                pack.parts.insert(part.ref_name.clone(), part);
            }
            Err(e) => lint.warn(path, format!("part skipped: {e}")),
        }
    }

    // ---- 2. referenced artifacts ----------------------------------------
    let mut want_ips: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut want_gpio: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut want_clock: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut want_cfg: BTreeMap<String, PathBuf> = BTreeMap::new();

    for part in pack.parts.values() {
        want_clock
            .entry(part.clock_tree.clone())
            .or_insert_with(|| clock_dir.join(format!("{}.xml", part.clock_tree)));
        for ip in &part.ip_instances {
            let key = format!("{}-{}", ip.name, ip.version);
            if ip.name == "GPIO" {
                want_gpio
                    .entry(ip.version.clone())
                    .or_insert_with(|| ip_dir.join(format!("GPIO-{}_Modes.xml", ip.version)));
            } else {
                want_ips.entry(key).or_insert_with(|| {
                    ip_dir.join(format!("{}-{}_Modes.xml", ip.name, ip.version))
                });
            }
            if let Some(cf) = &ip.config_file {
                want_cfg
                    .entry(cf.clone())
                    .or_insert_with(|| config_dir.join(format!("{cf}_Configs.xml")));
            }
        }
    }

    // MCU files omit ConfigFile for most IPs; CubeMX derives the config
    // from the active RefMode's HalMode ("UART" -> UART-STM32F1xx). Take
    // every family-suffixed config file so codegen can resolve any HalMode.
    //
    // Sub-lines inside a family get their own file and must be taken too:
    // the H7RS parts sit in the H7 pack but carry `STM32H7RS_rcc_v1_0`, whose
    // codegen definition is `RCC-STM32H7RSxx_Configs.xml` — a different
    // HAL_RCC_OscConfig struct shape than the rest of H7. The IP version
    // prefix is the db's own key for that ("STM32WBA2", "STM32MP13", ...).
    let mut suffixes: BTreeSet<String> = BTreeSet::new();
    suffixes.insert(format!("-{family}xx_Configs.xml"));
    for part in pack.parts.values() {
        for ip in &part.ip_instances {
            if let Some(prefix) = ip.version.split('_').next() {
                if prefix.starts_with("STM32") {
                    suffixes.insert(format!("-{prefix}xx_Configs.xml"));
                }
            }
        }
    }
    if let Ok(rd) = fs::read_dir(&config_dir) {
        let mut cfg_files: Vec<PathBuf> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| suffixes.iter().any(|s| n.ends_with(s.as_str())))
            })
            .collect();
        cfg_files.sort();
        for path in cfg_files {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap()
                .trim_end_matches("_Configs.xml")
                .to_string();
            want_cfg.entry(name).or_insert(path);
        }
    }

    for (key, path) in &want_ips {
        if !path.is_file() {
            lint.warn(path, format!("referenced IP file missing ({key})"));
            continue;
        }
        let xml = crate::read_text(path)?;
        match ip_modes::parse_ip_def(&xml, path, lint) {
            Ok(def) => {
                if def.name == "NVIC" || key.starts_with("NVIC") {
                    let vectors = ip_modes::parse_nvic_vectors(&def, path, lint);
                    pack.nvic_vectors.insert(key.clone(), vectors);
                }
                pack.ips.insert(key.clone(), def);
            }
            Err(e) => lint.warn(path, format!("IP skipped: {e}")),
        }
    }

    for (version, path) in &want_gpio {
        if !path.is_file() {
            lint.warn(path, "referenced GPIO IP file missing");
            continue;
        }
        let xml = crate::read_text(path)?;
        match gpio::parse_gpio_ip(&xml, path, lint) {
            Ok(g) => {
                pack.gpio.insert(version.clone(), g);
            }
            Err(e) => lint.warn(path, format!("GPIO IP skipped: {e}")),
        }
    }

    for (id, path) in &want_clock {
        if !path.is_file() {
            lint.warn(path, "referenced clock tree file missing");
            continue;
        }
        let xml = crate::read_text(path)?;
        match clock::parse_clock_tree(&xml, path, lint) {
            Ok(t) => {
                pack.clock_trees.insert(id.clone(), t);
            }
            Err(e) => lint.warn(path, format!("clock tree skipped: {e}")),
        }
    }

    for (name, path) in &want_cfg {
        if !path.is_file() {
            // Plenty of ConfigFile refs have no file (middleware etc.).
            continue;
        }
        let xml = crate::read_text(path)?;
        match configs::parse_config_def(&xml, path, lint) {
            Ok(c) => {
                pack.configs.insert(name.clone(), c);
            }
            Err(e) => lint.warn(path, format!("config def skipped: {e}")),
        }
    }

    // ---- 3. address maps -------------------------------------------------
    // db/mcu/memory/STM32_<DIE>_<RAM>_<FLASH>.xml, keyed by die and declared
    // sizes, so a RefName group spanning two flash variants resolves to two
    // maps. Only newer families ship them (the MCU XML advertises this with
    // `<MemoryMap>Available`); F1/F4-era parts legitimately have none and
    // codegen falls back to a single-region layout.
    let memory_dir = mcu_dir.join("memory");
    for part in pack.parts.values_mut() {
        let Some(ram_kb) = part.ram_kb.first().copied() else {
            continue;
        };
        for flash_kb in part.flash_kb.clone() {
            let id = memory::map_id(&part.die, ram_kb, flash_kb);
            let path = memory_dir.join(format!("{id}.xml"));
            if !path.is_file() {
                continue;
            }
            if !pack.memory_maps.contains_key(&id) {
                let xml = crate::read_text(&path)?;
                match memory::parse_memory_map(&xml, &path, lint) {
                    Ok(regions) => {
                        pack.memory_maps.insert(id.clone(), regions);
                    }
                    Err(e) => {
                        lint.warn(&path, format!("memory map skipped: {e}"));
                        continue;
                    }
                }
            }
            part.memory_maps.insert(flash_kb, id);
        }
    }

    let parts_imported = pack.parts.len();
    Ok(ImportReport {
        pack,
        parts_imported,
    })
}

/// The pack name for a db `Family=` value.
///
/// One alias: the db spells the L4+ series as its own family, but ST ships a
/// single tree for both (`stm32l4xx_hal`, `cmsis_device_l4`,
/// `RCC-STM32L4xx_Configs.xml`), and `STM32L4+` is not a legal C macro,
/// directory or file stem either. `Part::family` keeps the db spelling — the
/// blackboard raises it as a semaphore and conditions test it.
pub fn canonical_family(raw: &str) -> &str {
    match raw {
        "STM32L4+" => "STM32L4",
        other => other,
    }
}

/// Family -> its MCU XML files, read from the `Family=` attribute on `<Mcu>`.
///
/// The file stem cannot carry this: STM32WB / WB0 / WBA and STM32WL / WL3 /
/// WL4 share a two-character series prefix but are different products with
/// different HAL trees (`stm32wbxx_hal` vs `stm32wb0x_hal` vs
/// `stm32wbaxx_hal`), as are MP1 and MP2. The attribute is the db's own
/// answer — `db/mcu/families.xml` groups by exactly these values.
pub fn scan_families(mcu_dir: &Path) -> Result<BTreeMap<String, Vec<PathBuf>>> {
    let mut out: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    let mut entries: Vec<PathBuf> = fs::read_dir(mcu_dir)
        .with_context(|| format!("reading {}", mcu_dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "xml"))
        .collect();
    entries.sort();
    for path in entries {
        // The root element is within the first few hundred bytes and its
        // attributes are alphabetical, so `Family` lands well inside the
        // window; reading whole MCU files (~5000 of them, up to 1 MB) just to
        // bucket them would dominate the import.
        let Some(head) = read_head(&path, 4096) else {
            continue;
        };
        let Some(raw) = attr_in(&head, "Family") else {
            continue; // families.xml, rules.xml, ... — not a part
        };
        out.entry(canonical_family(&raw).to_string())
            .or_default()
            .push(path);
    }
    Ok(out)
}

/// First `n` bytes of a file, latin-1 decoded (see [`crate::read_text`]).
fn read_head(path: &Path, n: usize) -> Option<String> {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    let mut f = fs::File::open(path).ok()?;
    let read = f.read(&mut buf).ok()?;
    buf.truncate(read);
    Some(match String::from_utf8(buf) {
        Ok(s) => s,
        Err(e) => e.into_bytes().iter().map(|&b| b as char).collect(),
    })
}

/// `name="value"` lookup in a raw XML prefix.
fn attr_in(head: &str, name: &str) -> Option<String> {
    let token = format!(" {name}=\"");
    let i = head.find(&token)? + token.len();
    let rest = &head[i..];
    let j = rest.find('"')?;
    Some(rest[..j].to_string())
}

fn read_db_version(db: &Path) -> Option<String> {
    // db/package.xml carries a version attribute; plain string scan keeps us
    // independent of its schema.
    let text = fs::read_to_string(db.join("package.xml")).ok()?;
    for token in ["Version=\"", "version=\""] {
        if let Some(i) = text.find(token) {
            let rest = &text[i + token.len()..];
            if let Some(j) = rest.find('"') {
                return Some(rest[..j].to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

pub fn write_pack(pack: &IrPack, out_dir: &Path, json_debug: bool) -> Result<PathBuf> {
    fs::create_dir_all(out_dir)?;
    let stem = pack.family.to_lowercase();
    let bin = postcard::to_allocvec(pack).context("postcard serialization")?;
    let compressed = zstd::encode_all(bin.as_slice(), 19).context("zstd")?;
    let path = out_dir.join(format!("{stem}.irpack"));
    fs::write(&path, &compressed)?;
    if json_debug {
        let json = serde_json::to_string_pretty(pack)?;
        fs::write(out_dir.join(format!("{stem}.debug.json")), json)?;
    }
    Ok(path)
}

pub fn read_pack(path: &Path) -> Result<IrPack> {
    let compressed = fs::read(path)?;
    let bin = zstd::decode_all(compressed.as_slice()).context("zstd decode")?;
    let pack: IrPack = postcard::from_bytes(&bin).context("postcard decode")?;
    if pack.schema_version != stm32ck_ir::SCHEMA_VERSION {
        bail!(
            "IR pack schema {} != kernel schema {}",
            pack.schema_version,
            stm32ck_ir::SCHEMA_VERSION
        );
    }
    Ok(pack)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_come_from_the_mcu_attribute() {
        let Some(db) = crate::test_db() else {
            eprintln!("skip: CubeMX db not present");
            return;
        };
        let by_family = scan_families(&db.join("mcu")).unwrap();
        // The three-way splits a stem prefix would collapse.
        for fam in ["STM32WB", "STM32WB0", "STM32WBA", "STM32WL", "STM32WL3"] {
            assert!(by_family.contains_key(fam), "{fam} missing");
        }
        assert!(
            !by_family["STM32WB"]
                .iter()
                .any(|p| p.file_stem().unwrap().to_str().unwrap().starts_with("STM32WBA")),
            "WBA parts leaked into the WB pack"
        );
        // L4+ is aliased onto L4, so it is not a family of its own.
        assert!(!by_family.contains_key("STM32L4+"));
        assert!(by_family["STM32L4"]
            .iter()
            .any(|p| p.file_stem().unwrap().to_str().unwrap().starts_with("STM32L4P5")));
        // Non-part XML in db/mcu carries no Family attribute.
        assert!(!by_family.contains_key(""));
    }

    #[test]
    fn canonical_family_aliases_l4_plus() {
        assert_eq!(canonical_family("STM32L4+"), "STM32L4");
        assert_eq!(canonical_family("STM32H7"), "STM32H7");
    }

    #[test]
    fn f1_import_round_trip() {
        let Some(db) = crate::test_db() else {
            eprintln!("skip: CubeMX db not present");
            return;
        };
        let mut lint = Lint::default();
        let report = import_family(&db, "STM32F1", &mut lint).unwrap();
        assert!(report.parts_imported > 50, "F1 has ~58 part groups");
        let pack = &report.pack;
        let f103 = &pack.parts["STM32F103C(8-B)Tx"];
        assert_eq!(f103.clock_tree, "STM32F102");
        assert!(pack.clock_trees.contains_key("STM32F102"));
        assert!(pack.ips.contains_key("USART-sci2_v1_1_Cube"));
        assert!(pack
            .nvic_vectors
            .keys()
            .any(|k| k.starts_with("NVIC-")));
        assert!(pack.configs.contains_key("UART-STM32F1xx"));
        let gpio_version = &f103
            .ip_instances
            .iter()
            .find(|i| i.name == "GPIO")
            .unwrap()
            .version;
        let g = &pack.gpio[gpio_version];
        assert!(g.pins.contains_key("PA9"));
        assert!(g.ports.contains_key("PA"), "GPIO_Port clock enables");

        // Round-trip through the binary pack format.
        let dir = std::env::temp_dir().join("stm32ck-pack-test");
        let path = write_pack(pack, &dir, false).unwrap();
        let back = read_pack(&path).unwrap();
        assert_eq!(back.parts.len(), pack.parts.len());
        assert_eq!(back.family, "STM32F1");
    }
}
