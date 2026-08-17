//! GPIO IP parser: `db/mcu/IP/GPIO-*_Modes.xml`.
//!
//! These "service" IP files carry three kinds of payload:
//!   1. electrical `RefParameter` presets (mode / pull / speed lists),
//!   2. `RefMode` IO presets (AlternateFunctionPushPull, Input, EXTI, ...),
//!   3. per-pin AF tables: `GPIO_Pin` elements whose `PinSignal` children
//!      bind a signal either to a HAL AF macro (F0/F2+ style), to one or
//!      more AFIO `RemapBlock`s (F1 style), or to nothing (analog signals).
//!
//! Deliberately ignored without lint noise (documentation / schema plumbing):
//!   - the `<About>` free-text element,
//!   - root attributes `DBVersion` and `IPType`,
//!   - any namespaced attribute (e.g. `xsi:schemaLocation`).
//!
//! Known IR gaps are *aggregated* into one lint warning per file per kind
//! (marked "no IR field") instead of one per occurrence:
//!   - `<GPIO_Port>` (per-port clock-enable macro, EVENTOUT port source),
//!   - pin/signal-level `SpecificParameter`s other than `GPIO_Pin`,
//!     `GPIO_PinSource` and `GPIO_AF` (e.g. `GPIO_Speed` presets on
//!     oscillator pins, `EXTI_Line` in newer families).

use crate::{parse_condition_lenient, Lint};
use std::collections::BTreeMap;
use std::path::Path;
use stm32ck_ir::expr::{parse_number, Num};
use stm32ck_ir::model::{
    AfBinding, DiagCondition, GpioIp, GpioPin, GpioPinSignal, ModeParameter, PossibleValue,
    PvAction, RefMode, RefParameter, RemapBlockRef,
};

/// Parse one `GPIO-*_Modes.xml` document into a [`GpioIp`].
pub fn parse_gpio_ip(xml: &str, path: &Path, lint: &mut Lint) -> anyhow::Result<GpioIp> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|e| anyhow::anyhow!("{}: XML parse error: {e}", path.display()))?;
    let root = doc.root_element();
    if root.tag_name().name() != "IP" {
        anyhow::bail!(
            "{}: expected <IP> root, found <{}>",
            path.display(),
            root.tag_name().name()
        );
    }
    check_attrs(root, &["DBVersion", "IPType", "Name", "Version"], path, lint);
    if root.attribute("Name") != Some("GPIO") {
        lint.warn(
            path,
            format!("IP Name is {:?}, expected \"GPIO\"", root.attribute("Name")),
        );
    }
    let version = match root.attribute("Version") {
        Some(v) => v.to_string(),
        None => {
            lint.warn(path, "IP missing Version attribute");
            String::new()
        }
    };

    let mut ip = GpioIp {
        version,
        ref_parameters: Vec::new(),
        ref_modes: Vec::new(),
        pins: BTreeMap::new(),
        ports: BTreeMap::new(),
    };
    // Known-IR-gap skip counters, flushed as one warning per kind below.
    let mut skips: BTreeMap<String, usize> = BTreeMap::new();

    for child in root.children().filter(|c| c.is_element()) {
        match child.tag_name().name() {
            "About" => {} // documentation text, deliberately ignored
            "RefParameter" => {
                if let Some(rp) = parse_ref_parameter(child, path, lint) {
                    ip.ref_parameters.push(rp);
                }
            }
            "RefMode" => {
                if let Some(rm) = parse_ref_mode(child, path, lint) {
                    ip.ref_modes.push(rm);
                }
            }
            "GPIO_Pin" => {
                if let Some((name, pin)) = parse_pin(child, path, lint, &mut skips) {
                    if ip.pins.contains_key(&name) {
                        lint.warn(path, format!("duplicate GPIO_Pin {name}; keeping first"));
                    } else {
                        ip.pins.insert(name, pin);
                    }
                }
            }
            "GPIO_Port" => {
                let Some(name) = child.attribute("Name").map(str::to_string) else {
                    lint.warn(path, "GPIO_Port without Name attribute");
                    continue;
                };
                let clock_enable: Vec<String> = child
                    .attribute("ClockEnableMode")
                    .unwrap_or_default()
                    .split(';')
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && *s != "none")
                    .map(str::to_string)
                    .collect();
                ip.ports
                    .entry(name.clone())
                    .or_insert(stm32ck_ir::model::GpioPort { name, clock_enable });
            }
            other => lint.warn(path, format!("unknown element <{other}> under <IP>")),
        }
    }

    for (what, n) in skips {
        lint.warn(path, format!("{what}: skipped {n} occurrence(s)"));
    }
    Ok(ip)
}

