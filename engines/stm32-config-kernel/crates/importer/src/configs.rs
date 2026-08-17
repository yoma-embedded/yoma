//! Parser for HAL call-tree files: `db/mcu/config/*_Configs.xml`.
//!
//! Root element is `<IP>` (same tag as the `*_Modes.xml` IP defs, different
//! schema). Children of interest:
//!
//! * `<RefConfig Name>` — codegen call sequence referenced from RefMode
//!   `ConfigForMode` entries. Contains `<CallLibMethod>` (with `<MethodArg>`
//!   bindings), `<ImplementCallBack>`, and `<IFCondition Expression>` wrappers
//!   which may hold an `<Else>` branch (e.g. I2S custom audio frequency).
//! * `<LibMethod Name>` — method signature as a recursive `<Argument>` tree.
//!
//! `ReturnHAL` lives on *call sites* in the db (`CallLibMethod`), never on
//! `LibMethod`; values observed: `"false"`, `"true"`, `"HAL_OK"`. All three are
//! propagated verbatim onto the named [`LibMethod::return_hal`],
//! first-match-wins on conflict; `None` therefore means the db carries no
//! `ReturnHAL` for the method at all, which CubeMX reads as "guarded".
//!
//! Driver-file / CMSIS-pack component metadata (`<RefComponent>`, `<File>`,
//! `<Component>`, `<ConfigFile>`, `<RefConfigFile>`, `<RefBspComponent>`,
//! `<SubComponent>`) carries no call-tree semantics and is skipped with one
//! aggregate lint note per element kind.
//!
//! Deliberately ignored without lint (metadata / redundant with other data):
//! * `IP@DBVersion`, `IP@Name`, `IP@Version`, namespaced `schemaLocation`
//!   (identity comes from the file name; version from package.xml)
//! * `RefConfig@Comment`, `LibMethod@Comment`, `Argument@Comment` (human doc)
//! * `CallLibMethod@Type` (always `"HAL"` in the db)
//! * `LibMethod@Optimizable` (redundant: per-field `OptimizationCondition`
//!   attributes carry the actual optimization semantics)

use crate::{parse_condition_lenient, Lint};
use std::collections::BTreeMap;
use std::path::Path;
use stm32ck_ir::expr::{Condition, Expr};
use stm32ck_ir::model::{ConfigCall, ConfigDef, LibMethod, MethodArgument, RefConfig};

/// Per-file parse context: lint sink plus aggregate counters so that
/// high-frequency irregularities surface as one warning each, not hundreds.
struct Cx<'a> {
    path: &'a Path,
    lint: &'a mut Lint,
    /// Skipped metadata element kinds -> occurrence count.
    skipped_kinds: BTreeMap<String, usize>,
    /// `Argument` attributes with no IR field -> occurrence count.
    unmapped_arg_attrs: BTreeMap<String, usize>,
    /// One note per file for literal (`Value`/`FValue`) MethodArg bindings.
    literal_binding_noted: bool,
}

impl Cx<'_> {
    fn warn(&mut self, msg: impl AsRef<str>) {
        self.lint.warn(self.path, msg);
    }
}

