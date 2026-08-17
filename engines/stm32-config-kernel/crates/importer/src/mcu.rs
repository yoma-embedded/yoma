//! Parser for per-package MCU part files (`db/mcu/STM32*.xml`).
//!
//! One file describes one RefName group + package: identity attributes on
//! the `<Mcu>` root, memory/frequency facts, the IP instance list, and the
//! pin table with per-pin signal capabilities (plus rare cross-pin
//! `<Condition>` mutual-exclusion constraints, e.g. BZ#83533).

use crate::{parse_condition_lenient, Lint};
use anyhow::Context as _;
use std::path::Path;
use stm32ck_ir::expr::{parse_number, Num};
use stm32ck_ir::model::{DiagCondition, IpInstance, Part, Pin, PinKind, PinSignal};

/// Expand a RefName group into concrete sales part numbers:
/// `"STM32F103C(8-B)Tx"` -> `["STM32F103C8Tx", "STM32F103CBTx"]`.
///
/// General cartesian product over every `(a-b-c)` group, alternatives in
/// document order; a name without groups expands to itself. An unmatched
/// `(` is kept as a literal character.
pub fn expand_ref_name(ref_name: &str) -> Vec<String> {
    let mut results = vec![String::new()];
    let mut rest = ref_name;
    while let Some(open) = rest.find('(') {
        let Some(close_rel) = rest[open + 1..].find(')') else {
            break; // unmatched `(` -> remainder is literal
        };
        let close = open + 1 + close_rel;
        let literal = &rest[..open];
        let alts: Vec<&str> = rest[open + 1..close].split('-').collect();
        let mut next = Vec::with_capacity(results.len() * alts.len());
        for prefix in &results {
            for alt in &alts {
                let mut s =
                    String::with_capacity(prefix.len() + literal.len() + alt.len());
                s.push_str(prefix);
                s.push_str(literal);
                s.push_str(alt);
                next.push(s);
            }
        }
        results = next;
        rest = &rest[close + 1..];
    }
    for r in &mut results {
        r.push_str(rest);
    }
    results
}

/// Parse one `db/mcu/*.xml` part file into a [`Part`].
///
/// Hard-fails only on unreadable XML or a wrong root element; every other
/// irregularity is tolerated and reported through `lint`.
pub fn parse_part(xml: &str, path: &Path, lint: &mut Lint) -> anyhow::Result<Part> {
    let doc = roxmltree::Document::parse(xml)
        .with_context(|| format!("XML parse error in {}", path.display()))?;
    let root = doc.root_element();
    if root.tag_name().name() != "Mcu" {
        anyhow::bail!(
            "{}: root element is <{}>, expected <Mcu>",
            path.display(),
            root.tag_name().name()
        );
    }

    // Deliberately ignored <Mcu> attributes (not warned):
    //   DBVersion  - pack-level db version comes from package.xml
    //   HasPowerPad, IOType, FwLibrary - package/library metadata unused by the IR
    warn_unknown_attrs(
        root,
        &[
            "RefName",
            "Family",
            "Line",
            "Package",
            "ClockTree",
            "DBVersion",
            "HasPowerPad",
            "IOType",
            "FwLibrary",
        ],
        path,
        lint,
    );
    let ref_name = req_attr(root, "RefName", path, lint);
    let family = req_attr(root, "Family", path, lint);
    let line = req_attr(root, "Line", path, lint);
    let package = req_attr(root, "Package", path, lint);
    let clock_tree = req_attr(root, "ClockTree", path, lint);

    let mut core = String::new();
    let mut max_freq_mhz: Option<u32> = None;
    let mut io_count: Option<u32> = None;
    let mut ccm_ram_kb: Option<u32> = None;
    let mut die = String::new();
    let mut flash_kb = Vec::new();
    let mut ram_kb = Vec::new();
    let mut voltage_mv = None;
    let mut pins = Vec::new();
    let mut ip_instances = Vec::new();

    for child in root.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "Core" => {
                let text = elem_text(child);
                if core.is_empty() {
                    core = text.to_string();
                } else {
                    // IR mismatch: Part.core is single-valued but dual-core
                    // parts (e.g. STM32H745) list two <Core> elements.
                    lint.warn(
                        path,
                        format!(
                            "additional <Core> `{text}` ignored (IR Part.core is single-valued)"
                        ),
                    );
                }
            }
            "Frequency" => scalar_u32(child, &mut max_freq_mhz, path, lint),
            "IONb" => scalar_u32(child, &mut io_count, path, lint),
            "Die" => {
                let text = elem_text(child);
                if die.is_empty() {
                    die = text.to_string();
                } else {
                    lint.warn(path, format!("duplicate <Die> `{text}` ignored"));
                }
            }
            "Flash" => {
                if let Some(v) = elem_u32(child, path, lint) {
                    flash_kb.push(v);
                }
            }
            // Core-coupled memory, separate from <Ram>. The db gives only the
            // size — its address is architectural, not device data.
            "CCMRam" => scalar_u32(child, &mut ccm_ram_kb, path, lint),
            "Ram" => {
                if let Some(v) = elem_u32(child, path, lint) {
                    ram_kb.push(v);
                }
            }
            "Voltage" => {
                warn_unknown_attrs(child, &["Min", "Max"], path, lint);
                let min = child.attribute("Min").and_then(volts_to_mv);
                let max = child.attribute("Max").and_then(volts_to_mv);
                match (min, max, voltage_mv) {
                    (Some(lo), Some(hi), None) => voltage_mv = Some((lo, hi)),
                    (_, _, Some(_)) => {
                        lint.warn(path, "duplicate <Voltage> ignored");
                    }
                    _ => lint.warn(
                        path,
                        "<Voltage> with missing/unparsable Min or Max ignored",
                    ),
                }
            }
            // Electrical/thermal data the IR does not model (deliberate, no warn):
            //   <Current Lowest=".." Run=".."/>, <Temperature Max=".." Min=".."/>
            "Current" | "Temperature" => {}
            "IP" => {
                if let Some(ip) = parse_ip(child, path, lint) {
                    ip_instances.push(ip);
                }
            }
            "Pin" => pins.push(parse_pin(child, path, lint)),
            other => lint.warn(path, format!("unknown element <{other}> under <Mcu>")),
        }
    }

    if core.is_empty() {
        lint.warn(path, "missing <Core>");
    }
    if die.is_empty() {
        lint.warn(path, "missing <Die>");
    }
    if max_freq_mhz.is_none() {
        lint.warn(path, "missing <Frequency>");
    }
    if io_count.is_none() {
        lint.warn(path, "missing <IONb>");
    }

    Ok(Part {
        part_numbers: expand_ref_name(&ref_name),
        ref_name,
        family,
        line,
        package,
        clock_tree,
        die,
        core,
        max_freq_mhz: max_freq_mhz.unwrap_or(0),
        flash_kb,
        ram_kb,
        // Filled by pack::import_family, which owns the db path needed to
        // resolve db/mcu/memory/*.xml.
        memory_maps: Default::default(),
        io_count: io_count.unwrap_or(0),
        ccm_ram_kb,
        voltage_mv,
        pins,
        ip_instances,
    })
}