// ---------------------------------------------------------------------------
// RefParameter / PossibleValue (generic IP shape)
// ---------------------------------------------------------------------------

fn parse_ref_parameter(
    node: roxmltree::Node,
    path: &Path,
    lint: &mut Lint,
) -> Option<RefParameter> {
    check_attrs(
        node,
        &[
            "Name", "Comment", "Type", "DefaultValue", "Visible", "Min", "Max", "Unit", "Group",
        ],
        path,
        lint,
    );
    let Some(name) = node.attribute("Name") else {
        lint.warn(path, "RefParameter without Name; skipped");
        return None;
    };
    let visible = match node.attribute("Visible") {
        None | Some("true") => true,
        Some("false") => false,
        Some(other) => {
            lint.warn(
                path,
                format!("RefParameter {name}: odd Visible=\"{other}\" treated as true"),
            );
            true
        }
    };
    let min = parse_num_attr(node, "Min", path, lint);
    let max = parse_num_attr(node, "Max", path, lint);

    let mut condition: Option<DiagCondition> = None;
    let mut possible_values = Vec::new();
    for c in node.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "PossibleValue" => {
                if let Some(pv) = parse_possible_value(c, path, lint) {
                    possible_values.push(pv);
                }
            }
            "Condition" => {
                // Unparseable guard => unsatisfiable, never unconditional
                // (see stm32ck_ir::expr::unsatisfiable).
                let dc = Some(parse_condition_child(c, path, lint).unwrap_or_else(|| {
                    DiagCondition {
                        condition: stm32ck_ir::expr::unsatisfiable(),
                        diagnostic: c.attribute("Diagnostic").unwrap_or("").to_string(),
                    }
                }));
                if condition.is_none() {
                    condition = dc;
                } else if dc.is_some() {
                    lint.warn(
                        path,
                        format!("RefParameter {name}: multiple <Condition>; keeping first"),
                    );
                }
            }
            other => lint.warn(path, format!("RefParameter {name}: unknown child <{other}>")),
        }
    }

    Some(RefParameter {
        name: name.to_string(),
        comment: node.attribute("Comment").unwrap_or("").to_string(),
        default_value: node.attribute("DefaultValue").unwrap_or("").to_string(),
        param_type: node.attribute("Type").unwrap_or("").to_string(),
        min,
        max,
        unit: node.attribute("Unit").unwrap_or("").to_string(),
        group: node.attribute("Group").unwrap_or("").to_string(),
        visible,
        condition,
        possible_values,
    })
}