/// Parse one `*_Configs.xml` document into a [`ConfigDef`].
pub fn parse_config_def(xml: &str, path: &Path, lint: &mut Lint) -> anyhow::Result<ConfigDef> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|e| anyhow::anyhow!("parsing {}: {e}", path.display()))?;
    let mut cx = Cx {
        path,
        lint,
        skipped_kinds: BTreeMap::new(),
        unmapped_arg_attrs: BTreeMap::new(),
        literal_binding_noted: false,
    };

    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let name = match stem.strip_suffix("_Configs") {
        Some(n) => n.to_string(),
        None => {
            cx.warn(format!("file stem `{stem}` lacks `_Configs` suffix"));
            stem.to_string()
        }
    };

    let root = doc.root_element();
    if root.tag_name().name() != "IP" {
        cx.warn(format!(
            "unexpected root element <{}> (expected <IP>)",
            root.tag_name().name()
        ));
    }
    check_ip_attrs(root, &mut cx);

    let mut def = ConfigDef {
        name,
        ref_configs: BTreeMap::new(),
        lib_methods: BTreeMap::new(),
    };
    // (method, ReturnHAL) recorded at call sites, applied after all
    // LibMethods are parsed (call sites precede definitions in the files).
    let mut call_returns: Vec<(String, String)> = Vec::new();

    for child in root.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "RefConfig" => {
                if let Some(rc) = parse_ref_config(child, &mut cx, &mut call_returns) {
                    if def.ref_configs.contains_key(&rc.name) {
                        cx.warn(format!("duplicate RefConfig `{}`; keeping first", rc.name));
                    } else {
                        def.ref_configs.insert(rc.name.clone(), rc);
                    }
                }
            }
            "LibMethod" => {
                if let Some(lm) = parse_lib_method(child, &mut cx) {
                    if def.lib_methods.contains_key(&lm.name) {
                        cx.warn(format!("duplicate LibMethod `{}`; keeping first", lm.name));
                    } else {
                        def.lib_methods.insert(lm.name.clone(), lm);
                    }
                }
            }
            k if is_metadata_kind(k) => {
                *cx.skipped_kinds.entry(k.to_string()).or_insert(0) += 1;
            }
            other => cx.warn(format!("unknown element <{other}> under <IP>")),
        }
    }

    // Propagate call-site ReturnHAL onto method definitions.
    for (method, value) in call_returns {
        match def.lib_methods.get_mut(&method) {
            Some(lm) => match &lm.return_hal {
                None => lm.return_hal = Some(value),
                Some(prev) if *prev != value => cx.warn(format!(
                    "conflicting ReturnHAL for `{method}`: `{prev}` vs `{value}`; keeping first"
                )),
                Some(_) => {}
            },
            None => cx.warn(format!(
                "CallLibMethod `{method}` has ReturnHAL=`{value}` but no LibMethod definition"
            )),
        }
    }

    // Flush aggregate counters as single lint notes.
    let skipped = std::mem::take(&mut cx.skipped_kinds);
    for (kind, n) in skipped {
        cx.warn(format!(
            "skipped {n} <{kind}> element(s): driver/component file metadata not mapped to IR"
        ));
    }
    let unmapped = std::mem::take(&mut cx.unmapped_arg_attrs);
    for (attr, n) in unmapped {
        cx.warn(format!(
            "Argument attribute `{attr}` ({n} occurrence(s)) has no IR field; dropped"
        ));
    }

    Ok(def)
}

/// Element kinds carrying driver-file / middleware-component metadata that
/// the IR does not model (may appear under `<IP>` or inside `<RefConfig>`).
fn is_metadata_kind(name: &str) -> bool {
    matches!(
        name,
        "RefComponent"
            | "RefBspComponent"
            | "Component"
            | "SubComponent"
            | "ConfigFile"
            | "RefConfigFile"
            | "File"
    )
}

fn check_ip_attrs(root: roxmltree::Node<'_, '_>, cx: &mut Cx) {
    for a in root.attributes() {
        if a.namespace().is_some() {
            continue; // ns0:schemaLocation
        }
        match a.name() {
            "DBVersion" | "Name" | "Version" => {}
            k @ ("IncludeFile" | "CodeTemplate" | "RootFolder") => {
                // Codegen-relevant, but ConfigDef has no field for it.
                cx.warn(format!("IP@{k}=`{}` has no IR field; dropped", a.value()));
            }
            other => cx.warn(format!("unknown IP attribute `{other}`")),
        }
    }
}

fn parse_ref_config(
    node: roxmltree::Node<'_, '_>,
    cx: &mut Cx,
    call_returns: &mut Vec<(String, String)>,
) -> Option<RefConfig> {
    let mut name = None;
    for a in node.attributes() {
        if a.namespace().is_some() {
            continue;
        }
        match a.name() {
            "Name" => name = Some(a.value().to_string()),
            "Comment" => {}
            other => cx.warn(format!("unknown RefConfig attribute `{other}`")),
        }
    }
    let Some(name) = name else {
        cx.warn("RefConfig without Name; skipped");
        return None;
    };
    let mut rc = RefConfig {
        name,
        calls: Vec::new(),
        callbacks: Vec::new(),
    };
    collect_items(node, None, &mut rc, cx, call_returns);
    Some(rc)
}