fn parse_ip(node: roxmltree::Node, path: &Path, lint: &mut Lint) -> Option<IpInstance> {
    warn_unknown_attrs(
        node,
        &[
            "InstanceName",
            "Name",
            "Version",
            "ConfigFile",
            "ClockEnableMode",
        ],
        path,
        lint,
    );
    let instance = req_attr(node, "InstanceName", path, lint);
    let name = req_attr(node, "Name", path, lint);
    let version = req_attr(node, "Version", path, lint);
    if instance.is_empty() || name.is_empty() || version.is_empty() {
        // req_attr already warned; an unidentifiable IP entry is useless.
        return None;
    }
    Some(IpInstance {
        instance,
        name,
        version,
        config_file: node.attribute("ConfigFile").map(str::to_string),
        clock_enable: node
            .attribute("ClockEnableMode")
            .map(parse_clock_enable)
            .unwrap_or_default(),
    })
}

/// `";"`-separated HAL macro list; the literal `"none"` means empty.
fn parse_clock_enable(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "none")
        .map(str::to_string)
        .collect()
}

fn parse_pin(node: roxmltree::Node, path: &Path, lint: &mut Lint) -> Pin {
    warn_unknown_attrs(node, &["Name", "Position", "Type"], path, lint);
    let name = req_attr(node, "Name", path, lint);
    // Position may be alphanumeric on BGA packages ("A1") — kept as String.
    let position = req_attr(node, "Position", path, lint);
    let kind = match node.attribute("Type") {
        Some("I/O") => PinKind::Io,
        Some("Power") => PinKind::Power,
        Some("Reset") => PinKind::Reset,
        Some("Boot") => PinKind::Boot,
        Some("MonoIO") => PinKind::MonoIo,
        Some("NC") => PinKind::Nc,
        Some(other) => {
            lint.warn(path, format!("pin `{name}`: unknown Type `{other}`"));
            PinKind::Other
        }
        None => {
            lint.warn(path, format!("pin `{name}`: missing Type"));
            PinKind::Other
        }
    };

    let mut signals = Vec::new();
    let mut conditions = Vec::new();
    for child in node.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "Signal" => {
                warn_unknown_attrs(child, &["Name", "IOModes"], path, lint);
                let sig_name = match child.attribute("Name") {
                    Some(n) => n.to_string(),
                    None => {
                        lint.warn(path, format!("pin `{name}`: <Signal> without Name"));
                        continue;
                    }
                };
                let io_modes = child.attribute("IOModes").map(|v| {
                    v.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                });
                signals.push(PinSignal {
                    name: sig_name,
                    io_modes,
                });
            }
            "Condition" => {
                warn_unknown_attrs(child, &["Diagnostic", "Expression"], path, lint);
                let diagnostic = child.attribute("Diagnostic").unwrap_or("").to_string();
                match child.attribute("Expression") {
                    // Fail-closed: an unparseable pin guard becomes
                    // unsatisfiable, and pinout evaluation then REJECTS the
                    // signal — CubeMX's Pin.checkSignalCondition catches the
                    // parse exception, checkCondition returns false, and the
                    // placement is refused. Dropping the guard instead
                    // silently allowed placements CubeMX forbids.
                    Some(src) => {
                        let condition = parse_condition_lenient(src, path, lint)
                            .unwrap_or_else(stm32ck_ir::expr::unsatisfiable);
                        conditions.push(DiagCondition {
                            condition,
                            diagnostic,
                        });
                    }
                    None => lint.warn(
                        path,
                        format!("pin `{name}`: <Condition> without Expression"),
                    ),
                }
            }
            other => lint.warn(
                path,
                format!("unknown element <{other}> in <Pin Name=\"{name}\">"),
            ),
        }
    }

    Pin {
        name,
        position,
        kind,
        signals,
        conditions,
    }
}

