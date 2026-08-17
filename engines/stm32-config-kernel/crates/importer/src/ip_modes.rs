//! Generic IP `*_Modes.xml` parser (USART/ADC/TIM/RCC/DMA/NVIC/... all share
//! this shape), plus the NVIC packed-vector decoder layered on top of it.
//!
//! Layout/display-only attributes deliberately ignored without lint noise:
//! - `<IP>`: `IpGroup` (UI palette grouping), any namespaced attribute
//!   (`ns0:schemaLocation` schema plumbing).
//! - `<RefParameter>`: `Display` (UI value scaling, e.g. "value/1000000"),
//!   `TabName`, `Column`, `color` (pure UI layout).
//! - `<RefMode>`: `Group` (UI grouping), `Comment` (doc string) — the IR
//!   `RefMode` has no fields for these (contract mismatch, noted in report).

use crate::{parse_condition_lenient, Lint};
use roxmltree::Node;
use std::path::Path;
use stm32ck_ir::expr::parse_number;
use stm32ck_ir::model::{
    DiagCondition, IpDef, ModeNode, ModeOp, ModeParameter, ModeSignal, NvicVector, PossibleValue,
    PvAction, RefMode, RefParameter, RefSignal,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse one `db/mcu/IP/{Name}-{Version}_Modes.xml` document into an [`IpDef`].
pub fn parse_ip_def(xml: &str, path: &Path, lint: &mut Lint) -> anyhow::Result<IpDef> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|e| anyhow::anyhow!("parsing {}: {e}", path.display()))?;
    let root = doc.root_element();
    if root.tag_name().name() != "IP" {
        anyhow::bail!(
            "{}: root element is <{}>, expected <IP>",
            path.display(),
            root.tag_name().name()
        );
    }
    check_attrs(
        &root,
        &["Name", "Version", "IPType", "DBVersion", "IpGroup"],
        "<IP>",
        path,
        lint,
    );

    let mut ip = IpDef {
        name: req_attr(&root, "Name", "<IP>", path, lint),
        version: req_attr(&root, "Version", "<IP>", path, lint),
        ip_type: req_attr(&root, "IPType", "<IP>", path, lint),
        ref_parameters: Vec::new(),
        ref_modes: Vec::new(),
        mode_tree: None,
        ref_signals: Vec::new(),
        semaphores: Vec::new(),
    };

    for child in elements(&root) {
        match child.tag_name().name() {
            "About" => {} // human-readable IP description; no IR content
            "RefParameter" => ip.ref_parameters.push(parse_ref_parameter(&child, path, lint)),
            "RefMode" => ip.ref_modes.push(parse_ref_mode(&child, path, lint)),
            "ModeLogicOperator" => {
                let node = parse_mode_operator(&child, path, lint);
                if ip.mode_tree.is_some() {
                    lint.warn(path, "multiple top-level <ModeLogicOperator>; keeping first");
                } else {
                    ip.mode_tree = Some(node);
                }
            }
            "RefSignal" => ip.ref_signals.push(parse_ref_signal(&child, path, lint)),
            "Semaphore" => ip.semaphores.push(text_of(&child)),
            other => lint.warn(path, format!("unknown element <{other}> under <IP>")),
        }
    }
    Ok(ip)
}

/// Decode the packed `IRQn` records of an NVIC [`IpDef`] into [`NvicVector`]s.
///
/// Every `PossibleValue.value` of every `IRQn` RefParameter overload is a
/// 5-field record `IRQname:flags:owners:handlers:args` (document order kept).
pub fn parse_nvic_vectors(ip: &IpDef, path: &Path, lint: &mut Lint) -> Vec<NvicVector> {
    let mut out = Vec::new();
    for rp in ip.ref_parameters.iter().filter(|r| r.name == "IRQn") {
        for pv in &rp.possible_values {
            let mut fields = pv.value.splitn(5, ':');
            let irqn = fields.next().unwrap_or("").to_string();
            let flags_field = fields.next();
            if flags_field.is_none() {
                lint.warn(path, format!("IRQn record without `:` fields: `{}`", pv.value));
            }
            let flags_field = flags_field.unwrap_or("");
            let owners_field = fields.next().unwrap_or("");
            let handlers_field = fields.next().unwrap_or("");
            let args = fields.next().unwrap_or("").to_string();

            let mut flag_toks = flags_field.split(',');
            let user_enableable = match flag_toks.next().unwrap_or("") {
                "Y" => true,
                "N" => false,
                other => {
                    lint.warn(
                        path,
                        format!("IRQn `{irqn}`: first flag `{other}` is not Y/N; treating as N"),
                    );
                    false
                }
            };
            let flags = flag_toks
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .collect();

            out.push(NvicVector {
                irqn,
                comment: pv.comment.clone(),
                user_enableable,
                flags,
                owners: split_list(owners_field),
                handlers: split_list(handlers_field),
                args,
                condition: pv.condition.clone(),
            });
        }
    }
    out
}