/// Walk direct element children of `node` (a RefConfig, IFCondition "then"
/// scope, or Else) collecting calls/callbacks under condition `cond`.
fn collect_items(
    node: roxmltree::Node<'_, '_>,
    cond: Option<&Condition>,
    rc: &mut RefConfig,
    cx: &mut Cx,
    call_returns: &mut Vec<(String, String)>,
) {
    for child in node.children().filter(|n| n.is_element()) {
        collect_item(child, cond, rc, cx, call_returns);
    }
}

fn collect_item(
    child: roxmltree::Node<'_, '_>,
    cond: Option<&Condition>,
    rc: &mut RefConfig,
    cx: &mut Cx,
    call_returns: &mut Vec<(String, String)>,
) {
    match child.tag_name().name() {
        "CallLibMethod" => {
            if let Some(call) = parse_call(child, cond, cx, call_returns) {
                rc.calls.push(call);
            }
        }
        "ImplementCallBack" => {
            let mut name = None;
            for a in child.attributes() {
                if a.namespace().is_some() {
                    continue;
                }
                match a.name() {
                    "Name" => name = Some(a.value().to_string()),
                    other => cx.warn(format!("unknown ImplementCallBack attribute `{other}`")),
                }
            }
            match name {
                Some(n) => {
                    if cond.is_some() {
                        cx.warn(format!(
                            "conditional ImplementCallBack `{n}` not representable in IR; \
                             recorded unconditionally"
                        ));
                    }
                    rc.callbacks.push(n);
                }
                None => cx.warn("ImplementCallBack without Name; skipped"),
            }
        }
        "IFCondition" => {
            let mut expr_src = None;
            for a in child.attributes() {
                if a.namespace().is_some() {
                    continue;
                }
                match a.name() {
                    "Expression" => expr_src = Some(a.value()),
                    other => cx.warn(format!("unknown IFCondition attribute `{other}`")),
                }
            }
            let branch = match expr_src {
                // Fail-closed: an unparseable IFCondition guard becomes
                // unsatisfiable — the Then branch never emits and Else (its
                // negation, Not(0) = always) does, matching CubeMX's caught
                // ParserException ⇒ condition false ⇒ Else. The old None
                // left BOTH branches unconditional: double emission.
                Some(src) => Some(
                    parse_condition_lenient(src, cx.path, cx.lint)
                        .unwrap_or_else(stm32ck_ir::expr::unsatisfiable),
                ),
                None => {
                    cx.warn("IFCondition without Expression; treated as unconditional");
                    None
                }
            };
            let then_cond = and_conditions(cond, branch.as_ref(), cx);
            for g in child.children().filter(|n| n.is_element()) {
                if g.tag_name().name() == "Else" {
                    let neg = negate_condition(branch.as_ref(), cx);
                    let else_cond = and_conditions(cond, neg.as_ref(), cx);
                    collect_items(g, else_cond.as_ref(), rc, cx, call_returns);
                } else {
                    collect_item(g, then_cond.as_ref(), rc, cx, call_returns);
                }
            }
        }
        k if is_metadata_kind(k) => {
            *cx.skipped_kinds.entry(k.to_string()).or_insert(0) += 1;
        }
        other => cx.warn(format!("unknown element <{other}> in RefConfig")),
    }
}