fn parse_possible_value(
    node: roxmltree::Node,
    path: &Path,
    lint: &mut Lint,
) -> Option<PossibleValue> {
    check_attrs(
        node,
        &["Value", "Comment", "Semaphore", "Condition", "Action", "Diagnostic"],
        path,
        lint,
    );
    let Some(value) = node.attribute("Value") else {
        lint.warn(path, "PossibleValue without Value attribute; skipped");
        return None;
    };
    let comment = node.attribute("Comment").unwrap_or("").to_string();
    let factor = parse_number(comment.trim());
    // Fail-closed: an unparseable exclusion condition never fires, i.e. the
    // value stays available — CubeMX's exception ⇒ false.
    let mut condition = node.attribute("Condition").map(|src| {
        parse_condition_lenient(src, path, lint)
            .unwrap_or_else(stm32ck_ir::expr::unsatisfiable)
    });
    let mut diagnostic = node.attribute("Diagnostic").unwrap_or("").to_string();
    let action = match node.attribute("Action") {
        None => None,
        Some("Disable") => Some(PvAction::Disable),
        Some("Remove") => Some(PvAction::Remove),
        Some(other) => {
            lint.warn(
                path,
                format!("PossibleValue {value}: unknown Action=\"{other}\""),
            );
            None
        }
    };
    for c in node.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "Condition" => {
                if let Some(dc) = parse_condition_child(c, path, lint) {
                    if condition.is_none() {
                        condition = Some(dc.condition);
                        if diagnostic.is_empty() {
                            diagnostic = dc.diagnostic;
                        }
                    } else {
                        lint.warn(
                            path,
                            format!("PossibleValue {value}: multiple conditions; keeping first"),
                        );
                    }
                }
            }
            other => lint.warn(path, format!("PossibleValue {value}: unknown child <{other}>")),
        }
    }
    Some(PossibleValue {
        value: value.to_string(),
        comment,
        factor,
        semaphore: node.attribute("Semaphore").map(str::to_string),
        condition,
        action,
        diagnostic,
    })
}

// ---------------------------------------------------------------------------
// RefMode (IO presets; is_abstract/base_mode/hal_mode never occur here)
// ---------------------------------------------------------------------------

fn parse_ref_mode(node: roxmltree::Node, path: &Path, lint: &mut Lint) -> Option<RefMode> {
    check_attrs(node, &["Name"], path, lint);
    let Some(name) = node.attribute("Name") else {
        lint.warn(path, "RefMode without Name; skipped");
        return None;
    };
    let mut rm = RefMode {
        name: name.to_string(),
        is_abstract: false,
        base_mode: None,
        hal_mode: None,
        config_for_mode: Vec::new(),
        condition: None,
        parameters: Vec::new(),
        semaphores: Vec::new(),
    };
    for c in node.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "ConfigForMode" => rm.config_for_mode.push(trimmed_text(c)),
            "Parameter" => {
                check_attrs(c, &["Name"], path, lint);
                let Some(pname) = c.attribute("Name") else {
                    lint.warn(path, format!("RefMode {name}: Parameter without Name; skipped"));
                    continue;
                };
                let mut pinned_values = Vec::new();
                for pv in c.children().filter(|c| c.is_element()) {
                    match pv.tag_name().name() {
                        "PossibleValue" => pinned_values.push(trimmed_text(pv)),
                        other => lint.warn(
                            path,
                            format!("RefMode {name}: Parameter {pname}: unknown child <{other}>"),
                        ),
                    }
                }
                rm.parameters.push(ModeParameter {
                    name: pname.to_string(),
                    pinned_values,
                    // GPIO RefMode parameters carry neither form in the db.
                    ref_parameter: None,
                    condition: None,
                });
            }
            "Condition" => {
                let dc = parse_condition_child(c, path, lint);
                if rm.condition.is_none() {
                    rm.condition = dc;
                } else if dc.is_some() {
                    lint.warn(
                        path,
                        format!("RefMode {name}: multiple <Condition>; keeping first"),
                    );
                }
            }
            "Semaphore" => rm.semaphores.push(trimmed_text(c)),
            other => lint.warn(path, format!("RefMode {name}: unknown child <{other}>")),
        }
    }
    Some(rm)
}

// ---------------------------------------------------------------------------
// Per-pin AF tables
// ---------------------------------------------------------------------------

