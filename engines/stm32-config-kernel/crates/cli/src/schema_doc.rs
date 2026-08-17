//! Compact text rendering of the configuration-document JSON Schema.
//!
//! The default `schema` command prints this instead of the raw schemars
//! JSON (~6.6 KB vs 13.4 KB): same field inventory — a cli_e2e test
//! asserts every property and object def of the real schema appears —
//! but none of the JSON-Schema scaffolding. The renderer is generic over
//! `schemars::schema_for!` output so new fields and defs show up
//! automatically; a genuinely new schema *shape* (oneOf, const, inline
//! objects...) hits `unreachable!` and fails tests loudly instead of
//! rendering something wrong.

use serde_json::Value;

const HEADER: &str = "stm32kernel configuration document — field reference. `?` = optional, `=x` = default,\n{<name>: T} = JSON object map. Full JSON Schema: `stm32kernel schema --full`.\n";

/// Render the schemars JSON Schema as a compact field reference: a two
/// line header, the root object, then every `$defs` entry that has
/// `properties` (enum-only defs inline at their use sites), blank line
/// between blocks. No trailing newline — the caller `println!`s it.
///
/// Deterministic: this workspace's `serde_json` maps are BTreeMaps, so
/// every object iterates in sorted key order.
pub fn render(schema: &Value) -> String {
    let empty = Value::Object(serde_json::Map::new());
    let defs = schema.get("$defs").unwrap_or(&empty);
    let mut lines: Vec<String> = vec![HEADER.to_string()];
    let root_name = schema.get("title").and_then(Value::as_str).unwrap_or("ConfigDoc");
    render_object(root_name, schema, defs, &mut lines);
    if let Some(map) = defs.as_object() {
        for (name, def) in map {
            if def.get("properties").is_some() {
                lines.push(String::new());
                render_object(name, def, defs, &mut lines);
            }
        }
    }
    lines.join("\n")
}

/// One block: `Name  // <struct description>` then one line per property,
/// `  prop{?}: type{ =default}{  // description}`. `?` marks properties
/// absent from `required`; defaults print as compact JSON except the
/// no-information ones (null, objects, empty arrays — object defaults
/// merely restate the per-field defaults of the def's own block). The
/// description is the property node's own, else its `$ref` target's,
/// with doc-comment newlines collapsed to single spaces.
fn render_object(name: &str, node: &Value, defs: &Value, lines: &mut Vec<String>) {
    let mut header = name.to_string();
    if let Some(d) = description(node) {
        header.push_str("  // ");
        header.push_str(&d);
    }
    lines.push(header);
    let required: Vec<&str> = node
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let Some(props) = node.get("properties").and_then(Value::as_object) else {
        return;
    };
    for (prop, ps) in props {
        let opt = if required.contains(&prop.as_str()) { "" } else { "?" };
        let mut line = format!("  {prop}{opt}: {}", type_str(ps, defs));
        if let Some(default) = ps.get("default") {
            let informative = match default {
                Value::Null | Value::Object(_) => false,
                Value::Array(a) => !a.is_empty(),
                _ => true,
            };
            if informative {
                line.push_str(" =");
                line.push_str(&default.to_string());
            }
        }
        let with_desc = if ps.get("description").is_some() { ps } else { resolve(ps, defs).1 };
        if let Some(d) = description(with_desc) {
            line.push_str("  // ");
            line.push_str(&d);
        }
        lines.push(line);
    }
}

/// The node's `description` with all whitespace runs (doc-comment line
/// breaks and indentation) collapsed to single spaces; None when absent
/// or empty.
fn description(node: &Value) -> Option<String> {
    let d = node.get("description")?.as_str()?;
    let clean = d.split_whitespace().collect::<Vec<_>>().join(" ");
    (!clean.is_empty()).then_some(clean)
}

/// Follow a top-level `$ref` to its `$defs` target; identity for nodes
/// without one. Returns the def name alongside the target node.
fn resolve<'a>(node: &'a Value, defs: &'a Value) -> (Option<&'a str>, &'a Value) {
    let Some(r) = node.get("$ref").and_then(Value::as_str) else {
        return (None, node);
    };
    let name = r.rsplit('/').next().unwrap_or(r);
    match defs.get(name) {
        Some(target) => (Some(name), target),
        None => unreachable!("unhandled schema shape (dangling $ref): {node}"),
    }
}

/// Compact type notation for a schema node:
/// - `$ref` resolves through `$defs` (object defs render as their name —
///   they get their own block; enum/anyOf defs inline)
/// - enums as `"a"|"b"`, `anyOf` as its non-null arms joined with ` | `
///   (covers `Option<T>` and ModeSel's `string | [string]`)
/// - `["X","null"]` type unions as plain `X`; integer -> int,
///   boolean -> bool; arrays as `[T]`
/// - string-keyed maps as `{<name>: T}` (`{<name>: value}` when the
///   value schema is `true`)
///
/// Anything else is a schemars construct this renderer has never seen:
/// fail loudly rather than render it wrong.
fn type_str(node: &Value, defs: &Value) -> String {
    let (name, node) = resolve(node, defs);
    if let Some(vals) = node.get("enum").and_then(Value::as_array) {
        return vals.iter().map(Value::to_string).collect::<Vec<_>>().join("|");
    }
    if let Some(arms) = node.get("anyOf").and_then(Value::as_array) {
        let parts: Vec<String> = arms
            .iter()
            .filter(|arm| resolve(arm, defs).1.get("type").and_then(Value::as_str) != Some("null"))
            .map(|arm| type_str(arm, defs))
            .collect();
        if parts.is_empty() {
            unreachable!("unhandled schema shape (anyOf with only null arms): {node}");
        }
        return parts.join(" | ");
    }
    let ty = match node.get("type") {
        None => None,
        Some(Value::String(t)) => Some(t.as_str()),
        Some(Value::Array(list)) => {
            let non_null: Vec<&str> = list
                .iter()
                .filter_map(Value::as_str)
                .filter(|t| *t != "null")
                .collect();
            match non_null[..] {
                [t] => Some(t),
                _ => unreachable!("unhandled schema shape (multi-type union): {node}"),
            }
        }
        Some(_) => unreachable!("unhandled schema shape (non-string type): {node}"),
    };
    match ty {
        Some("integer") => "int".to_string(),
        Some("boolean") => "bool".to_string(),
        Some("string") => "string".to_string(),
        Some("number") => "number".to_string(),
        Some("array") => match node.get("items") {
            Some(items) => format!("[{}]", type_str(items, defs)),
            None => unreachable!("unhandled schema shape (array without items): {node}"),
        },
        Some("object") => match node.get("additionalProperties") {
            Some(ap @ Value::Object(_)) => format!("{{<name>: {}}}", type_str(ap, defs)),
            Some(Value::Bool(true)) => "{<name>: value}".to_string(),
            _ if node.get("properties").is_some() => match name {
                Some(n) => n.to_string(),
                None => {
                    unreachable!("unhandled schema shape (inline object with properties): {node}")
                }
            },
            _ => unreachable!("unhandled schema shape (bare object): {node}"),
        },
        _ => unreachable!("unhandled schema shape: {node}"),
    }
}