fn parse_call(
    node: roxmltree::Node<'_, '_>,
    cond: Option<&Condition>,
    cx: &mut Cx,
    call_returns: &mut Vec<(String, String)>,
) -> Option<ConfigCall> {
    let mut name = None;
    let mut ret = None;
    for a in node.attributes() {
        if a.namespace().is_some() {
            continue;
        }
        match a.name() {
            "Name" => name = Some(a.value().to_string()),
            // Recorded verbatim, `"false"` included. CubeMX's emitter reads
            // the *absence* of the attribute as "wrap the call in an
            // `if (... != HAL_OK)` guard" and only `ReturnHAL="false"` as
            // "emit a bare call" — so collapsing `"false"` into "absent" lost
            // the distinction and left calls like
            // `HAL_UARTEx_SetTxFifoThreshold` (no attribute in the db)
            // unguarded, where the reference project guards them.
            "ReturnHAL" => ret = Some(a.value().to_string()),
            "Type" => {}
            other => cx.warn(format!("unknown CallLibMethod attribute `{other}`")),
        }
    }
    let mut hard_code = None;
    for c in node.children().filter(|n| n.is_element()) {
        if c.tag_name().name() == "HardCode" {
            hard_code = c.attribute("Text").map(expand_hardcode_escapes);
        }
    }
    // A `Type="HardCode"` call carries no method name — its whole content is
    // the verbatim text.
    let method = match name {
        Some(n) => n,
        None if hard_code.is_some() => String::new(),
        None => {
            cx.warn("CallLibMethod without Name; skipped");
            return None;
        }
    };
    if hard_code.is_some() {
        return Some(ConfigCall {
            method,
            arg_bindings: BTreeMap::new(),
            condition: cond.cloned(),
            hard_code,
        });
    }
    if let Some(r) = ret {
        call_returns.push((method.clone(), r));
    }

    let mut arg_bindings = BTreeMap::new();
    for c in node.children().filter(|n| n.is_element()) {
        match c.tag_name().name() {
            "MethodArg" => {
                let mut arg_name = None;
                let mut param = None;
                let mut literal = None;
                for a in c.attributes() {
                    if a.namespace().is_some() {
                        continue;
                    }
                    match a.name() {
                        "Name" => arg_name = Some(a.value()),
                        "ParameterName" if !a.value().is_empty() => param = Some(a.value()),
                        "ParameterName" => {}
                        "Value" | "FValue" => literal = Some(a.value()),
                        other => cx.warn(format!("unknown MethodArg attribute `{other}`")),
                    }
                }
                let Some(arg_name) = arg_name else {
                    cx.warn(format!("MethodArg without Name in `{method}`; skipped"));
                    continue;
                };
                let value = match (param, literal) {
                    (Some(p), _) => p.to_string(),
                    (None, Some(v)) => {
                        if !cx.literal_binding_noted {
                            cx.literal_binding_noted = true;
                            cx.warn(
                                "MethodArg with literal Value/FValue binding \
                                 (stored as `=<value>`)",
                            );
                        }
                        format!("={v}")
                    }
                    (None, None) => {
                        cx.warn(format!(
                            "MethodArg `{arg_name}` in `{method}` has neither \
                             ParameterName nor Value; skipped"
                        ));
                        continue;
                    }
                };
                if arg_bindings.insert(arg_name.to_string(), value).is_some() {
                    cx.warn(format!(
                        "duplicate MethodArg `{arg_name}` in `{method}`; keeping last"
                    ));
                }
            }
            other => cx.warn(format!("unknown element <{other}> in CallLibMethod")),
        }
    }

    Some(ConfigCall {
        method,
        arg_bindings,
        condition: cond.cloned(),
        hard_code: None,
    })
}

/// The db's `<HardCode Text>` escapes: `#n` newline, `#t` one indent level
/// (CubeMX emits two spaces per level inside a function body).
fn expand_hardcode_escapes(text: &str) -> String {
    text.replace("#n", "\n").replace("#t", "  ")
}