fn parse_pin(
    node: roxmltree::Node,
    path: &Path,
    lint: &mut Lint,
    skips: &mut BTreeMap<String, usize>,
) -> Option<(String, GpioPin)> {
    check_attrs(node, &["Name", "PortName"], path, lint);
    let Some(name) = node.attribute("Name") else {
        lint.warn(path, "GPIO_Pin without Name; skipped");
        return None;
    };
    let port = match node.attribute("PortName") {
        Some(p) => p.to_string(),
        None => {
            lint.warn(path, format!("GPIO_Pin {name} missing PortName"));
            String::new()
        }
    };
    let mut pin = GpioPin {
        port,
        pin_macro: String::new(),
        pin_source: None,
        signals: Vec::new(),
    };
    for c in node.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "SpecificParameter" => {
                check_attrs(c, &["Name"], path, lint);
                match c.attribute("Name") {
                    Some("GPIO_Pin") => match specific_value(c, path, lint) {
                        Some(v) if pin.pin_macro.is_empty() => pin.pin_macro = v,
                        Some(_) => lint.warn(
                            path,
                            format!("GPIO_Pin {name}: duplicate SpecificParameter GPIO_Pin"),
                        ),
                        None => {}
                    },
                    Some("GPIO_PinSource") => {
                        if pin.pin_source.is_some() {
                            lint.warn(
                                path,
                                format!("GPIO_Pin {name}: duplicate GPIO_PinSource"),
                            );
                        } else {
                            pin.pin_source = specific_value(c, path, lint);
                        }
                    }
                    Some(other) => {
                        *skips
                            .entry(format!(
                                "GPIO_Pin SpecificParameter \"{other}\" (no IR field)"
                            ))
                            .or_default() += 1;
                    }
                    None => lint.warn(
                        path,
                        format!("GPIO_Pin {name}: SpecificParameter without Name"),
                    ),
                }
            }
            "PinSignal" => {
                if let Some(sig) = parse_pin_signal(c, name, path, lint, skips) {
                    pin.signals.push(sig);
                }
            }
            other => lint.warn(path, format!("GPIO_Pin {name}: unknown child <{other}>")),
        }
    }
    if pin.pin_macro.is_empty() {
        lint.warn(path, format!("GPIO_Pin {name}: missing GPIO_Pin macro"));
    }
    Some((name.to_string(), pin))
}

fn parse_pin_signal(
    node: roxmltree::Node,
    pin_name: &str,
    path: &Path,
    lint: &mut Lint,
    skips: &mut BTreeMap<String, usize>,
) -> Option<GpioPinSignal> {
    check_attrs(node, &["Name"], path, lint);
    let Some(signal) = node.attribute("Name") else {
        lint.warn(
            path,
            format!("GPIO_Pin {pin_name}: PinSignal without Name; skipped"),
        );
        return None;
    };
    let mut af: Option<String> = None;
    let mut blocks: Vec<RemapBlockRef> = Vec::new();
    for c in node.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "SpecificParameter" => {
                check_attrs(c, &["Name"], path, lint);
                match c.attribute("Name") {
                    Some("GPIO_AF") => match specific_value(c, path, lint) {
                        Some(v) if af.is_none() => af = Some(v),
                        Some(_) => lint.warn(
                            path,
                            format!("{pin_name}/{signal}: duplicate GPIO_AF; keeping first"),
                        ),
                        None => {}
                    },
                    Some(other) => {
                        *skips
                            .entry(format!(
                                "PinSignal SpecificParameter \"{other}\" (no IR field)"
                            ))
                            .or_default() += 1;
                    }
                    None => lint.warn(
                        path,
                        format!("{pin_name}/{signal}: SpecificParameter without Name"),
                    ),
                }
            }
            "RemapBlock" => {
                if let Some(b) = parse_remap_block(c, pin_name, signal, path, lint, skips) {
                    blocks.push(b);
                }
            }
            other => lint.warn(
                path,
                format!("{pin_name}/{signal}: unknown child <{other}>"),
            ),
        }
    }
    let binding = if !blocks.is_empty() {
        if af.is_some() {
            lint.warn(
                path,
                format!("{pin_name}/{signal}: both GPIO_AF and RemapBlock; using RemapBlock"),
            );
        }
        AfBinding::Remap { blocks }
    } else if let Some(macro_name) = af {
        AfBinding::Af { macro_name }
    } else {
        AfBinding::None
    };
    Some(GpioPinSignal {
        signal: signal.to_string(),
        binding,
    })
}

