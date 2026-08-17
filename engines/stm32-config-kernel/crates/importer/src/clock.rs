//! Clock-tree parser: `db/plugins/clock/<TreeId>.xml` -> [`ClockTree`].
//!
//! The file is a diagram description; we keep only the DAG semantics:
//! `<Tree>` sections (recursively flattened, document order) of `<Element>`
//! nodes wired by `<Input>`/`<Output>` edges, plus the `<Signals>` catalog
//! mapping signal ids to frequency RefParameter names.
//!
//! Deliberately ignored (pure diagram furniture, no semantics):
//!   - top-level `<Background>`, `<Label>`, `<BButton>` subtrees;
//!   - `<Clock savedConfig>` and `xsi:*` schema attributes;
//!   - `<Tree width/height/x/y>` and `<Element x/y/orientation>` layout;
//!   - `<Condition Diagnostic="">` empty diagnostic strings.
//!
//! The root `<Clock>` element carries no id/name in the shipped db, so the
//! tree id is taken from the file stem of `path`.

use std::collections::BTreeMap;
use std::path::Path;

use crate::{parse_condition_lenient, Lint};
use stm32ck_ir::expr::Condition;
use stm32ck_ir::model::{ClockEdge, ClockElement, ClockElementKind, ClockTree};

pub fn parse_clock_tree(
    xml: &str,
    path: &Path,
    lint: &mut Lint,
) -> anyhow::Result<ClockTree> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|e| anyhow::anyhow!("parsing {}: {e}", path.display()))?;
    let root = doc.root_element();
    if root.tag_name().name() != "Clock" {
        anyhow::bail!(
            "{}: root element is <{}>, expected <Clock>",
            path.display(),
            root.tag_name().name()
        );
    }

    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();

    let mut elements = Vec::new();
    let mut signals = BTreeMap::new();

    for child in root.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "Background" | "Label" | "BButton" => {}
            "Tree" => collect_tree(child, path, lint, &mut elements),
            "Signals" => collect_signals(child, path, lint, &mut signals),
            other => lint.warn(path, format!("unknown <Clock> child <{other}>")),
        }
    }

    Ok(ClockTree {
        id,
        elements,
        signals,
    })
}

/// Flatten one `<Tree>` (and nested sub-trees, e.g. `<Tree id="PLL">`) into
/// `out`, preserving document order.
fn collect_tree(
    node: roxmltree::Node,
    path: &Path,
    lint: &mut Lint,
    out: &mut Vec<ClockElement>,
) {
    for attr in node.attributes() {
        match attr.name() {
            // `id` is a diagram-section label; flattening drops it on purpose.
            "id" | "width" | "height" | "x" | "y" => {}
            // Data-bearing but unrepresentable after flattening (1 occurrence
            // in the whole db): surface it.
            "refEnable" => lint.warn(
                path,
                format!(
                    "<Tree id={:?}> refEnable={:?} lost by tree flattening",
                    node.attribute("id").unwrap_or(""),
                    attr.value()
                ),
            ),
            other => lint.warn(path, format!("unknown <Tree> attribute {other:?}")),
        }
    }

    for child in node.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "Element" => {
                if let Some(el) = parse_element(child, path, lint) {
                    out.push(el);
                }
            }
            "Tree" => collect_tree(child, path, lint, out),
            other => lint.warn(path, format!("unknown <Tree> child <{other}>")),
        }
    }
}