/// Split a comma-list field; empty segments are dropped ("" -> []).
fn split_list(s: &str) -> Vec<String> {
    s.split(',')
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

// ---------------------------------------------------------------------------
// Element parsers
// ---------------------------------------------------------------------------

fn parse_ref_parameter(node: &Node, path: &Path, lint: &mut Lint) -> RefParameter {
    check_attrs(
        node,
        &[
            "Name", "Comment", "DefaultValue", "Type", "Group", "Min", "Max", "Unit", "Visible",
            // silently ignored layout attrs (see module doc):
            "Display", "TabName", "Column", "color",
        ],
        "<RefParameter>",
        path,
        lint,
    );
    let name = req_attr(node, "Name", "<RefParameter>", path, lint);
    let mut param = RefParameter {
        comment: attr_or_empty(node, "Comment"),
        default_value: attr_or_empty(node, "DefaultValue"),
        param_type: attr_or_empty(node, "Type"),
        min: parse_bound(node, "Min", &name, path, lint),
        max: parse_bound(node, "Max", &name, path, lint),
        unit: attr_or_empty(node, "Unit"),
        group: attr_or_empty(node, "Group"),
        visible: parse_bool(node, "Visible", true, path, lint),
        condition: None,
        possible_values: Vec::new(),
        name,
    };
    for child in elements(node) {
        match child.tag_name().name() {
            "Condition" => {
                // Unparseable guards are already unsatisfiable inside
                // parse_diag_condition (fail-closed).
                let cond = parse_diag_condition(&child, path, lint);
                if param.condition.is_some() {
                    lint.warn(
                        path,
                        format!(
                            "RefParameter `{}`: multiple <Condition>; keeping first",
                            param.name
                        ),
                    );
                } else {
                    param.condition = cond;
                }
            }
            "PossibleValue" => param
                .possible_values
                .push(parse_possible_value(&child, path, lint)),
            "Description" => {} // long-form help text; no IR content
            other => lint.warn(
                path,
                format!("unknown element <{other}> under <RefParameter>"),
            ),
        }
    }
    param
}

fn parse_possible_value(node: &Node, path: &Path, lint: &mut Lint) -> PossibleValue {
    check_attrs(
        node,
        &["Comment", "Value", "Semaphore", "Condition", "Action", "Diagnostic"],
        "<PossibleValue>",
        path,
        lint,
    );
    let comment = attr_or_empty(node, "Comment");
    // The db mixes cases ("Disable" in most files, "DISABLE" in the F4 ADC).
    let action = match node.attribute("Action") {
        None => None,
        Some(a) if a.eq_ignore_ascii_case("Disable") => Some(PvAction::Disable),
        Some(a) if a.eq_ignore_ascii_case("Remove") => Some(PvAction::Remove),
        Some(other) => {
            lint.warn(path, format!("PossibleValue Action=`{other}` unknown; ignoring"));
            None
        }
    };
    for child in elements(node) {
        lint.warn(
            path,
            format!(
                "unknown element <{}> under <PossibleValue>",
                child.tag_name().name()
            ),
        );
    }
    PossibleValue {
        value: req_attr(node, "Value", "<PossibleValue>", path, lint),
        factor: parse_number(comment.trim()),
        semaphore: node.attribute("Semaphore").map(str::to_string),
        // Fail-closed: an unparseable exclusion condition never fires, i.e.
        // the value stays available — CubeMX's exception ⇒ false.
        condition: node
            .attribute("Condition")
            .map(|src| {
                parse_condition_lenient(src, path, lint)
                    .unwrap_or_else(stm32ck_ir::expr::unsatisfiable)
            }),
        action,
        diagnostic: attr_or_empty(node, "Diagnostic"),
        comment,
    }
}

fn parse_ref_mode(node: &Node, path: &Path, lint: &mut Lint) -> RefMode {
    check_attrs(
        node,
        &[
            "Name", "Abstract", "BaseMode", "HalMode",
            // silently ignored (no IR fields; see module doc):
            "Group", "Comment",
        ],
        "<RefMode>",
        path,
        lint,
    );
    let mut mode = RefMode {
        name: req_attr(node, "Name", "<RefMode>", path, lint),
        is_abstract: parse_bool(node, "Abstract", false, path, lint),
        base_mode: node.attribute("BaseMode").map(str::to_string),
        hal_mode: node.attribute("HalMode").map(str::to_string),
        config_for_mode: Vec::new(),
        condition: None,
        parameters: Vec::new(),
        semaphores: Vec::new(),
    };
    for child in elements(node) {
        match child.tag_name().name() {
            "Condition" => {
                let cond = parse_diag_condition(&child, path, lint);
                if mode.condition.is_some() {
                    lint.warn(
                        path,
                        format!("RefMode `{}`: multiple <Condition>; keeping first", mode.name),
                    );
                } else {
                    mode.condition = cond;
                }
            }
            "ConfigForMode" => mode.config_for_mode.push(text_of(&child)),
            "Parameter" => mode.parameters.push(parse_mode_parameter(&child, path, lint)),
            "Semaphore" => mode.semaphores.push(text_of(&child)),
            other => lint.warn(path, format!("unknown element <{other}> under <RefMode>")),
        }
    }
    mode
}

fn parse_mode_parameter(node: &Node, path: &Path, lint: &mut Lint) -> ModeParameter {
    check_attrs(node, &["Name", "RefParameter"], "<Parameter>", path, lint);
    let name = req_attr(node, "Name", "<Parameter>", path, lint);
    // `Name` is the mode-local label, `RefParameter` the parameter it pins;
    // they differ in roughly half the db's pairs.
    let ref_parameter = node
        .attribute("RefParameter")
        .filter(|v| !v.is_empty() && *v != name)
        .map(str::to_string);
    let mut pinned_values = Vec::new();
    let mut condition = None;
    for child in elements(node) {
        match child.tag_name().name() {
            // Pinned value is element *text* here, unlike RefParameter's
            // attribute form: <PossibleValue>VM_ASYNC</PossibleValue>.
            "PossibleValue" => pinned_values.push(text_of(&child)),
            // "pin this value only while the guard holds"; an unparseable
            // guard is unsatisfiable via parse_diag_condition (fail-closed),
            // and a missing Expression stays a never-holding guard here.
            "Condition" => {
                let parsed = parse_diag_condition(&child, path, lint)
                    .map(|dc| dc.condition)
                    .unwrap_or_else(stm32ck_ir::expr::unsatisfiable);
                if condition.is_none() {
                    condition = Some(parsed);
                } else {
                    lint.warn(
                        path,
                        format!("RefMode Parameter `{name}`: multiple <Condition>; keeping first"),
                    );
                }
            }
            // Rare; the IR ModeParameter has no semaphore field (contract
            // mismatch) — surface the drop instead of silently losing it.
            "Semaphore" => lint.warn(
                path,
                format!("RefMode Parameter `{name}`: <Semaphore> dropped (no IR field)"),
            ),
            other => lint.warn(
                path,
                format!("unknown element <{other}> under RefMode <Parameter>"),
            ),
        }
    }
    ModeParameter {
        name,
        pinned_values,
        ref_parameter,
        condition,
    }
}

fn parse_mode_operator(node: &Node, path: &Path, lint: &mut Lint) -> ModeNode {
    check_attrs(node, &["Name"], "<ModeLogicOperator>", path, lint);
    let op = match node.attribute("Name") {
        Some("OR") => ModeOp::Or,
        Some("XOR") => ModeOp::Xor,
        other => {
            lint.warn(
                path,
                format!("ModeLogicOperator Name={other:?} unknown; treating as OR"),
            );
            ModeOp::Or
        }
    };
    let mut children = Vec::new();
    for child in elements(node) {
        match child.tag_name().name() {
            "Mode" => children.push(parse_mode(&child, path, lint)),
            other => lint.warn(
                path,
                format!("unknown element <{other}> under <ModeLogicOperator>"),
            ),
        }
    }
    ModeNode::Operator { op, children }
}

fn parse_mode(node: &Node, path: &Path, lint: &mut Lint) -> ModeNode {
    check_attrs(node, &["Name", "UserName", "RemoveCondition"], "<Mode>", path, lint);
    let name = req_attr(node, "Name", "<Mode>", path, lint);
    let mut conditions = Vec::new();
    let mut signals = Vec::new();
    let mut semaphores = Vec::new();
    let mut children = Vec::new();
    for child in elements(node) {
        match child.tag_name().name() {
            // A nested operator becomes exactly one Operator child node.
            "ModeLogicOperator" => children.push(parse_mode_operator(&child, path, lint)),
            "SignalLogicalOp" => {
                check_attrs(&child, &["Name"], "<SignalLogicalOp>", path, lint);
                match child.attribute("Name") {
                    Some("AND") => {}
                    other => lint.warn(
                        path,
                        format!("SignalLogicalOp Name={other:?}, expected AND"),
                    ),
                }
                for sig in elements(&child) {
                    match sig.tag_name().name() {
                        "Signal" => {
                            check_attrs(&sig, &["Name", "IOMode", "Direction"], "<Signal>", path, lint);
                            signals.push(ModeSignal {
                                name: req_attr(&sig, "Name", "<Signal>", path, lint),
                                io_mode: sig.attribute("IOMode").map(str::to_string),
                                direction: sig.attribute("Direction").map(str::to_string),
                            });
                        }
                        other => lint.warn(
                            path,
                            format!("unknown element <{other}> under <SignalLogicalOp>"),
                        ),
                    }
                }
            }
            "Condition" => conditions.extend(parse_diag_condition(&child, path, lint)),
            "Semaphore" => semaphores.push(text_of(&child)),
            other => lint.warn(path, format!("unknown element <{other}> under <Mode>")),
        }
    }
    ModeNode::Mode {
        // None-on-parse-failure is fail-closed HERE: no RemoveCondition ==
        // CubeMX evaluating it false == the node is never removed.
        remove_condition: node
            .attribute("RemoveCondition")
            .and_then(|src| parse_condition_lenient(src, path, lint)),
        user_name: node.attribute("UserName").map(str::to_string),
        name,
        conditions,
        signals,
        semaphores,
        children,
    }
}

fn parse_ref_signal(node: &Node, path: &Path, lint: &mut Lint) -> RefSignal {
    check_attrs(
        node,
        &["Name", "IOMode", "Virtual", "Direction", "ShareableGroupName", "ExclusiveGroupName"],
        "<RefSignal>",
        path,
        lint,
    );
    RefSignal {
        name: req_attr(node, "Name", "<RefSignal>", path, lint),
        io_mode: node.attribute("IOMode").map(str::to_string),
        virtual_signal: parse_bool(node, "Virtual", false, path, lint),
        direction: node.attribute("Direction").map(str::to_string),
        shareable_group: node.attribute("ShareableGroupName").map(str::to_string),
        exclusive_group: node.attribute("ExclusiveGroupName").map(str::to_string),
    }
}

/// `<Condition Expression Diagnostic/>` -> DiagCondition. None only when the
/// Expression attribute is MISSING (CubeMX treats a null condition as true =
/// unguarded). A present-but-unparseable expression becomes an unsatisfiable
/// condition — CubeMX catches the ParserException and evaluates false
/// (LogicalParser.checkCondition), and "guard we could not read" must never
/// widen into "no guard". F3's APB1 window was the live case: its first
/// overload is guarded by `((SYSCLKFreq_VALUE/2) < 10000000)`, and treating
/// a failed parse as unconditional pinned APB1's minimum at 10 MHz for every
/// F3 configuration.
fn parse_diag_condition(node: &Node, path: &Path, lint: &mut Lint) -> Option<DiagCondition> {
    check_attrs(node, &["Expression", "Diagnostic"], "<Condition>", path, lint);
    let Some(src) = node.attribute("Expression") else {
        lint.warn(path, "<Condition> without Expression attribute");
        return None;
    };
    let condition = parse_condition_lenient(src, path, lint)
        .unwrap_or_else(stm32ck_ir::expr::unsatisfiable);
    Some(DiagCondition {
        condition,
        diagnostic: attr_or_empty(node, "Diagnostic"),
    })
}

// ---------------------------------------------------------------------------
// Small lenient-parsing helpers
// ---------------------------------------------------------------------------

fn elements<'a, 'i>(node: &Node<'a, 'i>) -> impl Iterator<Item = Node<'a, 'i>> {
    node.children().filter(|c| c.is_element())
}

/// Required attribute: missing -> lint + empty string (never fail).
fn req_attr(node: &Node, name: &str, what: &str, path: &Path, lint: &mut Lint) -> String {
    match node.attribute(name) {
        Some(v) => v.to_string(),
        None => {
            lint.warn(path, format!("{what} missing `{name}` attribute"));
            String::new()
        }
    }
}

fn attr_or_empty(node: &Node, name: &str) -> String {
    node.attribute(name).unwrap_or("").to_string()
}

/// "true"/"false" attribute with a default; anything else lints.
fn parse_bool(node: &Node, name: &str, default: bool, path: &Path, lint: &mut Lint) -> bool {
    match node.attribute(name) {
        None => default,
        Some("true") => true,
        Some("false") => false,
        Some(other) => {
            lint.warn(path, format!("attribute {name}=`{other}` is not true/false"));
            default
        }
    }
}

/// Min/Max attribute -> exact rational; unparseable -> lint + None.
fn parse_bound(
    node: &Node,
    name: &str,
    param: &str,
    path: &Path,
    lint: &mut Lint,
) -> Option<stm32ck_ir::expr::Num> {
    let src = node.attribute(name)?;
    let n = parse_number(src.trim());
    if n.is_none() {
        lint.warn(
            path,
            format!("RefParameter `{param}`: non-numeric {name}=`{src}`"),
        );
    }
    n
}

fn text_of(node: &Node) -> String {
    node.text().unwrap_or("").trim().to_string()
}

/// Warn about attributes outside `known` (namespaced attrs like
/// `ns0:schemaLocation` are schema plumbing and skipped silently).
fn check_attrs(node: &Node, known: &[&str], what: &str, path: &Path, lint: &mut Lint) {
    for a in node.attributes() {
        if a.namespace().is_some() {
            continue;
        }
        if !known.contains(&a.name()) {
            lint.warn(path, format!("{what}: unknown attribute `{}`", a.name()));
        }
    }
}

// ---------------------------------------------------------------------------
// Tests against the real CubeMX db (skipped when the db is absent)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use stm32ck_ir::expr::Num;

    fn load(rel: &str) -> Option<(IpDef, Lint)> {
        let Some(db) = crate::test_db() else {
            eprintln!("skipping {rel}: CubeMX db not found");
            return None;
        };
        let path = db.join(rel);
        let xml = crate::read_text(&path).expect("read xml");
        let mut lint = Lint::default();
        let ip = parse_ip_def(&xml, &path, &mut lint).expect("parse_ip_def");
        Some((ip, lint))
    }

    /// A RefMode `<Parameter>` pins a value on the parameter its
    /// `RefParameter` attribute names, not on its own `Name` — the two differ
    /// in about half the db's pairs — and a child `<Condition>` gates the pin.
    /// Reading only `Name` loses the pin with nothing to show for it.
    #[test]
    fn mode_parameter_keeps_redirect_and_guard() {
        let xml = r#"<IP Name="T" Version="v1"
                         xmlns="http://mcd.rou.st.com/modules.php?name=mcu">
            <RefMode Name="M" BaseMode="">
                <Parameter Name="ADC1_Secure" RefParameter="IP_Secure">
                    <PossibleValue>SECURE</PossibleValue>
                    <Condition Expression="TZEN" Diagnostic="d"/>
                </Parameter>
                <Parameter Name="Plain">
                    <PossibleValue>V</PossibleValue>
                </Parameter>
                <Parameter Name="Broken" RefParameter="X">
                    <PossibleValue>V</PossibleValue>
                    <Condition Expression="A &amp; (" Diagnostic="d"/>
                </Parameter>
            </RefMode>
        </IP>"#;
        let mut lint = Lint::default();
        let ip = parse_ip_def(xml, Path::new("synthetic.xml"), &mut lint).unwrap();
        let params = &ip.ref_modes[0].parameters;

        let redirected = &params[0];
        assert_eq!(redirected.name, "ADC1_Secure");
        assert_eq!(redirected.target(), "IP_Secure", "pin follows RefParameter");
        assert!(redirected.condition.is_some(), "guard kept");

        // No redirect attribute -> the name is the target.
        assert_eq!(params[1].target(), "Plain");
        assert!(params[1].condition.is_none());

        // An unparseable guard is unsatisfiable, never unconditional.
        assert_eq!(
            params[2].condition.as_ref().unwrap(),
            &stm32ck_ir::expr::unsatisfiable()
        );
    }

    fn find_mode<'a>(node: &'a ModeNode, want: &str) -> Option<&'a ModeNode> {
        match node {
            ModeNode::Operator { children, .. } => {
                children.iter().find_map(|c| find_mode(c, want))
            }
            ModeNode::Mode { name, children, .. } => {
                if name == want {
                    Some(node)
                } else {
                    children.iter().find_map(|c| find_mode(c, want))
                }
            }
        }
    }

    #[test]
    fn usart_sci2_v1_1_cube() {
        let Some((ip, lint)) = load("mcu/IP/USART-sci2_v1_1_Cube_Modes.xml") else {
            return;
        };
        assert_eq!(ip.name, "USART");
        assert_eq!(ip.version, "sci2_v1_1_Cube");
        assert_eq!(ip.ip_type, "peripheral");
        assert!(
            lint.warnings.is_empty(),
            "expected clean parse, got: {:?}",
            lint.warnings
        );

        // BaudRate: single overload, Max=10500000, Min=110.
        let baud = ip
            .ref_parameters
            .iter()
            .find(|p| p.name == "BaudRate")
            .expect("BaudRate");
        assert_eq!(baud.max, Some(Num::from_integer(10_500_000)));
        assert_eq!(baud.min, Some(Num::from_integer(110)));
        assert_eq!(baud.param_type, "integer");
        assert_eq!(baud.unit, "Bits/s");

        // WordLength: condition-ordered overloads with distinct guards,
        // last one unconditioned (the fallback).
        let wl: Vec<_> = ip
            .ref_parameters
            .iter()
            .filter(|p| p.name == "WordLength")
            .collect();
        assert!(wl.len() >= 2, "expected >=2 WordLength overloads, got {}", wl.len());
        let c0 = &wl[0].condition.as_ref().expect("first overload guarded").condition;
        let c1 = &wl[1].condition.as_ref().expect("second overload guarded").condition;
        assert_ne!(c0, c1, "overload guards must differ");
        assert!(wl.last().unwrap().condition.is_none(), "fallback is unconditioned");

        // RefMode Asynchronous.
        let m = ip
            .ref_modes
            .iter()
            .find(|m| m.name == "Asynchronous")
            .expect("RefMode Asynchronous");
        assert_eq!(m.base_mode.as_deref(), Some("usartBasic"));
        assert_eq!(m.hal_mode.as_deref(), Some("UART"));
        assert!(!m.is_abstract);
        assert!(m.config_for_mode.iter().any(|c| c == "Uart_Init"));
        let vm = m
            .parameters
            .iter()
            .find(|p| p.name == "VirtualMode")
            .expect("VirtualMode parameter");
        assert_eq!(vm.pinned_values, vec!["VM_ASYNC".to_string()]);

        // usartBasic is abstract.
        let basic = ip.ref_modes.iter().find(|m| m.name == "usartBasic").unwrap();
        assert!(basic.is_abstract);

        // Mode tree leaf "Asynchronous": signals RX + TX (TX IOMode
        // override), semaphores include the instance macro.
        let tree = ip.mode_tree.as_ref().expect("mode tree");
        let leaf = find_mode(tree, "Asynchronous").expect("leaf Mode Asynchronous");
        let ModeNode::Mode { signals, semaphores, children, .. } = leaf else {
            panic!("expected Mode node");
        };
        assert!(children.is_empty(), "Asynchronous is a leaf");
        let names: Vec<&str> = signals.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["RX", "TX"]);
        assert_eq!(signals[0].io_mode, None);
        assert_eq!(
            signals[1].io_mode.as_deref(),
            Some("AlternateFunctionPushPullPULLUP")
        );
        assert!(semaphores.iter().any(|s| s == "$IpInstance_Asynchronous"));

        // RefSignal catalog default for RX.
        let rx = ip.ref_signals.iter().find(|s| s.name == "RX").expect("RefSignal RX");
        assert_eq!(rx.io_mode.as_deref(), Some("InputFloatingAndPullUp"));
        assert!(!rx.virtual_signal);
    }

    #[test]
    fn nvic_stm32f103g_vectors() {
        let Some((ip, mut lint)) = load("mcu/IP/NVIC-STM32F103G_Modes.xml") else {
            return;
        };
        assert_eq!(ip.name, "NVIC");
        assert_eq!(ip.ip_type, "service");
        assert!(ip.mode_tree.is_none(), "NVIC is a pure parameter service");
        assert!(
            lint.warnings.is_empty(),
            "expected clean parse, got: {:?}",
            lint.warnings
        );

        let path = std::path::PathBuf::from("NVIC-STM32F103G_Modes.xml");
        let vectors = parse_nvic_vectors(&ip, &path, &mut lint);
        assert!(
            lint.warnings.is_empty(),
            "expected clean vector decode, got: {:?}",
            lint.warnings
        );
        assert!(vectors.len() > 50, "got {} vectors", vectors.len());

        // EXTI9_5: 5 owners, shared HAL handler, "5,9" args.
        let e = vectors.iter().find(|v| v.irqn == "EXTI9_5_IRQn").expect("EXTI9_5_IRQn");
        assert_eq!(e.owners, ["EXTI5", "EXTI6", "EXTI7", "EXTI8", "EXTI9"]);
        assert_eq!(e.handlers, ["HAL_GPIO_EXTI_IRQHandler"]);
        assert_eq!(e.args, "5,9");
        assert!(e.user_enableable);
        assert_eq!(e.flags, ["EXTI"]);
        assert!(e.condition.is_none());

        // USART1: enableable, one owner, no handlers, empty args.
        let u = vectors.iter().find(|v| v.irqn == "USART1_IRQn").expect("USART1_IRQn");
        assert!(u.user_enableable);
        assert_eq!(u.owners, ["USART1"]);
        assert!(u.handlers.is_empty());
        assert!(u.flags.is_empty());
        assert_eq!(u.args, "");

        // Shared-vector variant guarded by a device condition.
        let adc = vectors.iter().find(|v| v.irqn == "ADC1_2_IRQn").expect("ADC1_2_IRQn");
        assert!(adc.condition.is_some(), "ADC1_2_IRQn is device-conditional");
        assert_eq!(adc.owners, ["ADC1", "ADC2"]);
        assert_eq!(adc.flags, ["2V1"]);

        // HardFault is not user-enableable (N flag).
        let hf = vectors.iter().find(|v| v.irqn == "HardFault_IRQn").expect("HardFault_IRQn");
        assert!(!hf.user_enableable);
        assert_eq!(hf.flags, ["W1"]);
    }

    #[test]
    fn rcc_stm32f102_overloads_and_factors() {
        let Some((ip, _lint)) = load("mcu/IP/RCC-STM32F102_rcc_v1_0_Modes.xml") else {
            return;
        };
        assert_eq!(ip.name, "RCC");

        // HSE_VALUE: bypass overload (25 MHz cap) then crystal fallback
        // (16 MHz cap), first-match-wins document order.
        let hse: Vec<_> = ip
            .ref_parameters
            .iter()
            .filter(|p| p.name == "HSE_VALUE")
            .collect();
        assert_eq!(hse.len(), 2, "expected exactly 2 HSE_VALUE overloads");
        let guard = hse[0].condition.as_ref().expect("first overload guarded by HSEByPass");
        assert_eq!(guard.diagnostic, "HSE in bypass Mode");
        assert_eq!(hse[0].max, Some(Num::from_integer(25_000_000)));
        assert!(hse[1].condition.is_none());
        assert_eq!(hse[1].max, Some(Num::from_integer(16_000_000)));

        // PLLMUL: numeric comments parsed as multiplier factors 2..=16.
        let pllmul = ip.ref_parameters.iter().find(|p| p.name == "PLLMUL").expect("PLLMUL");
        for k in 2..=16 {
            assert!(
                pllmul
                    .possible_values
                    .iter()
                    .any(|pv| pv.factor == Some(Num::from_integer(k))),
                "PLLMUL missing factor {k}"
            );
        }

        // USBPrescaler: fractional divider 1.5 kept exact as 3/2.
        let usb = ip
            .ref_parameters
            .iter()
            .find(|p| p.name == "USBPrescaler")
            .expect("USBPrescaler");
        assert!(
            usb.possible_values.iter().any(|pv| pv.factor == Some(Num::new(3, 2))),
            "USBPrescaler missing 1.5 factor"
        );
    }
}