fn parse_remap_block(
    node: roxmltree::Node,
    pin_name: &str,
    signal: &str,
    path: &Path,
    lint: &mut Lint,
    skips: &mut BTreeMap<String, usize>,
) -> Option<RemapBlockRef> {
    check_attrs(node, &["Name", "DefaultRemap"], path, lint);
    let Some(block) = node.attribute("Name") else {
        lint.warn(
            path,
            format!("{pin_name}/{signal}: RemapBlock without Name; skipped"),
        );
        return None;
    };
    let default_remap = match node.attribute("DefaultRemap") {
        None | Some("false") => false,
        Some("true") => true,
        Some(other) => {
            lint.warn(
                path,
                format!(
                    "{pin_name}/{signal}/{block}: odd DefaultRemap=\"{other}\" treated as false"
                ),
            );
            false
        }
    };
    let mut af_macro: Option<String> = None;
    for c in node.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "SpecificParameter" => {
                check_attrs(c, &["Name"], path, lint);
                match c.attribute("Name") {
                    Some("GPIO_AF") => {
                        if af_macro.is_some() {
                            lint.warn(
                                path,
                                format!(
                                    "{pin_name}/{signal}/{block}: duplicate GPIO_AF; \
                                     keeping first"
                                ),
                            );
                        } else {
                            af_macro = specific_value(c, path, lint);
                        }
                    }
                    Some(other) => {
                        *skips
                            .entry(format!(
                                "RemapBlock SpecificParameter \"{other}\" (no IR field)"
                            ))
                            .or_default() += 1;
                    }
                    None => lint.warn(
                        path,
                        format!("{pin_name}/{signal}/{block}: SpecificParameter without Name"),
                    ),
                }
            }
            other => lint.warn(
                path,
                format!("{pin_name}/{signal}/{block}: unknown child <{other}>"),
            ),
        }
    }
    Some(RemapBlockRef {
        block: block.to_string(),
        default_remap,
        af_macro,
    })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Warn on any un-namespaced attribute not in `allowed` (namespaced ones like
/// `xsi:schemaLocation` are schema plumbing and skipped silently).
fn check_attrs(node: roxmltree::Node, allowed: &[&str], path: &Path, lint: &mut Lint) {
    for a in node.attributes() {
        if a.namespace().is_some() {
            continue;
        }
        if !allowed.contains(&a.name()) {
            lint.warn(
                path,
                format!(
                    "<{}>: unknown attribute {}=\"{}\"",
                    node.tag_name().name(),
                    a.name(),
                    a.value()
                ),
            );
        }
    }
}

fn parse_condition_child(
    node: roxmltree::Node,
    path: &Path,
    lint: &mut Lint,
) -> Option<DiagCondition> {
    check_attrs(node, &["Expression", "Diagnostic"], path, lint);
    let Some(src) = node.attribute("Expression") else {
        lint.warn(path, "<Condition> without Expression attribute");
        return None;
    };
    let diagnostic = node.attribute("Diagnostic").unwrap_or("").to_string();
    // Fail-closed: an unparseable guard is unsatisfiable, never dropped.
    Some(DiagCondition {
        condition: parse_condition_lenient(src, path, lint)
            .unwrap_or_else(stm32ck_ir::expr::unsatisfiable),
        diagnostic,
    })
}

/// First `<PossibleValue>` text child of a `<SpecificParameter>`.
fn specific_value(node: roxmltree::Node, path: &Path, lint: &mut Lint) -> Option<String> {
    let ctx = node.attribute("Name").unwrap_or("?");
    let mut value: Option<String> = None;
    for c in node.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "PossibleValue" => {
                if value.is_some() {
                    lint.warn(
                        path,
                        format!("SpecificParameter {ctx}: multiple PossibleValue; keeping first"),
                    );
                } else {
                    value = Some(trimmed_text(c));
                }
            }
            other => lint.warn(
                path,
                format!("SpecificParameter {ctx}: unknown child <{other}>"),
            ),
        }
    }
    if value.is_none() {
        lint.warn(path, format!("SpecificParameter {ctx}: no PossibleValue"));
    }
    value
}