/// Decimal-volts attribute value -> exact millivolts ("3.6" -> 3600).
fn volts_to_mv(text: &str) -> Option<u32> {
    let mv = parse_number(text.trim())? * Num::from_integer(1000);
    if !mv.is_integer() {
        return None;
    }
    u32::try_from(mv.to_integer()).ok()
}

fn elem_text<'a>(node: roxmltree::Node<'a, '_>) -> &'a str {
    node.text().unwrap_or("").trim()
}

fn elem_u32(node: roxmltree::Node, path: &Path, lint: &mut Lint) -> Option<u32> {
    let text = elem_text(node);
    match text.parse::<u32>() {
        Ok(v) => Some(v),
        Err(_) => {
            lint.warn(
                path,
                format!(
                    "<{}> has non-integer value `{text}`",
                    node.tag_name().name()
                ),
            );
            None
        }
    }
}

/// Parse a scalar u32 element; first occurrence wins, duplicates warn.
fn scalar_u32(
    node: roxmltree::Node,
    slot: &mut Option<u32>,
    path: &Path,
    lint: &mut Lint,
) {
    match (elem_u32(node, path, lint), &slot) {
        (Some(v), None) => *slot = Some(v),
        (Some(v), Some(_)) => lint.warn(
            path,
            format!("duplicate <{}> `{v}` ignored", node.tag_name().name()),
        ),
        (None, _) => {}
    }
}

/// Required attribute: empty + lint warning when absent.
fn req_attr(node: roxmltree::Node, name: &str, path: &Path, lint: &mut Lint) -> String {
    match node.attribute(name) {
        Some(v) => v.to_string(),
        None => {
            lint.warn(
                path,
                format!("<{}> missing attribute `{name}`", node.tag_name().name()),
            );
            String::new()
        }
    }
}

