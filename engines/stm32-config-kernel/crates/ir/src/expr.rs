//! CubeMX condition-expression DSL.
//!
//! Grammar, mirroring CubeMX's own evaluator (MathParserImpl.FindLastOper
//! splits at the LOWEST precedence: `|`=1, `&`=2, `!`=3, `=`=4, `<`/`>`
//! (incl. `<=` `>=` `<>`)=5, `+`=7, `*`/`/`=9):
//!   expr    := or
//!   or      := and ('|' and)*
//!   and     := not ('&' not)*
//!   not     := '!' not | eq
//!   eq      := rel ('=' rel)*
//!   rel     := sum (('<' | '>' | '<=' | '>=' | '<>') sum)*
//!   sum     := product ('+' product)*
//!   product := unary (('*' | '/') unary)*
//!   unary   := '!' unary | '(' expr ')' | atom
//!   atom    := identifier | number
//!
//! `!` binding LOOSER than `=` is load-bearing: the db writes
//! `!AHBCLKDivider=RCC_SYSCLK_DIV1` meaning `!(AHBCLKDivider=DIV1)` — 838
//! distinct conditions rely on it. The two-char comparators require adjacent
//! characters, exactly like CubeMX's IsTwoParamFunc. Parse and evaluation
//! failures are fail-closed (CubeMX catches ParserException and returns
//! false/0.0 — LogicalParser.checkCondition/evaluate).
//! Comparison operands may be scaled: F3's APB1 window is guarded by
//! `((SYSCLKFreq_VALUE/2) < 10000000)`, F3's ADC sampling window by
//! `((FHzADCClock/1.5) > 2500000)`. Only `*` and `/` are multiplicative
//! operators; `-` stays an identifier character, which is what the db's own
//! token spellings (`STM32H7-DUAL`, `2V1`) require.
//! Identifiers reference semaphores, parameter names, cross-instance
//! parameters (`ADC1:Param`), or pin-signal flags (`PB6_I2C1_SCL`).
//! Numbers may be decimal (`2.7`) and are kept exact as i64-rationals.
//!
//! Some modern NVIC files use a directive form:
//!   `force:(EXPR);warning:EXPR` — parsed into `Directives`.

use num_rational::Ratio;
use serde::{Deserialize, Serialize};
use std::fmt;

