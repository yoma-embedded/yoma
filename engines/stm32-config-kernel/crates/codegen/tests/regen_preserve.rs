//! USER CODE preservation across regeneration.
//!
//! Unit tests exercise `preserve::merge_user_code` as a pure function;
//! integration tests regenerate the golden F103 project in place and check
//! that user edits inside USER CODE sections survive (they skip, with an
//! eprintln, when the IR pack or firmware components are absent).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use stm32ck_codegen::generate_project;
use stm32ck_codegen::preserve::{merge_user_code, REGEN_MALFORMED, REGEN_ORPHAN};
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::has_errors;
use stm32ck_engine::session::validate;
use stm32ck_ir::model::IrPack;

// ---------------------------------------------------------------------------
// Unit tests: merge_user_code
// ---------------------------------------------------------------------------

const NEW: &str = "\
/* header */
#include \"main.h\"
/* USER CODE BEGIN Includes */

/* USER CODE END Includes */
int main(void)
{
  MX_GPIO_Init();
  /* USER CODE BEGIN 2 */

  /* USER CODE END 2 */
  return 0;
}
";

#[test]
fn untouched_roundtrip_is_byte_identical() {
    let (merged, diags) = merge_user_code(NEW, NEW, "Core/Src/main.c");
    assert!(diags.is_empty(), "unexpected diags: {diags:?}");
    assert_eq!(merged, NEW);
}

#[test]
fn user_edits_are_spliced_into_new_content() {
    let edited = NEW
        .replace(
            "/* USER CODE BEGIN Includes */\n",
            "/* USER CODE BEGIN Includes */\n#include \"myapp.h\"\n",
        )
        .replace(
            "  /* USER CODE BEGIN 2 */\n",
            "  /* USER CODE BEGIN 2 */\n  my_user_setup();\n",
        );
    let (merged, diags) = merge_user_code(NEW, &edited, "Core/Src/main.c");
    assert!(diags.is_empty(), "unexpected diags: {diags:?}");
    assert!(merged.contains("#include \"myapp.h\""), "merged:\n{merged}");
    assert!(merged.contains("  my_user_setup();"), "merged:\n{merged}");
    // Anchors come from the NEW content, exactly once each.
    for anchor in [
        "/* USER CODE BEGIN Includes */",
        "/* USER CODE END Includes */",
        "/* USER CODE BEGIN 2 */",
        "/* USER CODE END 2 */",
    ] {
        assert_eq!(merged.matches(anchor).count(), 1, "anchor {anchor}");
    }
    // Non-section generated text is taken from the new content.
    assert!(merged.contains("MX_GPIO_Init();"));
    // Re-merging the merged file is a fixpoint (idempotent).
    let (again, diags2) = merge_user_code(NEW, &merged, "Core/Src/main.c");
    assert!(diags2.is_empty());
    assert_eq!(again, merged);
}

#[test]
fn crlf_existing_file_is_tolerated_and_normalized() {
    let edited = NEW.replace(
        "  /* USER CODE BEGIN 2 */\n",
        "  /* USER CODE BEGIN 2 */\n  crlf_user_code();\n",
    );
    let crlf = edited.replace('\n', "\r\n");
    let (merged, diags) = merge_user_code(NEW, &crlf, "Core/Src/main.c");
    assert!(diags.is_empty(), "unexpected diags: {diags:?}");
    assert!(merged.contains("  crlf_user_code();"), "merged:\n{merged}");
    assert!(!merged.contains('\r'), "output must be LF-only");
}

#[test]
fn section_only_in_new_content_keeps_new_inner() {
    // Existing predates the "2" section entirely.
    let old = "\
/* USER CODE BEGIN Includes */
#include \"legacy.h\"
/* USER CODE END Includes */
";
    let (merged, diags) = merge_user_code(NEW, old, "Core/Src/main.c");
    assert!(diags.is_empty(), "unexpected diags: {diags:?}");
    assert!(merged.contains("#include \"legacy.h\""));
    // The "2" section keeps its (empty) freshly generated body.
    assert!(merged.contains("  /* USER CODE BEGIN 2 */\n\n  /* USER CODE END 2 */"));
}

