//! Offline importer: CubeMX db XML -> IR packs.
//!
//! Each module parses one file kind; `pack` orchestrates a family import.
//! Parsers are *lenient* the way CubeMX's own engine is (the db is sloppy),
//! but every tolerated irregularity is reported through [`Lint`].

pub mod clock;
pub mod configs;
pub mod gpio;
pub mod ip_modes;
pub mod mcu;
pub mod memory;
pub mod pack;

use std::path::{Path, PathBuf};

/// Collected non-fatal irregularities found while importing.
#[derive(Debug, Default)]
pub struct Lint {
    pub warnings: Vec<String>,
}

impl Lint {
    pub fn warn(&mut self, file: &Path, msg: impl AsRef<str>) {
        self.warnings
            .push(format!("{}: {}", file.display(), msg.as_ref()));
    }
}

/// Parse a condition attribute, downgrading parse failures to lint warnings
/// (returns None). The db contains a handful of malformed expressions; we
/// must not hard-fail the whole import on them, but they must be visible.
pub fn parse_condition_lenient(
    src: &str,
    file: &Path,
    lint: &mut Lint,
) -> Option<stm32ck_ir::expr::Condition> {
    match stm32ck_ir::expr::parse_condition(src) {
        Ok(c) => Some(c),
        Err(e) => {
            lint.warn(file, format!("unparseable condition: {e}"));
            None
        }
    }
}

/// Read an XML file tolerating the db's mixed encodings: most files are
/// ASCII/UTF-8, a few genuinely contain ISO-8859-1 bytes (their declared
/// encoding). Latin-1 decodes losslessly byte->char.
pub fn read_text(path: &Path) -> anyhow::Result<String> {
    let bytes = std::fs::read(path)
        .map_err(|e| anyhow::anyhow!("reading {}: {e}", path.display()))?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => e.into_bytes().iter().map(|&b| b as char).collect(),
    })
}

/// Windows install layouts, relative to a drive root. Probed in declaration
/// order under every existing drive, so discovery is deterministic regardless
/// of where the tool was installed.
const WIN_DB_LAYOUTS: &[&str] = &[
    r"Program Files\STMicroelectronics\STM32Cube\STM32CubeMX\db",
    r"Program Files (x86)\STMicroelectronics\STM32Cube\STM32CubeMX\db",
    r"STMicroelectronics\STM32Cube\STM32CubeMX\db",
];

/// macOS / Linux layouts. Existence is *not* checked here.
const UNIX_DB_LAYOUTS: &[&str] = &[
    "/Applications/STMicroelectronics/STM32CubeMX.app/Contents/Resources/db",
    "/Applications/STM32CubeMX.app/Contents/Resources/db",
    "/usr/local/STMicroelectronics/STM32Cube/STM32CubeMX/db",
    "/opt/STMicroelectronics/STM32Cube/STM32CubeMX/db",
];

/// Every candidate CubeMX db path, in probe order: Windows AppData + Program
/// Files layouts, then Unix app-bundle / opt paths, then `$HOME/STM32CubeMX/db`.
/// Existence is *not* checked here.
pub fn db_candidates() -> Vec<PathBuf> {
    // Drive roots, ascending — a fixed order keeps discovery reproducible.
    let roots: Vec<PathBuf> = ('A'..='Z')
        .map(|c| PathBuf::from(format!("{c}:\\")))
        .filter(|p| p.is_dir())
        .collect();

    // The per-user tail, derived from LOCALAPPDATA with its drive stripped:
    // "C:\Users\admin\AppData\Local" -> "Users\admin\AppData\Local\Programs\STM32CubeMX\db".
    let user_tail = std::env::var("LOCALAPPDATA").ok().and_then(|lad| {
        let p = PathBuf::from(&lad);
        let rest = p.strip_prefix(p.components().next()?.as_os_str()).ok()?;
        Some(rest.join(r"Programs\STM32CubeMX\db"))
    });

    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(tail) = &user_tail {
        out.extend(roots.iter().map(|r| r.join(tail)));
    }
    for layout in WIN_DB_LAYOUTS {
        out.extend(roots.iter().map(|r| r.join(layout)));
    }
    out.extend(UNIX_DB_LAYOUTS.iter().map(PathBuf::from));
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        out.push(home.join("STM32CubeMX/db"));
        out.push(home.join("STM32Cube/STM32CubeMX/db"));
    }
    out
}

/// Locate the CubeMX db: `STM32CK_CUBEMX_DB` if set, else the first existing
/// [`db_candidates`] entry. `None` = no local CubeMX installation found.
pub fn discover_db() -> Option<PathBuf> {
    if let Ok(env) = std::env::var("STM32CK_CUBEMX_DB") {
        let p = PathBuf::from(env);
        return p.is_dir().then_some(p);
    }
    db_candidates().into_iter().find(|p| p.is_dir())
}

/// The db used by importer tests on a dev machine; tests skip when absent.
pub fn test_db() -> Option<PathBuf> {
    discover_db()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_include_unix_app_bundle() {
        let text: Vec<String> = db_candidates()
            .iter()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .collect();
        assert!(
            text.iter()
                .any(|s| s.contains("STM32CubeMX.app/Contents/Resources/db")),
            "unix CubeMX layouts missing from probe list: {text:?}"
        );
    }
}
