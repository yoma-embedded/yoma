use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "stm32ck-probe-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn db(&self, relative: &str) -> PathBuf {
        let db = self.0.join(relative);
        std::fs::create_dir_all(db.join("mcu")).unwrap();
        std::fs::write(db.join("package.xml"), "<Package Version=\"6.17.0\"/>").unwrap();
        std::fs::write(db.join("mcu/part.xml"), "<Mcu Family=\"STM32G4\"/>").unwrap();
        db
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn importer() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_stm32ck-import"));
    cmd.env_remove("STM32CK_CUBEMX_DB");
    cmd
}

#[test]
fn probe_accepts_installation_and_mac_bundle_layouts_without_writing() {
    for layout in ["db", "Contents/Resources/db", "Contents/MacOs/db", "Contents/MacOS/db"] {
        let fixture = Fixture::new();
        let db = fixture.db(layout);
        let out = fixture.0.join("must-not-create");
        for configured in [&fixture.0, &db, &db.parent().unwrap().to_path_buf()] {
            let result = importer().args(["--probe", "--cubemx-db"])
                .arg(configured).arg("--out").arg(&out).output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
            let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(
                std::fs::canonicalize(report["dbPath"].as_str().unwrap()).unwrap(),
                std::fs::canonicalize(&db).unwrap()
            );
            assert_eq!(report["dbVersion"], "6.17.0");
            assert_eq!(report["families"], serde_json::json!(["STM32G4"]));
            assert!(!out.exists());
        }
    }
}

#[test]
fn broken_explicit_environment_override_does_not_fall_back() {
    let fixture = Fixture::new();
    let result = importer().arg("--probe")
        .env("STM32CK_CUBEMX_DB", fixture.0.join("missing"))
        .output().unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("configured CubeMX path"));
    assert!(result.stdout.is_empty());
}

#[test]
fn explicit_argument_overrides_bad_environment() {
    let fixture = Fixture::new();
    fixture.db("db");
    let result = importer().args(["--probe", "--cubemx-db"]).arg(&fixture.0)
        .env("STM32CK_CUBEMX_DB", fixture.0.join("missing"))
        .output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
}

#[test]
fn empty_database_is_not_reported_ready() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(fixture.0.join("db/mcu")).unwrap();
    let result = importer().args(["--probe", "--cubemx-db"]).arg(&fixture.0).output().unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("no MCU families"));
}

#[test]
fn database_release_is_not_the_xml_or_database_format_version() {
    let fixture = Fixture::new();
    let db = fixture.db("db");
    for (xml, expected) in [
        (r#"<?xml version="1.0"?><Package DBVersion="2.0"><PackDescription Release="DB.6.0.181"/></Package>"#, "DB.6.0.181"),
        (r#"<?xml version="1.0"?><Package DBVersion="2.0"/>"#, "unknown"),
    ] {
        std::fs::write(db.join("package.xml"), xml).unwrap();
        let result = importer().args(["--probe", "--cubemx-db"]).arg(&fixture.0).output().unwrap();
        assert!(result.status.success());
        let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(report["dbVersion"], expected);
    }
}

#[test]
fn quiet_lint_preserves_family_progress_and_failures() {
    let fixture = Fixture::new();
    fixture.db("db"); // Deliberately incomplete MCU produces lint warnings.
    let normal = importer().args(["--smoke", "--cubemx-db"]).arg(&fixture.0).output().unwrap();
    assert!(normal.status.success());
    assert!(String::from_utf8_lossy(&normal.stderr).contains("  lint:"));
    let quiet = importer().args(["--smoke", "--quiet-lint", "--cubemx-db"]).arg(&fixture.0).output().unwrap();
    assert!(quiet.status.success());
    let text = String::from_utf8_lossy(&quiet.stderr);
    assert!(!text.contains("  lint:"));
    assert!(text.contains("STM32G4:"));
    assert!(text.contains("done: 1 families"));
    let failed = importer().args(["--smoke", "--quiet-lint", "--cubemx-db"])
        .arg(fixture.0.join("missing")).output().unwrap();
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("configured CubeMX path"));
}