fn parse_lib_method(node: roxmltree::Node<'_, '_>, cx: &mut Cx) -> Option<LibMethod> {
    let mut name = None;
    for a in node.attributes() {
        if a.namespace().is_some() {
            continue;
        }
        match a.name() {
            "Name" => name = Some(a.value().to_string()),
            "Comment" | "Optimizable" => {}
            other => cx.warn(format!("unknown LibMethod attribute `{other}`")),
        }
    }
    let Some(name) = name else {
        cx.warn("LibMethod without Name; skipped");
        return None;
    };

    let mut arguments = Vec::new();
    for c in node.children().filter(|n| n.is_element()) {
        match c.tag_name().name() {
            "Argument" => arguments.push(parse_argument(c, cx)),
            other => cx.warn(format!("unknown element <{other}> in LibMethod `{name}`")),
        }
    }

    Some(LibMethod {
        name,
        arguments,
        // Filled from call sites afterwards; never present on LibMethod
        // elements themselves anywhere in the db.
        return_hal: None,
    })
}

fn parse_argument(node: roxmltree::Node<'_, '_>, cx: &mut Cx) -> MethodArgument {
    let mut arg = MethodArgument {
        name: String::new(),
        type_name: None,
        generic_type: "simple".to_string(),
        address_of: false,
        context: String::new(),
        optimization_condition: None,
        children: Vec::new(),
    };
    for a in node.attributes() {
        if a.namespace().is_some() {
            continue;
        }
        match a.name() {
            "Name" => arg.name = a.value().to_string(),
            "TypeName" => arg.type_name = Some(a.value().to_string()),
            "GenericType" => arg.generic_type = a.value().to_string(),
            "AddressOf" => arg.address_of = parse_bool(a.value(), "Argument@AddressOf", cx),
            "Context" => arg.context = a.value().to_string(),
            "OptimizationCondition" => {
                arg.optimization_condition = Some(a.value().to_string());
            }
            "Comment" => {}
            k @ ("ArraySize" | "Optional" | "ParamName") => {
                *cx.unmapped_arg_attrs.entry(k.to_string()).or_insert(0) += 1;
            }
            other => cx.warn(format!("unknown Argument attribute `{other}`")),
        }
    }
    if arg.name.is_empty() {
        cx.warn("Argument without Name");
    }
    for c in node.children().filter(|n| n.is_element()) {
        match c.tag_name().name() {
            "Argument" => arg.children.push(parse_argument(c, cx)),
            other => cx.warn(format!(
                "unknown element <{other}> in Argument `{}`",
                arg.name
            )),
        }
    }
    arg
}

fn parse_bool(value: &str, what: &str, cx: &mut Cx) -> bool {
    match value {
        "true" => true,
        "false" => false,
        other => {
            cx.warn(format!("{what}: expected true/false, got `{other}`"));
            false
        }
    }
}

/// AND-combine an outer (enclosing) condition with an inner IFCondition.
/// Directive-form conditions cannot be conjoined; keep the innermost.
fn and_conditions(
    outer: Option<&Condition>,
    inner: Option<&Condition>,
    cx: &mut Cx,
) -> Option<Condition> {
    match (outer, inner) {
        (None, x) => x.cloned(),
        (x, None) => x.cloned(),
        (Some(Condition::Plain(a)), Some(Condition::Plain(b))) => Some(Condition::Plain(
            Expr::And(vec![a.clone(), b.clone()]),
        )),
        _ => {
            cx.warn("cannot conjoin directive-form IFCondition; keeping innermost");
            inner.cloned()
        }
    }
}

