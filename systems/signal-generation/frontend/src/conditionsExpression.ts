// Text expression syntax for a multi_condition Rule's own Condition[] -
// a pure serialization convenience layered on top of the point-and-click
// ConditionsEditor (App.tsx), NOT a general expression language: the line
// break IS the AND (Condition/Term is already flat/non-recursive on the
// backend - see docs/architecture.md's "Multi-condition rules" section),
// so this only ever parses one line into one Condition, never a tree.
// Backend never sees this text - by the time a rule_config is submitted
// it's the same Condition[] JSON the visual builder already produces.
//
// Syntax: one condition per line, blank lines and lines starting with '#'
// ignored.
//   <interval>: <term> <op> <term>
// term: a bare field (open/high/low/close/volume), a bare keyword
// (candle_body/candle_range, or the short aliases body/range), a numeric
// literal, or a function call - sma(field,period)/ema(field,period)/
// highest(field,period)/lowest(field,period) (2 args) or
// rsi(period)/cci(period) (1 arg) - optionally followed by [N] (offset_bars,
// "N bars ago") and/or "* X" or "/ X" (scale). Examples:
//   daily: volume > sma(volume, 20)
//   daily: close > highest(high, 5)
//   15min: cci(200) > 100
//   15min: candle_body > candle_range * 0.25

import type { Condition, Interval, Term, TermKind } from "./api";

export type ParseError = { line: number; message: string };

const VALID_INTERVALS: Set<string> = new Set(["1min", "3min", "5min", "15min", "30min", "60min", "daily"]);
const FIELD_NAMES: Set<string> = new Set(["open", "high", "low", "close", "volume"]);
const TWO_ARG_FUNCS: Set<string> = new Set(["sma", "ema", "highest", "lowest"]);
const ONE_ARG_FUNCS: Set<string> = new Set(["rsi", "cci"]);
// Checked longest-first so ">=" is never misread as ">" followed by a
// stray "=" - see splitOnOperator.
const OPERATORS: Condition["operator"][] = [">=", "<=", ">", "<"];

function parseTermBase(s: string): Term | string {
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return { kind: "constant", value: Number(s) };
  }
  const funcMatch = /^([a-zA-Z_]+)\s*\(\s*(.*)\s*\)$/.exec(s);
  if (funcMatch) {
    const name = funcMatch[1].toLowerCase();
    const args = funcMatch[2]
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    if (TWO_ARG_FUNCS.has(name)) {
      if (args.length !== 2) return `${name}(...) needs 2 args: field, period`;
      const [field, periodStr] = args;
      if (!FIELD_NAMES.has(field)) return `unknown field '${field}' in ${name}(...)`;
      const period = Number(periodStr);
      if (!Number.isInteger(period) || period <= 0) return `${name}(...) period must be a positive integer`;
      return { kind: name as TermKind, field: field as Term["field"], period };
    }
    if (ONE_ARG_FUNCS.has(name)) {
      if (args.length !== 1) return `${name}(...) needs 1 arg: period`;
      const period = Number(args[0]);
      if (!Number.isInteger(period) || period <= 0) return `${name}(...) period must be a positive integer`;
      return { kind: name as TermKind, period };
    }
    return `unknown function '${name}'`;
  }
  const lower = s.toLowerCase();
  if (lower === "open" || lower === "high" || lower === "low" || lower === "close") {
    return { kind: "price", field: lower as Term["field"] };
  }
  if (lower === "volume") {
    return { kind: "volume" };
  }
  if (lower === "candle_body" || lower === "body") {
    return { kind: "candle_body" };
  }
  if (lower === "candle_range" || lower === "range") {
    return { kind: "candle_range" };
  }
  return `unknown term '${s}'`;
}

function parseTerm(raw: string): Term | string {
  let s = raw.trim();
  if (!s) return "empty term";

  // Strip a trailing scale suffix first (always rightmost when present),
  // then a trailing [N] offset (second-rightmost) - matches
  // stringifyTerm's own emission order below.
  let scale: number | undefined;
  const scaleMatch = /^(.*?)\s*([*/])\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (scaleMatch) {
    const [, rest, op, numStr] = scaleMatch;
    const num = Number(numStr);
    if (num === 0) return "scale/divisor cannot be 0";
    scale = op === "/" ? 1 / num : num;
    s = rest.trim();
  }

  let offsetBars: number | undefined;
  const offsetMatch = /^(.*?)\s*\[\s*(\d+)\s*\]\s*$/.exec(s);
  if (offsetMatch) {
    offsetBars = Number(offsetMatch[2]);
    s = offsetMatch[1].trim();
  }

  if (!s) return "empty term";

  const term = parseTermBase(s);
  if (typeof term === "string") return term;
  if (offsetBars !== undefined) term.offset_bars = offsetBars;
  if (scale !== undefined) term.scale = scale;
  return term;
}

function splitOnOperator(s: string): { left: string; operator: Condition["operator"]; right: string } | string {
  for (const op of OPERATORS) {
    const idx = s.indexOf(op);
    if (idx !== -1) {
      return { left: s.slice(0, idx).trim(), operator: op, right: s.slice(idx + op.length).trim() };
    }
  }
  return "missing comparison operator (>, <, >=, <=)";
}

export function parseConditionsText(text: string): { conditions: Condition[]; errors: ParseError[] } {
  const conditions: Condition[] = [];
  const errors: ParseError[] = [];

  text.split("\n").forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const lineNo = idx + 1;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      errors.push({ line: lineNo, message: "missing ':' after interval" });
      return;
    }
    const intervalRaw = line.slice(0, colonIdx).trim().toLowerCase();
    if (!VALID_INTERVALS.has(intervalRaw)) {
      errors.push({ line: lineNo, message: `unknown interval '${intervalRaw}'` });
      return;
    }

    const rest = line.slice(colonIdx + 1).trim();
    const split = splitOnOperator(rest);
    if (typeof split === "string") {
      errors.push({ line: lineNo, message: split });
      return;
    }

    const left = parseTerm(split.left);
    if (typeof left === "string") {
      errors.push({ line: lineNo, message: `left side: ${left}` });
      return;
    }
    const right = parseTerm(split.right);
    if (typeof right === "string") {
      errors.push({ line: lineNo, message: `right side: ${right}` });
      return;
    }

    conditions.push({ interval: intervalRaw as Interval, left, operator: split.operator, right });
  });

  return { conditions, errors };
}

function stringifyTerm(t: Term): string {
  let base: string;
  switch (t.kind) {
    case "price":
      base = t.field ?? "close";
      break;
    case "volume":
      base = "volume";
      break;
    case "candle_body":
      base = "candle_body";
      break;
    case "candle_range":
      base = "candle_range";
      break;
    case "constant":
      base = String(t.value);
      break;
    case "sma":
    case "ema":
    case "highest":
    case "lowest":
      base = `${t.kind}(${t.field}, ${t.period})`;
      break;
    case "rsi":
    case "cci":
      base = `${t.kind}(${t.period})`;
      break;
  }
  if (t.offset_bars) base += `[${t.offset_bars}]`;
  if (t.scale !== undefined && t.scale !== 1) base += ` * ${t.scale}`;
  return base;
}

export function stringifyConditions(conditions: Condition[]): string {
  return conditions.map((c) => `${c.interval}: ${stringifyTerm(c.left)} ${c.operator} ${stringifyTerm(c.right)}`).join("\n");
}