fn warn_unknown_attrs(node: roxmltree::Node, known: &[&str], path: &Path, lint: &mut Lint) {
    for attr in node.attributes() {
        if !known.contains(&attr.name()) {
            lint.warn(
                path,
                format!(
                    "unknown attribute `{}` on <{}>",
                    attr.name(),
                    node.tag_name().name()
                ),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Lint;

    fn parse_file(rel: &str) -> Option<(Part, Lint)> {
        let Some(db) = crate::test_db() else {
            eprintln!("skipping {rel}: CubeMX db not found (set STM32CK_CUBEMX_DB)");
            return None;
        };
        let path = db.join("mcu").join(rel);
        let xml = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        let mut lint = Lint::default();
        let part = parse_part(&xml, &path, &mut lint).expect("parse_part");
        Some((part, lint))
    }

    #[test]
    fn f103c8b_tx_real_file() {
        let Some((part, lint)) = parse_file("STM32F103C(8-B)Tx.xml") else {
            return;
        };
        assert_eq!(lint.warnings, Vec::<String>::new());

        assert_eq!(part.ref_name, "STM32F103C(8-B)Tx");
        assert_eq!(part.family, "STM32F1");
        assert_eq!(part.line, "STM32F103");
        assert_eq!(part.package, "LQFP48");
        assert_eq!(part.clock_tree, "STM32F102");
        assert_eq!(part.die, "DIE410");
        assert_eq!(part.core, "Arm Cortex-M3");
        assert_eq!(part.max_freq_mhz, 72);
        assert_eq!(part.io_count, 37);
        assert_eq!(part.flash_kb, [64, 128]);
        assert_eq!(part.ram_kb, [20]);
        assert_eq!(part.voltage_mv, Some((2000, 3600)));
        assert_eq!(part.part_numbers, ["STM32F103C8Tx", "STM32F103CBTx"]);

        // Pin table (48 pads on LQFP48), PA0-WKUP capabilities.
        assert_eq!(part.pins.len(), 48);
        let pa0 = part
            .pins
            .iter()
            .find(|p| p.name == "PA0-WKUP")
            .expect("PA0-WKUP pin");
        assert_eq!(pa0.position, "10");
        assert_eq!(pa0.kind, PinKind::Io);
        let names: Vec<&str> = pa0.signals.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"ADC1_IN0"), "signals: {names:?}");
        assert!(names.contains(&"USART2_CTS"), "signals: {names:?}");
        let gpio = pa0.signals.iter().find(|s| s.name == "GPIO").expect("GPIO");
        let modes = gpio.io_modes.as_ref().expect("GPIO IOModes");
        assert_eq!(modes.len(), 5);
        assert_eq!(modes[4], "EXTI");

        // Non-IO pin kinds.
        let vbat = part.pins.iter().find(|p| p.name == "VBAT").unwrap();
        assert_eq!(vbat.kind, PinKind::Power);
        let nrst = part.pins.iter().find(|p| p.name == "NRST").unwrap();
        assert_eq!(nrst.kind, PinKind::Reset);

        // Cross-pin exclusion condition (BZ#83533 on PB5).
        let pb5 = part.pins.iter().find(|p| p.name == "PB5").unwrap();
        assert_eq!(pb5.conditions.len(), 1);
        assert_eq!(pb5.conditions[0].diagnostic, "BZ#83533");

        // IP instances.
        let usart1 = part
            .ip_instances
            .iter()
            .find(|i| i.instance == "USART1")
            .expect("USART1 ip");
        assert_eq!(usart1.name, "USART");
        assert_eq!(usart1.version, "sci2_v1_1_Cube");
        assert_eq!(usart1.config_file, None);
        assert!(usart1.clock_enable.is_empty());

        let sys = part
            .ip_instances
            .iter()
            .find(|i| i.instance == "SYS")
            .expect("SYS ip");
        assert_eq!(
            sys.clock_enable,
            ["__HAL_RCC_AFIO_CLK_ENABLE", "__HAL_RCC_PWR_CLK_ENABLE"]
        );

        // ClockEnableMode="none" -> empty vec.
        let iwdg = part
            .ip_instances
            .iter()
            .find(|i| i.instance == "IWDG")
            .expect("IWDG ip");
        assert!(iwdg.clock_enable.is_empty());
        assert_eq!(iwdg.config_file.as_deref(), Some("IWDG-STM32F1xx"));
    }

    #[test]
    fn f411cce_ux_real_file() {
        let Some((part, lint)) = parse_file("STM32F411C(C-E)Ux.xml") else {
            return;
        };
        assert_eq!(lint.warnings, Vec::<String>::new());
        assert_eq!(part.family, "STM32F4");
        assert_eq!(part.clock_tree, "STM32F411");
        let rcc = part
            .ip_instances
            .iter()
            .find(|i| i.instance == "RCC")
            .expect("RCC ip");
        assert_eq!(rcc.name, "RCC");
        assert_eq!(rcc.version, "STM32F411-rcc_v1_0");
        assert_eq!(part.part_numbers, ["STM32F411CCUx", "STM32F411CEUx"]);
    }

    #[test]
    fn expand_no_group() {
        assert_eq!(expand_ref_name("STM32F103C8Tx"), ["STM32F103C8Tx"]);
    }

    #[test]
    fn expand_single_group() {
        assert_eq!(
            expand_ref_name("STM32F103C(8-B)Tx"),
            ["STM32F103C8Tx", "STM32F103CBTx"]
        );
    }

    #[test]
    fn expand_multi_alt() {
        assert_eq!(expand_ref_name("X(B-C-E)Y"), ["XBY", "XCY", "XEY"]);
    }

    #[test]
    fn expand_multi_group_cartesian() {
        assert_eq!(
            expand_ref_name("A(1-2)B(x-y)C"),
            ["A1BxC", "A1ByC", "A2BxC", "A2ByC"]
        );
    }

    #[test]
    fn expand_unmatched_paren_kept_literal() {
        assert_eq!(expand_ref_name("AB(C"), ["AB(C"]);
    }

    #[test]
    fn voltage_conversion_exact() {
        assert_eq!(volts_to_mv("3.6"), Some(3600));
        assert_eq!(volts_to_mv("2"), Some(2000));
        assert_eq!(volts_to_mv("1.71"), Some(1710));
        assert_eq!(volts_to_mv("x"), None);
    }
}