#[test]
fn orphaned_nonempty_section_warns_and_is_appended() {
    let old = NEW.replace(
        "int main(void)",
        "/* USER CODE BEGIN OLD 0 */\nprecious_user_code();\n/* USER CODE END OLD 0 */\nint main(void)",
    );
    let (merged, diags) = merge_user_code(NEW, &old, "Core/Src/main.c");
    assert_eq!(diags.len(), 1, "diags: {diags:?}");
    assert_eq!(diags[0].code, REGEN_ORPHAN);
    assert_eq!(diags[0].path, "Core/Src/main.c#OLD 0");
    assert!(merged.contains("/* USER CODE ORPHANED BEGIN OLD 0 */\nprecious_user_code();\n/* USER CODE ORPHANED END OLD 0 */"),
        "merged:\n{merged}");
    // The orphan block sits at the end of the file.
    assert!(merged.trim_end().ends_with("/* USER CODE ORPHANED END OLD 0 */"));
}

#[test]
fn orphaned_empty_section_is_dropped_silently() {
    let old = NEW.replace(
        "int main(void)",
        "/* USER CODE BEGIN OLD 0 */\n\n/* USER CODE END OLD 0 */\nint main(void)",
    );
    let (merged, diags) = merge_user_code(NEW, &old, "Core/Src/main.c");
    assert!(diags.is_empty(), "diags: {diags:?}");
    assert_eq!(merged, NEW);
}

#[test]
fn orphaned_block_survives_a_second_regeneration() {
    let old = NEW.replace(
        "int main(void)",
        "/* USER CODE BEGIN OLD 0 */\nprecious_user_code();\n/* USER CODE END OLD 0 */\nint main(void)",
    );
    let (first, _) = merge_user_code(NEW, &old, "Core/Src/main.c");
    // Regenerate again over the merged result: the orphan is re-detected,
    // re-warned, and re-appended -- never silently dropped.
    let (second, diags) = merge_user_code(NEW, &first, "Core/Src/main.c");
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].code, REGEN_ORPHAN);
    assert_eq!(second, first, "orphan re-merge must be a fixpoint");
}

#[test]
fn malformed_existing_keeps_new_content() {
    let broken = "\
/* USER CODE BEGIN Includes */
#include \"lost.h\"
int main(void) { return 0; }
";
    let (merged, diags) = merge_user_code(NEW, broken, "Core/Src/main.c");
    assert_eq!(diags.len(), 1, "diags: {diags:?}");
    assert_eq!(diags[0].code, REGEN_MALFORMED);
    assert_eq!(diags[0].path, "Core/Src/main.c#Includes");
    assert_eq!(merged, NEW, "unmergeable file: new content must win");
}

// ---------------------------------------------------------------------------
// Integration: regenerate the golden F103 project in place
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn load_pack(name: &str) -> Option<IrPack> {
    let path = repo_root().join("data").join(name);
    if !path.is_file() {
        eprintln!("skip: {} not present (run the importer first)", path.display());
        return None;
    }
    let compressed = std::fs::read(path).unwrap();
    let bin = zstd::decode_all(compressed.as_slice()).unwrap();
    Some(postcard::from_bytes(&bin).unwrap())
}

/// Pack + firmware present, else None (skip). No toolchain needed here.
fn prerequisites() -> Option<(IrPack, PathBuf)> {
    let pack = load_pack("stm32f1.irpack")?;
    let fw_dir = repo_root().join("data").join("fw");
    if !fw_dir.join("STM32F1").is_dir() {
        eprintln!("skip: firmware components not present under {}", fw_dir.display());
        return None;
    }
    Some((pack, fw_dir))
}

fn golden_doc(baud: u32) -> ConfigDoc {
    serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "mcu": {{ "part": "STM32F103C8Tx" }},
          "clock": {{
            "sources": {{ "HSE": {{ "kind": "crystal", "freqHz": 8000000 }} }},
            "targets": {{ "SYSCLK": {{ "hz": 72000000 }} }}
          }},
          "peripherals": {{
            "USART1": {{
              "mode": "Asynchronous",
              "params": {{ "BaudRate": {baud} }},
              "pins": {{ "TX": "PA9", "RX": "PA10" }},
              "nvic": {{ "enabled": true, "preemptionPriority": 1 }}
            }}
          }},
          "gpio": {{ "PC13": {{ "mode": "output", "initHigh": true, "label": "LED" }} }}
        }}"#
    ))
    .unwrap()
}

/// Validate + generate into `out_dir` WITHOUT wiping it (regeneration is the
/// point). Returns the manifest.
fn generate_into(
    pack: &IrPack,
    doc: &ConfigDoc,
    fw_dir: &Path,
    out_dir: &Path,
) -> stm32ck_codegen::Manifest {
    std::fs::create_dir_all(out_dir).unwrap();
    let resolved = validate(pack, doc).expect("hard failure");
    assert!(!has_errors(&resolved.diags), "golden config must be clean: {:?}", resolved.diags);
    generate_project(pack, &resolved, doc, fw_dir, out_dir, "0.1.0").expect("generate_project")
}

