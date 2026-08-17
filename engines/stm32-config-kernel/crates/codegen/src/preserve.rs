//! USER CODE section preservation across regeneration.
//!
//! Generated C files carry CubeMX-style anchors
//! (`/* USER CODE BEGIN <tag> */` .. `/* USER CODE END <tag> */`). When a
//! project is regenerated into a directory that already contains a previous
//! generation, the inner text of every section the user may have edited is
//! spliced back into the fresh content so user code survives regeneration.
//!
//! Determinism law: BTreeMap only, no timestamps, no floats. The merge is a
//! pure string -> string function; identical inputs produce identical output,
//! and merging an untouched generated file over itself is byte-identical.

use std::collections::{BTreeMap, BTreeSet};
use stm32ck_engine::diag::Diagnostic;

/// Diagnostic code: a section with non-empty user content exists in the
/// previous generation but the new generation no longer emits that anchor.
/// The content is appended at the end of the file in an ORPHANED block.
pub const REGEN_ORPHAN: &str = "REGEN_ORPHAN";

/// Diagnostic code: the existing file has a `USER CODE BEGIN` anchor with no
/// matching `END` (or is otherwise unreadable). The file is unmergeable: the
/// new content wins and the caller must back up the existing file.
pub const REGEN_MALFORMED: &str = "REGEN_MALFORMED";

/// Diagnostic code: a `Core/Src` or `Core/Inc` file from an earlier run that
/// this configuration no longer produces. Reported, never deleted — it may
/// hold user code.
pub const REGEN_STALE: &str = "REGEN_STALE";

const BEGIN: &str = "/* USER CODE BEGIN ";
const END: &str = "/* USER CODE END ";
const ORPHAN_BEGIN: &str = "/* USER CODE ORPHANED BEGIN ";
const ORPHAN_END: &str = "/* USER CODE ORPHANED END ";
const SUFFIX: &str = " */";

/// If `line` (modulo indentation) is `<prefix><tag> */`, return the tag.
/// Tags may contain spaces ("USART1_Init 0").
fn anchor_tag<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    line.trim().strip_prefix(prefix)?.strip_suffix(SUFFIX)
}

/// Parse every USER CODE section (and previously orphaned block) of a file:
/// tag -> inner lines (strictly between the anchors, CR stripped). First
/// occurrence wins on duplicate tags. `Err(tag)` on BEGIN without a matching
/// END for `tag`.
fn parse_sections(content: &str) -> Result<BTreeMap<String, Vec<String>>, String> {
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut lines = content.lines();
    while let Some(line) = lines.next() {
        let (tag, end_prefix) = if let Some(t) = anchor_tag(line, ORPHAN_BEGIN) {
            (t, ORPHAN_END)
        } else if let Some(t) = anchor_tag(line, BEGIN) {
            (t, END)
        } else {
            continue;
        };
        let mut inner: Vec<String> = Vec::new();
        let mut closed = false;
        for l in lines.by_ref() {
            if anchor_tag(l, end_prefix) == Some(tag) {
                closed = true;
                break;
            }
            inner.push(l.to_string());
        }
        if !closed {
            return Err(tag.to_string());
        }
        map.entry(tag.to_string()).or_insert(inner);
    }
    Ok(map)
}

/// True if the section holds anything beyond whitespace.
fn has_content(inner: &[String]) -> bool {
    inner.iter().any(|l| !l.trim().is_empty())
}

/// Merge the USER CODE sections of `existing_content` (previous generation,
/// possibly user-edited, CRLF tolerated) into `new_content` (fresh emission,
/// LF). Returns the merged text plus warning diagnostics.
///
/// * Section tag in both: existing inner text is spliced between the NEW
///   anchors.
/// * Tag only in the existing file with non-empty content: `REGEN_ORPHAN`
///   warning and the block is appended at the end of the file between
///   `/* USER CODE ORPHANED BEGIN <tag> */` .. `ORPHANED END` markers (which
///   are re-detected on the next regeneration, so orphans are never silently
///   dropped later either).
/// * Existing file has BEGIN without END: `REGEN_MALFORMED` warning and the
///   new content is returned unchanged (caller backs up the old file).
pub fn merge_user_code(
    new_content: &str,
    existing_content: &str,
    rel_path: &str,
) -> (String, Vec<Diagnostic>) {
    let mut diags: Vec<Diagnostic> = Vec::new();

    let existing = match parse_sections(existing_content) {
        Ok(m) => m,
        Err(tag) => {
            diags.push(Diagnostic::warning(
                REGEN_MALFORMED,
                format!("{rel_path}#{tag}"),
                format!(
                    "`/* USER CODE BEGIN {tag} */` has no matching END in the existing \
                     {rel_path}; the file was regenerated fresh and the previous version \
                     saved next to it as a .bak"
                ),
            ));
            return (new_content.to_string(), diags);
        }
    };

    let mut out: Vec<String> = Vec::new();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut lines = new_content.lines();
    while let Some(line) = lines.next() {
        out.push(line.to_string());
        let Some(tag) = anchor_tag(line, BEGIN) else {
            continue;
        };
        // Collect the freshly generated inner text up to the matching END.
        let mut new_inner: Vec<String> = Vec::new();
        let mut end_line: Option<String> = None;
        for l in lines.by_ref() {
            if anchor_tag(l, END) == Some(tag) {
                end_line = Some(l.to_string());
                break;
            }
            new_inner.push(l.to_string());
        }
        match end_line {
            Some(end) => {
                match existing.get(tag) {
                    Some(prev) => out.extend(prev.iter().cloned()),
                    None => out.extend(new_inner),
                }
                seen.insert(tag);
                out.push(end);
            }
            // Unterminated section in the NEW content (emitter bug): pass the
            // remainder through untouched rather than lose it.
            None => out.extend(new_inner),
        }
    }

    // Orphans: existing sections the new generation no longer emits.
    for (tag, inner) in &existing {
        if seen.contains(tag.as_str()) || !has_content(inner) {
            continue;
        }
        diags.push(Diagnostic::warning(
            REGEN_ORPHAN,
            format!("{rel_path}#{tag}"),
            format!(
                "user code in section `{tag}` of {rel_path} has no anchor in the \
                 regenerated file; it was moved to a `USER CODE ORPHANED {tag}` block \
                 at the end of the file"
            ),
        ));
        out.push(String::new());
        out.push(format!("{ORPHAN_BEGIN}{tag}{SUFFIX}"));
        out.extend(inner.iter().cloned());
        out.push(format!("{ORPHAN_END}{tag}{SUFFIX}"));
    }

    let mut merged = out.join("\n");
    if new_content.ends_with('\n') || !diags.is_empty() {
        merged.push('\n');
    }
    (merged, diags)
}