fn parse_element(
    node: roxmltree::Node,
    path: &Path,
    lint: &mut Lint,
) -> Option<ClockElement> {
    let id = match node.attribute("id") {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => {
            lint.warn(path, "<Element> without id: skipped");
            return None;
        }
    };
    let type_str = node.attribute("type").unwrap_or("");
    let kind = match parse_kind(type_str) {
        Some(k) => k,
        None => {
            lint.warn(
                path,
                format!("<Element id={id:?}> unknown type {type_str:?}: skipped"),
            );
            return None;
        }
    };

    let mut is_key = false;
    let mut ref_parameter = None;
    let mut ref_enable = Vec::new();
    for attr in node.attributes() {
        match attr.name() {
            "id" | "type" => {}
            // Layout, ignored on purpose.
            "x" | "y" | "orientation" => {}
            "refParameter" => {
                if !attr.value().is_empty() {
                    ref_parameter = Some(attr.value().to_string());
                }
            }
            "refEnable" => {
                ref_enable = attr
                    .value()
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
            }
            "isKey" => match attr.value() {
                "true" => is_key = true,
                "false" => {}
                other => lint.warn(
                    path,
                    format!("<Element id={id:?}> odd isKey value {other:?}"),
                ),
            },
            // Includes TrustZone/lock attrs (isTZRes, refSecure, refLock)
            // present in newer families; the IR has no slot for them.
            other => lint.warn(
                path,
                format!("<Element id={id:?}> unknown attribute {other:?}"),
            ),
        }
    }

    let mut condition: Option<Condition> = None;
    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    for child in node.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "Input" => {
                if let Some(e) = parse_edge(child, "from", &id, path, lint) {
                    inputs.push(e);
                }
            }
            "Output" => {
                if let Some(e) = parse_edge(child, "to", &id, path, lint) {
                    outputs.push(e);
                }
            }
            "Condition" => {
                // ClockElement.condition has no diagnostic slot; the db keeps
                // the Diagnostic attribute empty on clock elements — surface
                // the rare non-empty ones instead of dropping them silently.
                if let Some(diag) = child.attribute("Diagnostic") {
                    if !diag.is_empty() {
                        lint.warn(
                            path,
                            format!(
                                "<Element id={id:?}> condition diagnostic dropped: {diag:?}"
                            ),
                        );
                    }
                }
                let expr = child.attribute("Expression").unwrap_or("");
                // Fail-closed: an unparseable element guard disables the
                // element (CubeMX exception ⇒ false), it does not become
                // unconditional. Missing/empty stays unguarded.
                let parsed = if expr.trim().is_empty() {
                    None
                } else {
                    Some(
                        parse_condition_lenient(expr, path, lint)
                            .unwrap_or_else(stm32ck_ir::expr::unsatisfiable),
                    )
                };
                if condition.is_none() {
                    condition = parsed;
                } else if parsed.is_some() {
                    lint.warn(
                        path,
                        format!("<Element id={id:?}> extra <Condition> ignored"),
                    );
                }
            }
            other => lint.warn(
                path,
                format!("<Element id={id:?}> unknown child <{other}>"),
            ),
        }
    }

    Some(ClockElement {
        id,
        kind,
        ref_parameter,
        ref_enable,
        is_key,
        condition,
        inputs,
        outputs,
    })
}

fn parse_kind(s: &str) -> Option<ClockElementKind> {
    Some(match s {
        "fixedSource" => ClockElementKind::FixedSource,
        "variedSource" => ClockElementKind::VariedSource,
        "distinctValsSource" => ClockElementKind::DistinctValsSource,
        // sic — the db spells it "devisor".
        "devisor" => ClockElementKind::Divisor,
        "multiplicator" => ClockElementKind::Multiplicator,
        "multiplicatorFrac" => ClockElementKind::MultiplicatorFrac,
        "fractional" => ClockElementKind::Fractional,
        "multiplexor" => ClockElementKind::Multiplexor,
        "output" => ClockElementKind::Output,
        "activeOutput" => ClockElementKind::ActiveOutput,
        // Known-unmapped newer kinds: `pixelClockSource` (1 occurrence, LTDC)
        // and `xbar` (148, MP2/N6). IR has no variants for them yet; the
        // caller lints and skips — which drops the element AND its edges.
        _ => return None,
    })
}