fn fresh_dir(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
    dir
}

/// Insert a line right after `anchor` in `file` (asserts the anchor exists
/// exactly once first).
fn edit_after(file: &Path, anchor: &str, inserted: &str) {
    let content = std::fs::read_to_string(file).unwrap();
    let needle = format!("{anchor}\n");
    assert_eq!(
        content.matches(&needle).count(),
        1,
        "anchor {anchor} not unique in {}",
        file.display()
    );
    let edited = content.replace(&needle, &format!("{anchor}\n{inserted}\n"));
    std::fs::write(file, edited).unwrap();
}

#[test]
fn f103_user_edits_survive_regeneration() {
    let Some((pack, fw_dir)) = prerequisites() else { return };
    let doc = golden_doc(115_200);
    let out_dir = fresh_dir("regen_preserve_edits");
    generate_into(&pack, &doc, &fw_dir, &out_dir);

    let main_c = out_dir.join("Core/Src/main.c");
    edit_after(&main_c, "  /* USER CODE BEGIN 2 */", "  my_user_setup();");
    edit_after(&main_c, "/* USER CODE BEGIN Includes */", "#include \"myapp.h\"");

    let manifest = generate_into(&pack, &doc, &fw_dir, &out_dir);
    assert!(manifest.diags.is_empty(), "clean regen must not warn: {:?}", manifest.diags);

    let regen = std::fs::read_to_string(&main_c).unwrap();
    assert!(regen.contains("  my_user_setup();"), "edit in section 2 lost:\n{regen}");
    assert!(regen.contains("#include \"myapp.h\""), "edit in Includes lost:\n{regen}");
    for anchor in [
        "/* USER CODE BEGIN 2 */",
        "/* USER CODE END 2 */",
        "/* USER CODE BEGIN Includes */",
        "/* USER CODE END Includes */",
    ] {
        assert_eq!(regen.matches(anchor).count(), 1, "anchor {anchor} duplicated or lost");
    }
}

#[test]
fn f103_config_change_keeps_edit_and_applies_new_value() {
    let Some((pack, fw_dir)) = prerequisites() else { return };
    let out_dir = fresh_dir("regen_preserve_baud");
    generate_into(&pack, &golden_doc(115_200), &fw_dir, &out_dir);

    let main_c = out_dir.join("Core/Src/main.c");
    let usart_c = out_dir.join("Core/Src/usart.c");
    edit_after(&main_c, "  /* USER CODE BEGIN 2 */", "  my_user_setup();");
    assert!(std::fs::read_to_string(&usart_c)
        .unwrap()
        .contains("huart1.Init.BaudRate = 115200;"));

    let manifest = generate_into(&pack, &golden_doc(9_600), &fw_dir, &out_dir);
    assert!(manifest.diags.is_empty(), "clean regen must not warn: {:?}", manifest.diags);

    let regen = std::fs::read_to_string(&main_c).unwrap();
    assert!(regen.contains("  my_user_setup();"), "user edit lost:\n{regen}");
    let regen_usart = std::fs::read_to_string(&usart_c).unwrap();
    assert!(
        regen_usart.contains("huart1.Init.BaudRate = 9600;"),
        "new baud missing:\n{regen_usart}"
    );
    assert!(!regen_usart.contains("115200"), "stale baud still present:\n{regen_usart}");
}

#[test]
fn f103_untouched_regeneration_changes_nothing() {
    let Some((pack, fw_dir)) = prerequisites() else { return };
    let doc = golden_doc(115_200);
    let out_dir = fresh_dir("regen_preserve_noop");
    let first = generate_into(&pack, &doc, &fw_dir, &out_dir);

    let before: BTreeMap<String, Vec<u8>> = first
        .files
        .iter()
        .map(|rel| (rel.clone(), std::fs::read(out_dir.join(rel)).unwrap()))
        .collect();

    let second = generate_into(&pack, &doc, &fw_dir, &out_dir);
    assert_eq!(first.files, second.files, "manifests differ across regeneration");
    assert!(second.diags.is_empty(), "noop regen must not warn: {:?}", second.diags);
    for (rel, old) in &before {
        let new = std::fs::read(out_dir.join(rel)).unwrap();
        assert!(old == &new, "{rel} changed byte-wise on untouched regeneration");
    }
    // No stray .bak files from a clean regeneration.
    assert!(!out_dir.join("Core/Src/main.c.bak").exists());
}