fn trimmed_text(node: roxmltree::Node) -> String {
    node.text().unwrap_or("").trim().to_string()
}

fn parse_num_attr(
    node: roxmltree::Node,
    attr: &str,
    path: &Path,
    lint: &mut Lint,
) -> Option<Num> {
    let raw = node.attribute(attr)?;
    let n = parse_number(raw.trim());
    if n.is_none() {
        lint.warn(
            path,
            format!(
                "RefParameter {}: non-numeric {attr}=\"{raw}\"",
                node.attribute("Name").unwrap_or("?")
            ),
        );
    }
    n
}

// ---------------------------------------------------------------------------
// Tests (against the real CubeMX db when present)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_file(rel: &str) -> Option<(GpioIp, Lint)> {
        let db = crate::test_db()?;
        let path = db.join(rel);
        let xml = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        let mut lint = Lint::default();
        let ip = parse_gpio_ip(&xml, &path, &mut lint).expect("parse_gpio_ip");
        Some((ip, lint))
    }

    fn find_signal<'a>(ip: &'a GpioIp, pin: &str, signal: &str) -> &'a GpioPinSignal {
        ip.pins[pin]
            .signals
            .iter()
            .find(|s| s.signal == signal)
            .unwrap_or_else(|| panic!("{pin} has no signal {signal}"))
    }

    #[test]
    fn f446_af_style() {
        let Some((ip, lint)) = parse_file("mcu/IP/GPIO-STM32F446_gpio_v1_0_Modes.xml") else {
            eprintln!("skipping f446_af_style: CubeMX db not found");
            return;
        };
        assert_eq!(ip.version, "STM32F446_gpio_v1_0");

        // Document order preserved: GPIO_AF is the first RefParameter.
        assert_eq!(ip.ref_parameters[0].name, "GPIO_AF");
        assert!(!ip.ref_parameters[0].visible);
        assert_eq!(ip.ref_parameters[0].default_value, "null");
        let pupd = ip
            .ref_parameters
            .iter()
            .find(|p| p.name == "GPIO_PuPd")
            .unwrap();
        assert_eq!(pupd.default_value, "GPIO_NOPULL");
        assert!(pupd.visible);
        assert_eq!(pupd.possible_values.len(), 3);
        assert_eq!(pupd.possible_values[0].value, "GPIO_NOPULL");

        let afpp = ip
            .ref_modes
            .iter()
            .find(|m| m.name == "AlternateFunctionPushPull")
            .unwrap();
        assert_eq!(afpp.config_for_mode, vec!["AlternateFunction"]);
        let gm = afpp
            .parameters
            .iter()
            .find(|p| p.name == "GPIO_Mode")
            .unwrap();
        assert_eq!(gm.pinned_values, vec!["GPIO_MODE_AF_PP"]);
        assert!(!afpp.is_abstract && afpp.base_mode.is_none() && afpp.hal_mode.is_none());
        // Free (unpinned) parameter in the same mode.
        let gaf = afpp.parameters.iter().find(|p| p.name == "GPIO_AF").unwrap();
        assert!(gaf.pinned_values.is_empty());
        // Empty "System" mode survives.
        assert!(ip.ref_modes.iter().any(|m| m.name == "System"));

        let pa9 = &ip.pins["PA9"];
        assert_eq!(pa9.port, "PA");
        assert_eq!(pa9.pin_macro, "GPIO_PIN_9");
        assert_eq!(pa9.pin_source, None);
        match &find_signal(&ip, "PA9", "USART1_TX").binding {
            AfBinding::Af { macro_name } => assert_eq!(macro_name, "GPIO_AF7_USART1"),
            other => panic!("PA9 USART1_TX: expected Af binding, got {other:?}"),
        }

        // Only known IR gaps (GPIO_Port, pin GPIO_Speed presets) plus one
        // genuine db defect are linted; everything else is understood.
        // Db defect: PI8 is a leftover entry with only a GPIO_Speed preset
        // and no SpecificParameter GPIO_Pin (PI8 is not bonded on F446).
        for w in &lint.warnings {
            assert!(
                w.contains("no IR field") || w.contains("GPIO_Pin PI8: missing GPIO_Pin macro"),
                "unexpected lint: {w}"
            );
        }
        assert_eq!(ip.pins["PI8"].pin_macro, "");
    }

    #[test]
    fn f103_remap_style() {
        let Some((ip, lint)) = parse_file("mcu/IP/GPIO-STM32F103x8_gpio_v1_0_Modes.xml") else {
            eprintln!("skipping f103_remap_style: CubeMX db not found");
            return;
        };
        assert_eq!(ip.version, "STM32F103x8_gpio_v1_0");

        let pa9 = &ip.pins["PA9"];
        assert_eq!(pa9.port, "PA");
        assert_eq!(pa9.pin_macro, "GPIO_PIN_9");
        assert_eq!(pa9.pin_source.as_deref(), Some("AFIO_EVENTOUT_PIN_9"));

        // PA9 USART1_TX: default remap block only, no AFIO macro.
        match &find_signal(&ip, "PA9", "USART1_TX").binding {
            AfBinding::Remap { blocks } => {
                assert_eq!(blocks.len(), 1);
                assert_eq!(blocks[0].block, "USART1_REMAP0");
                assert!(blocks[0].default_remap);
                assert_eq!(blocks[0].af_macro, None);
            }
            other => panic!("PA9 USART1_TX: expected Remap binding, got {other:?}"),
        }
        // PA9 TIM1_CH2: two blocks in document order, second carries a macro.
        match &find_signal(&ip, "PA9", "TIM1_CH2").binding {
            AfBinding::Remap { blocks } => {
                assert_eq!(blocks.len(), 2);
                assert_eq!(blocks[0].block, "TIM1_REMAP0");
                assert!(blocks[0].default_remap && blocks[0].af_macro.is_none());
                assert_eq!(blocks[1].block, "TIM1_REMAP1");
                assert!(!blocks[1].default_remap);
                assert_eq!(
                    blocks[1].af_macro.as_deref(),
                    Some("__HAL_AFIO_REMAP_TIM1_PARTIAL")
                );
            }
            other => panic!("PA9 TIM1_CH2: expected Remap binding, got {other:?}"),
        }
        // PB6 USART1_TX: non-default block with the remap-enable macro.
        match &find_signal(&ip, "PB6", "USART1_TX").binding {
            AfBinding::Remap { blocks } => {
                assert_eq!(blocks.len(), 1);
                assert_eq!(blocks[0].block, "USART1_REMAP1");
                assert!(!blocks[0].default_remap);
                assert_eq!(
                    blocks[0].af_macro.as_deref(),
                    Some("__HAL_AFIO_REMAP_USART1_ENABLE")
                );
            }
            other => panic!("PB6 USART1_TX: expected Remap binding, got {other:?}"),
        }

        // F1 IO presets: InputPullUp pins GPIO_PuPd=GPIO_PULLUP, and every
        // non-empty RefMode participates in PinRemapConfig codegen ("System"
        // is the lone childless preset).
        let ipu = ip.ref_modes.iter().find(|m| m.name == "InputPullUp").unwrap();
        let pupd = ipu.parameters.iter().find(|p| p.name == "GPIO_PuPd").unwrap();
        assert_eq!(pupd.pinned_values, vec!["GPIO_PULLUP"]);
        for m in &ip.ref_modes {
            if m.name == "System" {
                assert!(m.config_for_mode.is_empty() && m.parameters.is_empty());
            } else {
                assert!(
                    m.config_for_mode.iter().any(|c| c == "PinRemapConfig"),
                    "RefMode {} lacks ConfigForMode PinRemapConfig",
                    m.name
                );
            }
        }

        for w in &lint.warnings {
            assert!(w.contains("no IR field"), "unexpected lint: {w}");
        }
    }

    /// Whole-db smoke: every GPIO-*_Modes.xml must parse, and the parser
    /// must fully understand the vocabulary (any lint besides known IR
    /// gaps and missing-pin-macro db defects fails the test).
    #[test]
    fn all_gpio_files_smoke() {
        let Some(db) = crate::test_db() else {
            eprintln!("skipping all_gpio_files_smoke: CubeMX db not found");
            return;
        };
        let mut n_files = 0usize;
        let mut surprises: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(db.join("mcu/IP")).expect("read_dir db/mcu/IP") {
            let path = entry.expect("dir entry").path();
            let fname = path.file_name().unwrap().to_string_lossy().to_string();
            if !fname.starts_with("GPIO-") || !fname.ends_with("_Modes.xml") {
                continue;
            }
            n_files += 1;
            let xml = std::fs::read_to_string(&path).expect("read gpio xml");
            let mut lint = Lint::default();
            let ip = parse_gpio_ip(&xml, &path, &mut lint).expect("parse_gpio_ip");
            assert!(!ip.pins.is_empty(), "{fname}: no pins parsed");
            for w in lint.warnings {
                if !w.contains("no IR field") && !w.contains("missing GPIO_Pin macro") {
                    surprises.push(w);
                }
            }
        }
        assert!(n_files > 90, "expected ~94 GPIO files, found {n_files}");
        assert!(
            surprises.is_empty(),
            "unexpected lints across db:\n{}",
            surprises.join("\n")
        );
    }

    /// No db needed: leniency on unknown structure and malformed conditions.
    #[test]
    fn lenient_on_unknown_structure() {
        let xml = r#"<IP Name="GPIO" Version="TEST_gpio" Bogus="1"
                         xmlns="http://mcd.rou.st.com/modules.php?name=mcu">
            <Wat/>
            <RefParameter Name="P" Comment="c" Type="list">
                <Condition Expression="A &amp; (" Diagnostic="d"/>
                <PossibleValue Value="V" Comment="2.5"/>
            </RefParameter>
            <GPIO_Pin PortName="PX" Name="PX0">
                <SpecificParameter Name="GPIO_Pin">
                    <PossibleValue>GPIO_PIN_0</PossibleValue>
                </SpecificParameter>
                <PinSignal Name="ADC1_IN0"/>
            </GPIO_Pin>
        </IP>"#;
        let mut lint = Lint::default();
        let ip = parse_gpio_ip(xml, Path::new("synthetic.xml"), &mut lint).unwrap();
        assert_eq!(ip.version, "TEST_gpio");
        // Malformed condition downgraded to lint; parameter kept, but its
        // guard becomes unsatisfiable rather than absent — an overload we
        // cannot evaluate must not silently become the unconditional one and
        // shadow the db's real fallback.
        let guard = ip.ref_parameters[0]
            .condition
            .as_ref()
            .expect("guard kept, not dropped");
        assert_eq!(guard.condition, stm32ck_ir::expr::unsatisfiable());
        // Numeric comment parsed as divider/multiplier factor.
        assert_eq!(
            ip.ref_parameters[0].possible_values[0].factor,
            parse_number("2.5")
        );
        // Signal without AF payload -> AfBinding::None.
        assert!(matches!(
            ip.pins["PX0"].signals[0].binding,
            AfBinding::None
        ));
        assert!(lint.warnings.iter().any(|w| w.contains("<Wat>")));
        assert!(lint.warnings.iter().any(|w| w.contains("Bogus")));
        assert!(lint
            .warnings
            .iter()
            .any(|w| w.contains("unparseable condition")));
    }
}