/// Negate an IFCondition for its `<Else>` branch.
fn negate_condition(cond: Option<&Condition>, cx: &mut Cx) -> Option<Condition> {
    match cond {
        None => None,
        Some(Condition::Plain(e)) => {
            Some(Condition::Plain(Expr::Not(Box::new(e.clone()))))
        }
        Some(Condition::Directives(_)) => {
            cx.warn("cannot negate directive-form IFCondition for <Else>; dropped");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The config files declare ISO-8859-1; almost all are pure ASCII, but
    /// decode permissively (Latin-1 maps 1:1 onto Unicode scalars).
    fn read_config(path: &Path) -> String {
        let bytes = std::fs::read(path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(e) => e.into_bytes().iter().map(|&b| b as char).collect(),
        }
    }

    fn parse(db: &Path, file: &str) -> (ConfigDef, Lint) {
        let path: PathBuf = db.join("mcu").join("config").join(file);
        let xml = read_config(&path);
        let mut lint = Lint::default();
        let def = parse_config_def(&xml, &path, &mut lint)
            .unwrap_or_else(|e| panic!("{file}: {e}"));
        (def, lint)
    }

    #[test]
    fn uart_f1_call_tree() {
        let Some(db) = crate::test_db() else {
            eprintln!("skipping uart_f1_call_tree: CubeMX db not found");
            return;
        };
        let (def, lint) = parse(&db, "UART-STM32F1xx_Configs.xml");
        assert_eq!(def.name, "UART-STM32F1xx");

        // RefConfig Uart_Init: one HAL_UART_Init call, 4 bindings, callbacks.
        let rc = def.ref_configs.get("Uart_Init").expect("Uart_Init");
        let call = rc
            .calls
            .iter()
            .find(|c| c.method == "HAL_UART_Init")
            .expect("HAL_UART_Init call");
        assert_eq!(call.arg_bindings.get("Mode").map(String::as_str), Some("UartMode"));
        assert_eq!(
            call.arg_bindings.get("StopBits").map(String::as_str),
            Some("UartStopBits")
        );
        assert_eq!(call.arg_bindings.len(), 4);
        assert!(call.condition.is_none());
        assert_eq!(rc.callbacks, ["HAL_UART_MspInit", "HAL_UART_MspDeInit"]);

        // Uart_DeInit: single argless call.
        let deinit = &def.ref_configs["Uart_DeInit"];
        assert_eq!(deinit.calls.len(), 1);
        assert!(deinit.calls[0].arg_bindings.is_empty());

        // LibMethod HAL_UART_Init: struct root huart, Init child, BaudRate leaf.
        let lm = def.lib_methods.get("HAL_UART_Init").expect("HAL_UART_Init def");
        assert!(lm.return_hal.is_none()); // call site carries no ReturnHAL
        assert_eq!(lm.arguments.len(), 1);
        let huart = &lm.arguments[0];
        assert_eq!(huart.name, "huart");
        assert_eq!(huart.generic_type, "struct");
        assert!(huart.address_of);
        assert_eq!(huart.context, "global");
        assert_eq!(huart.type_name.as_deref(), Some("UART_HandleTypeDef"));
        let instance = huart.children.iter().find(|a| a.name == "Instance").unwrap();
        assert_eq!(instance.generic_type, "baseaddress");
        assert!(!instance.address_of);
        let init = huart.children.iter().find(|a| a.name == "Init").unwrap();
        assert_eq!(init.generic_type, "struct");
        let baud = init.children.iter().find(|a| a.name == "BaudRate").unwrap();
        assert_eq!(baud.generic_type, "simple");
        assert_eq!(baud.optimization_condition.as_deref(), Some("equal"));
        assert!(baud.children.is_empty());

        assert!(lint.warnings.len() < 20, "lint: {:#?}", lint.warnings);
    }

    #[test]
    fn gpio_and_rcc_f1_round_trip() {
        let Some(db) = crate::test_db() else {
            eprintln!("skipping gpio_and_rcc_f1_round_trip: CubeMX db not found");
            return;
        };
        let (gpio, gpio_lint) = parse(&db, "GPIO-STM32F1xx_Configs.xml");
        assert!(!gpio.ref_configs.is_empty());
        assert!(!gpio.lib_methods.is_empty());
        let g = &gpio.ref_configs["GPIO"];
        assert_eq!(g.calls[0].method, "HAL_GPIO_Init");
        assert_eq!(
            g.calls[0].arg_bindings.get("Pin").map(String::as_str),
            Some("GPIO_Pin")
        );
        // ReturnHAL="false" on every GPIO call site: recorded verbatim, since
        // only an explicit "false" means "emit a bare call" — an absent
        // attribute means "guard it".
        assert_eq!(
            gpio.lib_methods["HAL_GPIO_Init"].return_hal.as_deref(),
            Some("false")
        );
        assert!(
            gpio_lint.warnings.len() < 20,
            "GPIO lint: {:#?}",
            gpio_lint.warnings
        );

        let (rcc, rcc_lint) = parse(&db, "RCC-STM32F1xx_Configs.xml");
        let osc = &rcc.ref_configs["RCC_OSCConfig"];
        assert_eq!(osc.calls[0].method, "HAL_RCC_OscConfig");
        assert_eq!(
            osc.calls[0].arg_bindings.get("PLLMUL").map(String::as_str),
            Some("PLLMULARG")
        );
        // RCC_ClockConfig chains two calls in document order.
        let cc = &rcc.ref_configs["RCC_ClockConfig"];
        assert_eq!(cc.calls[0].method, "HAL_RCC_ClockConfig");
        assert_eq!(cc.calls[1].method, "HAL_RCCEx_PeriphCLKConfig");
        assert!(rcc.lib_methods.contains_key("HAL_RCC_OscConfig"));
        assert!(
            rcc_lint.warnings.len() < 20,
            "RCC lint: {:#?}",
            rcc_lint.warnings
        );
    }

    #[test]
    fn tim_ifcondition_and_i2s_else() {
        let Some(db) = crate::test_db() else {
            eprintln!("skipping tim_ifcondition_and_i2s_else: CubeMX db not found");
            return;
        };
        // TIM: IFCondition wraps the preload macro call.
        let (tim, _) = parse(&db, "TIM-STM32F1xx_Configs.xml");
        let pre = &tim.ref_configs["setOC1Preload_OC"];
        assert_eq!(pre.calls.len(), 1);
        assert_eq!(pre.calls[0].method, "__HAL_TIM_ENABLE_OCxPRELOAD");
        match pre.calls[0].condition.as_ref().expect("IFCondition") {
            Condition::Plain(Expr::Cmp { .. }) => {}
            other => panic!("expected Plain(Cmp), got {other:?}"),
        }
        // ReturnHAL="true" on HAL_TIM_ConfigOCrefClear call sites propagates.
        assert_eq!(
            tim.lib_methods["HAL_TIM_ConfigOCrefClear"].return_hal.as_deref(),
            Some("true")
        );

        // I2S: IFCondition with <Else> — two HAL_I2S_Init calls, the else
        // branch negated and carrying the AudioFreq override binding. The
        // expression is `!AudioFreq=AudioFreqCustomValue`, and `!` binds
        // LOOSER than `=` (CubeMX MathParserImpl precedence): the then
        // branch is `!(AudioFreq=Custom)` — "any standard rate" — and the
        // else (its negation) is the custom-rate override. The old parse
        // read `(!AudioFreq)=Custom`, which compared a boolean to an enum
        // token and never held.
        let (i2s, _) = parse(&db, "I2S-STM32F1xx_Configs.xml");
        let rc = &i2s.ref_configs["I2S_Init"];
        assert_eq!(rc.calls.len(), 2);
        assert!(rc.calls.iter().all(|c| c.method == "HAL_I2S_Init"));
        match rc.calls[0].condition.as_ref().expect("then guard") {
            Condition::Plain(Expr::Not(inner)) => {
                assert!(matches!(**inner, Expr::Cmp { .. }), "then = !(AudioFreq=Custom)")
            }
            other => panic!("expected Plain(Not(Cmp)), got {other:?}"),
        }
        match rc.calls[1].condition.as_ref().expect("else guard") {
            Condition::Plain(Expr::Not(inner)) => {
                assert!(matches!(**inner, Expr::Not(_)), "else = !!(AudioFreq=Custom)")
            }
            other => panic!("expected Plain(Not(Not(..))), got {other:?}"),
        }
        assert!(rc.calls[0].arg_bindings.is_empty());
        assert_eq!(
            rc.calls[1].arg_bindings.get("AudioFreq").map(String::as_str),
            Some("AudioFreqCustom")
        );
        assert_eq!(rc.callbacks, ["HAL_I2S_MspInit", "HAL_I2S_MspDeInit"]);
    }
}