/// `<Input signalId=.. from=.. [refValue=..]/>` or
/// `<Output signalId=.. to=.. [refValue=..]/>`; `peer_attr` is `from`/`to`.
fn parse_edge(
    node: roxmltree::Node,
    peer_attr: &str,
    element_id: &str,
    path: &Path,
    lint: &mut Lint,
) -> Option<ClockEdge> {
    let tag = node.tag_name().name().to_string();
    for attr in node.attributes() {
        match attr.name() {
            "signalId" | "refValue" => {}
            a if a == peer_attr => {}
            other => lint.warn(
                path,
                format!("<Element id={element_id:?}> <{tag}> unknown attribute {other:?}"),
            ),
        }
    }
    let signal_id = node.attribute("signalId");
    let peer = node.attribute(peer_attr);
    let (Some(signal_id), Some(peer)) = (signal_id, peer) else {
        lint.warn(
            path,
            format!("<Element id={element_id:?}> <{tag}> missing signalId/{peer_attr}: skipped"),
        );
        return None;
    };
    Some(ClockEdge {
        signal_id: signal_id.to_string(),
        peer: peer.to_string(),
        ref_value: node.attribute("refValue").map(str::to_string),
    })
}

fn collect_signals(
    node: roxmltree::Node,
    path: &Path,
    lint: &mut Lint,
    out: &mut BTreeMap<String, String>,
) {
    for attr in node.attributes() {
        lint.warn(
            path,
            format!("unknown <Signals> attribute {:?}", attr.name()),
        );
    }
    for child in node.children().filter(|n| n.is_element()) {
        if child.tag_name().name() != "Signal" {
            lint.warn(
                path,
                format!("unknown <Signals> child <{}>", child.tag_name().name()),
            );
            continue;
        }
        for attr in child.attributes() {
            match attr.name() {
                "id" | "refParameter" => {}
                other => lint.warn(
                    path,
                    format!("unknown <Signal> attribute {other:?}"),
                ),
            }
        }
        let Some(id) = child.attribute("id").filter(|v| !v.is_empty()) else {
            lint.warn(path, "<Signal> without id: skipped");
            continue;
        };
        // Missing refParameter attribute is normalized to "" (both forms
        // occur in the db and mean "no frequency parameter").
        let ref_param = child.attribute("refParameter").unwrap_or("").to_string();
        match out.get_mut(id) {
            None => {
                out.insert(id.to_string(), ref_param);
            }
            Some(existing) if *existing == ref_param => {} // exact dup: silent
            Some(existing) => {
                // Conflicting duplicates exist (H5 LSI, L0 SYSCLKOUT, ...):
                // prefer the non-empty binding, keep first otherwise.
                lint.warn(
                    path,
                    format!(
                        "duplicate <Signal id={id:?}> with conflicting refParameter \
                         ({existing:?} vs {ref_param:?})"
                    ),
                );
                if existing.is_empty() && !ref_param.is_empty() {
                    *existing = ref_param;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Parse `db/plugins/clock/<name>` from the real CubeMX db, or None
    /// (skip) when the db is not present on this machine.
    fn load(name: &str) -> Option<(ClockTree, Lint)> {
        let Some(db) = crate::test_db() else {
            eprintln!("skipping: CubeMX db not found (set STM32CK_CUBEMX_DB)");
            return None;
        };
        let path: PathBuf = db.join("plugins").join("clock").join(name);
        let xml = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        let mut lint = Lint::default();
        let tree = parse_clock_tree(&xml, &path, &mut lint).expect("parse_clock_tree");
        Some((tree, lint))
    }

    fn find<'a>(tree: &'a ClockTree, id: &str) -> &'a ClockElement {
        tree.elements
            .iter()
            .find(|e| e.id == id)
            .unwrap_or_else(|| panic!("element {id} not found"))
    }

    #[test]
    fn stm32f102_real_file() {
        let Some((tree, lint)) = load("STM32F102.xml") else {
            return;
        };
        assert_eq!(tree.id, "STM32F102");
        assert!(
            lint.warnings.is_empty(),
            "unexpected lint warnings: {:?}",
            lint.warnings
        );

        // System clock mux: 3 selectable inputs in document order.
        let mux = find(&tree, "SysClkSource");
        assert_eq!(mux.kind, ClockElementKind::Multiplexor);
        assert_eq!(mux.ref_parameter.as_deref(), Some("SYSCLKSource"));
        assert_eq!(mux.inputs.len(), 3);
        let ref_values: Vec<_> = mux
            .inputs
            .iter()
            .map(|e| e.ref_value.as_deref().unwrap())
            .collect();
        assert_eq!(
            ref_values,
            [
                "RCC_SYSCLKSOURCE_HSI",
                "RCC_SYSCLKSOURCE_HSE",
                "RCC_SYSCLKSOURCE_PLLCLK"
            ]
        );
        assert_eq!(mux.inputs[2].peer, "PLLMUL");
        assert_eq!(mux.inputs[2].signal_id, "PLLCLK");

        // HSE oscillator.
        let hse = find(&tree, "HSEOSC");
        assert_eq!(hse.kind, ClockElementKind::VariedSource);
        assert_eq!(hse.ref_parameter.as_deref(), Some("HSE_VALUE"));
        assert!(hse.outputs.len() >= 3, "HSEOSC outputs: {:?}", hse.outputs);
        assert_eq!(hse.ref_enable, ["EnableHSE"]);

        // APB1 prescaler + its active output.
        let apb1 = find(&tree, "APB1Prescaler");
        assert_eq!(apb1.kind, ClockElementKind::Divisor);
        assert_eq!(apb1.ref_parameter.as_deref(), Some("APB1CLKDivider"));
        let apb1_out = find(&tree, "APB1Output");
        assert_eq!(apb1_out.kind, ClockElementKind::ActiveOutput);
        assert_eq!(apb1_out.ref_parameter.as_deref(), Some("APB1Freq_Value"));

        // isKey survives.
        assert!(find(&tree, "HSIRC").is_key);

        // Conditional duplicates are all kept, in document order (the
        // VFQFPN36-guarded LSIRC comes first, the unconditioned fallback
        // second).
        let lsi: Vec<_> = tree.elements.iter().filter(|e| e.id == "LSIRC").collect();
        assert_eq!(lsi.len(), 2);
        assert!(lsi[0].condition.is_some());
        assert!(lsi[1].condition.is_none());

        // Nested <Tree id="PLL"> elements are flattened in.
        let pllmul = find(&tree, "PLLMUL");
        assert_eq!(pllmul.kind, ClockElementKind::Multiplicator);
        assert!(pllmul.outputs.iter().any(|o| o.peer == "SysClkSource"));

        // Signals catalog; refParameter-less entries normalize to "".
        assert_eq!(
            tree.signals.get("PLLCLK").map(String::as_str),
            Some("PLLCLKFreq_Value")
        );
        assert_eq!(tree.signals.get("HSI8").map(String::as_str), Some(""));
    }

    #[test]
    fn stm32f411_pll_chain() {
        let Some((tree, lint)) = load("STM32F411.xml") else {
            return;
        };
        assert_eq!(tree.id, "STM32F411");
        assert!(
            lint.warnings.is_empty(),
            "unexpected lint warnings: {:?}",
            lint.warnings
        );

        // PLLM divisor feeds PLLN multiplicator (PLLN lives in the nested
        // <Tree id="PLL">, so this also proves cross-subtree flattening).
        let pllm = find(&tree, "PLLM");
        assert_eq!(pllm.kind, ClockElementKind::Divisor);
        assert_eq!(pllm.ref_parameter.as_deref(), Some("PLLM"));
        assert!(pllm
            .outputs
            .iter()
            .any(|o| o.peer == "PLLN" && o.signal_id == "VCOInput"));
        let plln = find(&tree, "PLLN");
        assert_eq!(plln.kind, ClockElementKind::Multiplicator);
        assert_eq!(plln.ref_parameter.as_deref(), Some("PLLN"));
        assert!(plln.inputs.iter().any(|i| i.peer == "PLLM"));

        // Some mux input selects the PLL as sysclk source.
        assert!(tree.elements.iter().any(|e| {
            e.kind == ClockElementKind::Multiplexor
                && e.inputs
                    .iter()
                    .any(|i| i.ref_value.as_deref() == Some("RCC_SYSCLKSOURCE_PLLCLK"))
        }));
    }
}