pub type Num = Ratio<i64>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Expr {
    /// Bare identifier: semaphore test / truthy parameter test.
    Ident(String),
    /// Exact numeric literal.
    Number(Num),
    Not(Box<Expr>),
    And(Vec<Expr>),
    Or(Vec<Expr>),
    Cmp {
        op: CmpOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    /// Arithmetic on an operand: `SYSCLKFreq_VALUE/2`,
    /// `(Integer_PeriodDither*16)+Fractionnal_PeriodDither`.
    Arith {
        op: ArithOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CmpOp {
    Eq,
    Lt,
    Gt,
    Le,
    Ge,
    /// `<>` — CubeMX's not-equals.
    Ne,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArithOp {
    Mul,
    Div,
    /// `+`. Numeric addition inside a comparison
    /// (`(Value + Size_R1) < 0x1FFFFFFF`); CubeMX also writes it between
    /// semaphores as boolean OR (`!(Semaphore_Channel1$Ip+Semaphore_Channel2$Ip)`),
    /// which the evaluator honours by reading a bare `Arith` in boolean
    /// position as "any operand truthy".
    Add,
}

/// `-` is deliberately absent: it is a legal identifier byte in this db
/// (`PC14-OSC32_IN`, `NUCLEO-H563ZI`), so it cannot double as an operator.

/// A full condition attribute value: either a plain expression or a list of
/// `verb:expr` directives (`force:`, `warning:` — modern NVIC dialect).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Condition {
    Plain(Expr),
    Directives(Vec<(Verb, Expr)>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Verb {
    Force,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("expression parse error at byte {pos}: {msg} in `{src}`")]
pub struct ParseError {
    pub pos: usize,
    pub msg: String,
    pub src: String,
}

/// A guard that never holds.
///
/// Used where an expression failed to parse: `condition: None` means "no
/// guard, always applies", so leaving a broken guard out would promote its
/// overload to the unconditional fallback and shadow every later one. The db
/// convention puts the real fallback last, and this keeps that chain intact.
pub fn unsatisfiable() -> Condition {
    Condition::Plain(Expr::Number(Num::from_integer(0)))
}

pub fn parse_condition(src: &str) -> Result<Condition, ParseError> {
    // Directive form detection: starts with `force:` or `warning:`.
    let trimmed = src.trim_start();
    if trimmed.starts_with("force:") || trimmed.starts_with("warning:") {
        let mut directives = Vec::new();
        for seg in split_directives(trimmed) {
            let (verb, rest) = if let Some(r) = seg.strip_prefix("force:") {
                (Verb::Force, r)
            } else if let Some(r) = seg.strip_prefix("warning:") {
                (Verb::Warning, r)
            } else {
                return Err(ParseError {
                    pos: 0,
                    msg: format!("directive segment without verb: `{seg}`"),
                    src: src.to_string(),
                });
            };
            directives.push((verb, parse_expr(rest)?));
        }
        return Ok(Condition::Directives(directives));
    }
    Ok(Condition::Plain(parse_expr(src)?))
}

/// Split `force:(..);warning:..` on top-level `;` (parens can nest).
fn split_directives(src: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (i, c) in src.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ';' if depth == 0 => {
                out.push(src[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    let last = src[start..].trim();
    if !last.is_empty() {
        out.push(last);
    }
    out
}

pub fn parse_expr(src: &str) -> Result<Expr, ParseError> {
    let mut p = Parser {
        src,
        bytes: src.as_bytes(),
        pos: 0,
    };
    let e = p.or_expr()?;
    p.skip_ws();
    if p.pos != p.bytes.len() {
        return Err(p.err("trailing input"));
    }
    Ok(e)
}

struct Parser<'a> {
    src: &'a str,
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn err(&self, msg: &str) -> ParseError {
        ParseError {
            pos: self.pos,
            msg: msg.to_string(),
            src: self.src.to_string(),
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && (self.bytes[self.pos] as char).is_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.bytes.get(self.pos).copied()
    }

    fn or_expr(&mut self) -> Result<Expr, ParseError> {
        let first = self.and_expr()?;
        let mut items = vec![first];
        while self.peek() == Some(b'|') {
            self.pos += 1;
            items.push(self.and_expr()?);
        }
        Ok(if items.len() == 1 {
            items.pop().unwrap()
        } else {
            Expr::Or(items)
        })
    }

    fn and_expr(&mut self) -> Result<Expr, ParseError> {
        let first = self.not_expr()?;
        let mut items = vec![first];
        while self.peek() == Some(b'&') {
            self.pos += 1;
            items.push(self.not_expr()?);
        }
        Ok(if items.len() == 1 {
            items.pop().unwrap()
        } else {
            Expr::And(items)
        })
    }

    /// `!` at CubeMX precedence 3: looser than `=`, tighter than `&`.
    /// `!A=B` is `!(A=B)`; `A & !B=C` is `A & !(B=C)`.
    fn not_expr(&mut self) -> Result<Expr, ParseError> {
        if self.peek() == Some(b'!') {
            self.pos += 1;
            return Ok(Expr::Not(Box::new(self.not_expr()?)));
        }
        self.eq_expr()
    }

    /// `=` chain (precedence 4), left-associative like CubeMX's
    /// rightmost-split.
    fn eq_expr(&mut self) -> Result<Expr, ParseError> {
        let mut lhs = self.rel_expr()?;
        while self.peek() == Some(b'=') {
            self.pos += 1;
            let rhs = self.rel_expr()?;
            lhs = Expr::Cmp {
                op: CmpOp::Eq,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
        Ok(lhs)
    }

    /// Relational chain (precedence 5). The second character of `<=`, `>=`,
    /// `<>` must be adjacent (no whitespace), like CubeMX's IsTwoParamFunc.
    fn rel_expr(&mut self) -> Result<Expr, ParseError> {
        let mut lhs = self.sum()?;
        loop {
            let op = match self.peek() {
                Some(b'<') => match self.bytes.get(self.pos + 1) {
                    Some(b'=') => {
                        self.pos += 1;
                        CmpOp::Le
                    }
                    Some(b'>') => {
                        self.pos += 1;
                        CmpOp::Ne
                    }
                    _ => CmpOp::Lt,
                },
                Some(b'>') => match self.bytes.get(self.pos + 1) {
                    Some(b'=') => {
                        self.pos += 1;
                        CmpOp::Ge
                    }
                    _ => CmpOp::Gt,
                },
                _ => return Ok(lhs),
            };
            self.pos += 1;
            let rhs = self.sum()?;
            lhs = Expr::Cmp {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
    }

    /// Left-associative `+` chain, binding looser than `*` / `/`.
    fn sum(&mut self) -> Result<Expr, ParseError> {
        let mut lhs = self.product()?;
        while self.peek() == Some(b'+') {
            self.pos += 1;
            let rhs = self.product()?;
            lhs = Expr::Arith {
                op: ArithOp::Add,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
        Ok(lhs)
    }

    /// Left-associative `*` / `/` chain.
    fn product(&mut self) -> Result<Expr, ParseError> {
        let mut lhs = self.unary()?;
        loop {
            let op = match self.peek() {
                Some(b'*') => ArithOp::Mul,
                Some(b'/') => ArithOp::Div,
                _ => return Ok(lhs),
            };
            self.pos += 1;
            let rhs = self.unary()?;
            lhs = Expr::Arith {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
    }

    fn unary(&mut self) -> Result<Expr, ParseError> {
        match self.peek() {
            Some(b'!') => {
                self.pos += 1;
                Ok(Expr::Not(Box::new(self.unary()?)))
            }
            Some(b'(') => {
                self.pos += 1;
                let e = self.or_expr()?;
                if self.peek() != Some(b')') {
                    return Err(self.err("expected `)`"));
                }
                self.pos += 1;
                Ok(e)
            }
            Some(c) if c.is_ascii_digit() => self.number(),
            Some(_) => self.ident(),
            None => Err(self.err("unexpected end of input")),
        }
    }

    fn number(&mut self) -> Result<Expr, ParseError> {
        self.skip_ws();
        let start = self.pos;
        while self
            .bytes
            .get(self.pos)
            .is_some_and(|c| c.is_ascii_digit() || *c == b'.')
        {
            self.pos += 1;
        }
        let text = &self.src[start..self.pos];
        // A token like `2V1` is an identifier that starts with a digit
        // (rare but legal in the db); fall back to ident continuation.
        if self
            .bytes
            .get(self.pos)
            .is_some_and(|c| is_ident_byte(*c))
        {
            while self.bytes.get(self.pos).is_some_and(|c| is_ident_byte(*c)) {
                self.pos += 1;
            }
            return Ok(Expr::Ident(self.src[start..self.pos].to_string()));
        }
        parse_number(text)
            .map(Expr::Number)
            .ok_or_else(|| self.err("invalid number"))
    }

    fn ident(&mut self) -> Result<Expr, ParseError> {
        self.skip_ws();
        let start = self.pos;
        while self.bytes.get(self.pos).is_some_and(|c| is_ident_byte(*c)) {
            self.pos += 1;
        }
        if self.pos == start {
            return Err(self.err("expected identifier"));
        }
        Ok(Expr::Ident(self.src[start..self.pos].to_string()))
    }
}

impl Expr {
    /// Every identifier this expression reads, in traversal order.
    pub fn idents(&self, out: &mut Vec<String>) {
        match self {
            Expr::Ident(name) => {
                if !out.iter().any(|n| n == name) {
                    out.push(name.clone());
                }
            }
            Expr::Number(_) => {}
            Expr::Not(e) => e.idents(out),
            Expr::And(items) | Expr::Or(items) => items.iter().for_each(|e| e.idents(out)),
            Expr::Cmp { lhs, rhs, .. } | Expr::Arith { lhs, rhs, .. } => {
                lhs.idents(out);
                rhs.idents(out);
            }
        }
    }
}

impl Condition {
    /// Every identifier this condition reads, in traversal order.
    pub fn idents(&self) -> Vec<String> {
        let mut out = Vec::new();
        match self {
            Condition::Plain(e) => e.idents(&mut out),
            Condition::Directives(dirs) => dirs.iter().for_each(|(_, e)| e.idents(&mut out)),
        }
        out
    }
}

/// Identifier bytes: alnum, `_`, `$` (instance macros), `:` (cross-instance
/// refs like `ADC1:Param`), `.`, `-`, `#` (seen in odd pin/signal names).
fn is_ident_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'$' | b':' | b'.' | b'-' | b'#')
}

/// Parse `24000000` or `2.7` into an exact rational.
pub fn parse_number(text: &str) -> Option<Num> {
    if text.is_empty() || text.bytes().filter(|c| *c == b'.').count() > 1 {
        return None;
    }
    // C-style hex literals ("0xffff" TIM periods in ioc/db data).
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).ok().map(Num::from_integer);
    }
    match text.split_once('.') {
        None => text.parse::<i64>().ok().map(Num::from_integer),
        Some((int, frac)) => {
            if frac.is_empty() || !frac.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let int: i64 = if int.is_empty() { 0 } else { int.parse().ok()? };
            let denom = 10i64.checked_pow(frac.len() as u32)?;
            let frac: i64 = frac.parse().ok()?;
            Some(Num::new(int * denom + frac, denom))
        }
    }
}

// ---------------------------------------------------------------------------
// Numeric parameter expressions (a separate, smaller grammar)
// ---------------------------------------------------------------------------

/// Evaluate the arithmetic expression a numeric db parameter may hold:
/// numbers, `+ - * /`, parentheses, and bare identifiers resolved through
/// `lookup` (whose result is itself an expression of this grammar).
///
/// This is deliberately NOT the condition DSL. Two reasons:
///
/// * `-` is a legal *identifier* byte in the condition DSL (`PC14-OSC32_IN`,
///   `NUCLEO-H563ZI`) and cannot double as an operator there. In a numeric
///   parameter it is unambiguously subtraction — CubeMX accepts `1000-1` as a
///   TIM period and the reference project emits `htim3.Init.Period = 999`.
/// * the values reaching this function are already known to be numeric by the
///   parameter's declared `Type`, so there is no enum-token ambiguity.
///
/// Returns `None` for anything outside the grammar, including the db's
/// `IF(a,b,c)` middleware defaults — the caller then keeps the raw text.
pub fn eval_arith(src: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Option<Num> {
    ArithEval { lookup, depth: 0 }.expr(src)
}

struct ArithEval<'a> {
    lookup: &'a dyn Fn(&str) -> Option<String>,
    depth: usize,
}

impl ArithEval<'_> {
    fn expr(&mut self, src: &str) -> Option<Num> {
        let mut p = ArithParser {
            bytes: src.as_bytes(),
            src,
            pos: 0,
        };
        let v = p.sum(self)?;
        p.skip_ws();
        (p.pos == p.bytes.len()).then_some(v)
    }

    /// A bare identifier: its parameter text, evaluated in turn.
    fn ident(&mut self, name: &str) -> Option<Num> {
        if self.depth >= 8 {
            return None; // cyclic parameter reference in the db
        }
        let text = (self.lookup)(name)?;
        self.depth += 1;
        let v = self.expr(text.trim());
        self.depth -= 1;
        v
    }
}

struct ArithParser<'a> {
    bytes: &'a [u8],
    src: &'a str,
    pos: usize,
}

impl ArithParser<'_> {
    fn skip_ws(&mut self) {
        while self
            .bytes
            .get(self.pos)
            .is_some_and(|c| c.is_ascii_whitespace())
        {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.bytes.get(self.pos).copied()
    }

    fn sum(&mut self, ev: &mut ArithEval<'_>) -> Option<Num> {
        let mut acc = self.product(ev)?;
        loop {
            match self.peek() {
                Some(b'+') => {
                    self.pos += 1;
                    acc = acc + self.product(ev)?;
                }
                Some(b'-') => {
                    self.pos += 1;
                    acc = acc - self.product(ev)?;
                }
                _ => return Some(acc),
            }
        }
    }

    fn product(&mut self, ev: &mut ArithEval<'_>) -> Option<Num> {
        let mut acc = self.unary(ev)?;
        loop {
            match self.peek() {
                Some(b'*') => {
                    self.pos += 1;
                    acc = acc * self.unary(ev)?;
                }
                Some(b'/') => {
                    self.pos += 1;
                    let d = self.unary(ev)?;
                    if *d.numer() == 0 {
                        return None;
                    }
                    acc = acc / d;
                }
                _ => return Some(acc),
            }
        }
    }

    fn unary(&mut self, ev: &mut ArithEval<'_>) -> Option<Num> {
        match self.peek()? {
            b'-' => {
                self.pos += 1;
                Some(-self.unary(ev)?)
            }
            b'+' => {
                self.pos += 1;
                self.unary(ev)
            }
            b'(' => {
                self.pos += 1;
                let v = self.sum(ev)?;
                if self.peek() != Some(b')') {
                    return None;
                }
                self.pos += 1;
                Some(v)
            }
            c if c.is_ascii_digit() => {
                let start = self.pos;
                // `0x` hex, else digits with at most one `.`.
                if c == b'0'
                    && matches!(self.bytes.get(self.pos + 1), Some(b'x') | Some(b'X'))
                {
                    self.pos += 2;
                    while self
                        .bytes
                        .get(self.pos)
                        .is_some_and(|c| c.is_ascii_hexdigit())
                    {
                        self.pos += 1;
                    }
                } else {
                    while self
                        .bytes
                        .get(self.pos)
                        .is_some_and(|c| c.is_ascii_digit() || *c == b'.')
                    {
                        self.pos += 1;
                    }
                }
                parse_number(&self.src[start..self.pos])
            }
            _ => {
                let start = self.pos;
                while self.bytes.get(self.pos).is_some_and(|c| {
                    c.is_ascii_alphanumeric() || matches!(*c, b'_' | b'$' | b':')
                }) {
                    self.pos += 1;
                }
                if self.pos == start {
                    return None;
                }
                ev.ident(&self.src[start..self.pos])
            }
        }
    }
}

impl fmt::Display for Expr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Expr::Ident(s) => write!(f, "{s}"),
            Expr::Number(n) => {
                if n.is_integer() {
                    write!(f, "{}", n.numer())
                } else {
                    write!(f, "{n}")
                }
            }
            Expr::Not(e) => write!(f, "!({e})"),
            Expr::And(items) => {
                let parts: Vec<String> = items.iter().map(|e| format!("({e})")).collect();
                write!(f, "{}", parts.join(" & "))
            }
            Expr::Or(items) => {
                let parts: Vec<String> = items.iter().map(|e| format!("({e})")).collect();
                write!(f, "{}", parts.join(" | "))
            }
            Expr::Cmp { op, lhs, rhs } => {
                let op = match op {
                    CmpOp::Eq => "=",
                    CmpOp::Lt => "<",
                    CmpOp::Gt => ">",
                    CmpOp::Le => "<=",
                    CmpOp::Ge => ">=",
                    CmpOp::Ne => "<>",
                };
                write!(f, "{lhs} {op} {rhs}")
            }
            Expr::Arith { op, lhs, rhs } => {
                let op = match op {
                    ArithOp::Mul => "*",
                    ArithOp::Div => "/",
                    ArithOp::Add => "+",
                };
                write!(f, "{lhs}{op}{rhs}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ident(s: &str) -> Expr {
        Expr::Ident(s.to_string())
    }

    #[test]
    fn bare_semaphore() {
        assert_eq!(parse_expr("HSEByPass").unwrap(), ident("HSEByPass"));
    }

    #[test]
    fn negation_and_pin_signal_idents() {
        // Verbatim from STM32F103C(8-B)Tx.xml (BZ#83533)
        let e = parse_expr("(!(SPI1_MOSI & PB6_I2C1_SCL) )").unwrap();
        assert_eq!(
            e,
            Expr::Not(Box::new(Expr::And(vec![
                ident("SPI1_MOSI"),
                ident("PB6_I2C1_SCL")
            ])))
        );
    }

    #[test]
    fn not_binds_looser_than_eq() {
        // CubeMX precedence: ! is 3, = is 4 — `!A=B` means `!(A=B)`.
        // Verbatim from RCC-STM32F102_rcc_v1_0_Modes.xml (PREFETCH_ENABLE).
        let e = parse_expr("!AHBCLKDivider=RCC_SYSCLK_DIV1").unwrap();
        assert_eq!(
            e,
            Expr::Not(Box::new(Expr::Cmp {
                op: CmpOp::Eq,
                lhs: Box::new(ident("AHBCLKDivider")),
                rhs: Box::new(ident("RCC_SYSCLK_DIV1")),
            }))
        );
    }

    #[test]
    fn not_still_tighter_than_and_or() {
        // `A & !B=C` splits at `&`; the right side is !(B=C), and the Not
        // never swallows the conjunction.
        let e = parse_expr("A & !B=C").unwrap();
        assert_eq!(
            e,
            Expr::And(vec![
                ident("A"),
                Expr::Not(Box::new(Expr::Cmp {
                    op: CmpOp::Eq,
                    lhs: Box::new(ident("B")),
                    rhs: Box::new(ident("C")),
                })),
            ])
        );
        // Verbatim shape (H5 OB_ProductState): two independent negated
        // comparisons, NOT one Not over the whole conjunction.
        let e = parse_expr(
            "!OB_ProductState=OB_PROD_STATE_OPEN & !OB_ProductState=OB_PROD_STATE_PROVISIONING",
        )
        .unwrap();
        match e {
            Expr::And(items) => {
                assert_eq!(items.len(), 2);
                for item in items {
                    assert!(
                        matches!(item, Expr::Not(inner) if matches!(*inner, Expr::Cmp { .. })),
                        "each conjunct is a negated comparison"
                    );
                }
            }
            other => panic!("expected And, got {other:?}"),
        }
    }

    #[test]
    fn operand_head_negation() {
        // `A = !B`: the ! sits on the comparison OPERAND (CubeMX
        // IsOneParamFunc on the sub-formula), handled by unary().
        let e = parse_expr("A = !B").unwrap();
        assert_eq!(
            e,
            Expr::Cmp {
                op: CmpOp::Eq,
                lhs: Box::new(ident("A")),
                rhs: Box::new(Expr::Not(Box::new(ident("B")))),
            }
        );
    }

    #[test]
    fn two_char_operators() {
        let e = parse_expr("VDD_VALUE <= 2.1").unwrap();
        assert!(matches!(e, Expr::Cmp { op: CmpOp::Le, .. }), "{e:?}");
        // Verbatim USBPD: cross-instance ident.
        let e = parse_expr("GUI_INTERFACE:IntVersion >= 180").unwrap();
        assert!(matches!(e, Expr::Cmp { op: CmpOp::Ge, .. }), "{e:?}");
        // Verbatim LevelX.
        let e = parse_expr("Value <> LX_NAND_SIM_EXTRA_BYTES_POSITION").unwrap();
        assert!(matches!(e, Expr::Cmp { op: CmpOp::Ne, .. }), "{e:?}");
        // No-space spelling, verbatim USB_DEVICE.
        let e = parse_expr("MCU_RAM_SIZE<=64").unwrap();
        assert!(matches!(e, Expr::Cmp { op: CmpOp::Le, .. }), "{e:?}");
        // Verbatim LevelX: `*` as boolean AND over two parenthesized
        // comparisons — Arith{Mul} with Cmp operands.
        let e = parse_expr(
            "(Value < LX_NAND_SIM_SPARE_BYTES_PER_PAGE)*( Value <> LX_NAND_SIM_BAD_BLOCK_BYTE_POSITION)",
        )
        .unwrap();
        match e {
            Expr::Arith { op: ArithOp::Mul, lhs, rhs } => {
                assert!(matches!(*lhs, Expr::Cmp { op: CmpOp::Lt, .. }));
                assert!(matches!(*rhs, Expr::Cmp { op: CmpOp::Ne, .. }));
            }
            other => panic!("expected Mul of comparisons, got {other:?}"),
        }
    }

    #[test]
    fn two_char_display_round_trip() {
        for src in ["A <= 2", "A >= 2", "A <> 2"] {
            let e = parse_expr(src).unwrap();
            assert_eq!(format!("{e}"), src, "display must re-spell the operator");
        }
    }

    #[test]
    fn param_eq_and_family_flags() {
        // Verbatim from RCC-STM32F102_rcc_v1_0_Modes.xml
        let e = parse_expr("PLLUsed=1 & STM32F103").unwrap();
        assert_eq!(
            e,
            Expr::And(vec![
                Expr::Cmp {
                    op: CmpOp::Eq,
                    lhs: Box::new(ident("PLLUsed")),
                    rhs: Box::new(Expr::Number(Num::from_integer(1))),
                },
                ident("STM32F103"),
            ])
        );
    }

    #[test]
    fn le_written_as_lt_or_eq() {
        // Verbatim pattern: ((X < 24000000)|((X =24000000)))
        let e = parse_expr("((SYSCLKFreq_VALUE > 0) & ((SYSCLKFreq_VALUE < 24000000)|((SYSCLKFreq_VALUE =24000000))))")
            .unwrap();
        match e {
            Expr::And(items) => assert_eq!(items.len(), 2),
            other => panic!("expected And, got {other:?}"),
        }
    }

    #[test]
    fn decimal_vdd() {
        let e = parse_expr("(VDD_VALUE < 2.1)").unwrap();
        assert_eq!(
            e,
            Expr::Cmp {
                op: CmpOp::Lt,
                lhs: Box::new(ident("VDD_VALUE")),
                rhs: Box::new(Expr::Number(Num::new(21, 10))),
            }
        );
    }

    #[test]
    fn cross_instance_ref() {
        let e = parse_expr("ADC1:InjNumberOfConversion=0").unwrap();
        assert_eq!(
            e,
            Expr::Cmp {
                op: CmpOp::Eq,
                lhs: Box::new(ident("ADC1:InjNumberOfConversion")),
                rhs: Box::new(Expr::Number(Num::from_integer(0))),
            }
        );
    }

    #[test]
    fn sloppy_whitespace_verbatim() {
        // Verbatim from RCC-STM32F410 (note missing parens/space around &)
        parse_expr(
            "(((PLLSource=RCC_PLLSOURCE_HSE) &SYSCLKSource=RCC_SYSCLKSOURCE_PLLCLK )|(SYSCLKSource=RCC_SYSCLKSOURCE_HSE)) & (HSEOscillator | HSEByPass)",
        )
        .unwrap();
    }

    #[test]
    fn instance_macro() {
        assert_eq!(
            parse_expr("$IpInstance_Asynchronous").unwrap(),
            ident("$IpInstance_Asynchronous")
        );
    }

    #[test]
    fn digit_leading_ident() {
        assert_eq!(parse_expr("2V1").unwrap(), ident("2V1"));
    }

    #[test]
    fn directive_form() {
        let c = parse_condition(
            "force:(COMP1_EXTI_IT_ENABLED|COMP2_EXTI_IT_ENABLED);warning:COMP_IRQn&(!COMP1_EXTI_IT_ENABLED)",
        )
        .unwrap();
        match c {
            Condition::Directives(d) => {
                assert_eq!(d.len(), 2);
                assert_eq!(d[0].0, Verb::Force);
                assert_eq!(d[1].0, Verb::Warning);
            }
            other => panic!("expected directives, got {other:?}"),
        }
    }

    #[test]
    fn or_flags() {
        let e = parse_expr("RTC_ALARM_INTERRUPT|RTC_TIMESTAMP_INTERRUPT|RTC_WAKEUP_INTERRUPT").unwrap();
        assert_eq!(
            e,
            Expr::Or(vec![
                ident("RTC_ALARM_INTERRUPT"),
                ident("RTC_TIMESTAMP_INTERRUPT"),
                ident("RTC_WAKEUP_INTERRUPT"),
            ])
        );
    }

    #[test]
    fn number_parsing() {
        assert_eq!(parse_number("48120000"), Some(Num::from_integer(48120000)));
        assert_eq!(parse_number("1.5"), Some(Num::new(3, 2)));
        assert_eq!(parse_number("2.7"), Some(Num::new(27, 10)));
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("1.2.3"), None);
        // ioc/db hex spellings (TIM periods "0xffff" / "0xFFFFFFFF").
        assert_eq!(parse_number("0xffff"), Some(Num::from_integer(65535)));
        assert_eq!(
            parse_number("0xFFFFFFFF"),
            Some(Num::from_integer(4294967295))
        );
        assert_eq!(parse_number("0x"), None);
        assert_eq!(parse_number("0xZZ"), None);
    }
}
