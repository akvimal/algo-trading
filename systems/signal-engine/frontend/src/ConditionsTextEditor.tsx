import { useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  FIELD_NAMES_LIST,
  INTERVALS_LIST,
  KEYWORD_TERMS_LIST,
  ONE_ARG_FUNCS_LIST,
  OPERATORS_LIST,
  TWO_ARG_FUNCS_LIST,
  parseTerm,
  type ParseError,
} from "./conditionsExpression";

// Autocomplete for the multi_condition text syntax (see
// conditionsExpression.ts's own grammar comment) - suggests, per cursor
// position, exactly what that spot in the grammar accepts: an interval
// name before the line's ":" (even with nothing typed yet - the "0
// characters into a new line" case), a term (field/keyword/function name)
// after it (narrowed to just field names while inside a 2-arg function's
// first argument, e.g. sma(<here>, period)), or a comparison operator once
// the left-hand term is already complete (e.g. right after "close" or
// right after a closed "sma(close, 20)" - parseTerm succeeding on
// whatever's typed so far is exactly what "complete" means here). Never
// touches the parsing itself (conditionsExpression.ts, unchanged) - this
// only ever proposes text to insert into the same plain textarea.

type SuggestionKind = "interval" | "term" | "operator";

type SuggestionContext = {
  kind: SuggestionKind;
  replaceFrom: number;
  replaceTo: number;
  options: string[];
};

const TERM_OPTIONS = [...FIELD_NAMES_LIST, ...KEYWORD_TERMS_LIST, ...TWO_ARG_FUNCS_LIST, ...ONE_ARG_FUNCS_LIST];

// Leftmost operator typed so far, checked longest-first (">=" before ">")
// so a half-typed ">=" isn't mistaken for a bare ">" - same ordering
// conditionsExpression.ts's own splitOnOperator relies on.
function findOperator(s: string): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const op of OPERATORS_LIST) {
    const idx = s.indexOf(op);
    if (idx !== -1 && (best === null || idx < best.index)) best = { index: idx, length: op.length };
  }
  return best;
}

function computeSuggestions(text: string, caret: number): SuggestionContext | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const lineUpToCaret = text.slice(lineStart, caret);
  const colonIdx = lineUpToCaret.indexOf(":");

  if (colonIdx === -1) {
    // Still before the interval - prefix is whatever's typed so far on
    // this line, skipping leading whitespace/indentation.
    const leadingWs = lineUpToCaret.length - lineUpToCaret.trimStart().length;
    const prefix = lineUpToCaret.slice(leadingWs);
    if (!/^[a-zA-Z0-9]*$/.test(prefix)) return null; // already typed something that isn't a bare interval name (e.g. "#comment")
    const options = INTERVALS_LIST.filter((iv) => iv.startsWith(prefix.toLowerCase()));
    if (options.length === 0) return null;
    return { kind: "interval", replaceFrom: lineStart + leadingWs, replaceTo: caret, options };
  }

  // Past the interval - term position (either side of the comparison
  // operator; both sides accept the exact same grammar). `segment` is
  // whichever term is currently being typed: the left one (nothing after
  // the colon yet matches an operator) or the right one (everything after
  // the operator already typed).
  const afterColonStart = lineStart + colonIdx + 1;
  const afterColon = text.slice(afterColonStart, caret);
  const op = findOperator(afterColon);
  const segment = op ? afterColon.slice(op.index + op.length) : afterColon;

  // Whatever's typed for this term so far already parses as a real,
  // complete term (parseTerm trims for us, so a trailing space here is
  // fine) - nothing more to add to IT, but the grammar's own next token
  // does have a suggestion: a comparison operator after the left term, or
  // nothing at all after the right one (the condition line is done).
  if (segment.trim().length > 0 && typeof parseTerm(segment) !== "string") {
    if (op) return null;
    return { kind: "operator", replaceFrom: caret, replaceTo: caret, options: [...OPERATORS_LIST] };
  }

  const idMatch = /[a-zA-Z_]*$/.exec(segment);
  const prefix = idMatch ? idMatch[0] : "";
  const idStart = caret - prefix.length;

  // Inside an unmatched "(" belonging to a 2-arg function, before its
  // first comma -> only a field name is valid there (sma/ema/highest/
  // lowest's own first arg). A 1-arg function (rsi/cci) or the period
  // position of a 2-arg one takes a bare number - nothing to suggest.
  const openParenIdx = segment.lastIndexOf("(");
  const closeParenIdx = segment.lastIndexOf(")");
  let options: readonly string[];
  if (openParenIdx !== -1 && openParenIdx > closeParenIdx) {
    const fnNameMatch = /([a-zA-Z_]+)\s*\($/.exec(segment.slice(0, openParenIdx + 1));
    const fnName = fnNameMatch ? fnNameMatch[1].toLowerCase() : "";
    const sinceParen = segment.slice(openParenIdx + 1);
    if ((TWO_ARG_FUNCS_LIST as readonly string[]).includes(fnName) && !sinceParen.includes(",")) {
      options = FIELD_NAMES_LIST.filter((f) => f.startsWith(prefix.toLowerCase()));
    } else {
      options = [];
    }
  } else {
    options = TERM_OPTIONS.filter((t) => t.startsWith(prefix.toLowerCase()));
  }
  if (options.length === 0) return null;
  return { kind: "term", replaceFrom: idStart, replaceTo: caret, options: [...options] };
}

// Mirrors a textarea's own text layout in a hidden, identically-styled
// div to find where the caret actually sits on screen - textareas have no
// native way to ask this. Standard technique (same approach libraries like
// textarea-caret-position use): render the value up to the caret plus a
// marker span, then read the span's offset.
const MIRRORED_STYLE_PROPS = [
  "boxSizing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "tabSize",
] as const;

function getCaretPixelPosition(textarea: HTMLTextAreaElement, caret: number): { left: number; top: number; lineHeight: number } {
  const div = document.createElement("div");
  const computed = window.getComputedStyle(textarea);
  for (const prop of MIRRORED_STYLE_PROPS) div.style[prop as any] = computed[prop as any];
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.top = "-9999px";
  div.style.left = "-9999px";
  div.style.width = `${textarea.getBoundingClientRect().width}px`;
  div.textContent = textarea.value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = "​";
  div.appendChild(marker);
  document.body.appendChild(div);
  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;
  const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2;
  document.body.removeChild(div);
  return { left, top, lineHeight };
}

export function ConditionsTextEditor({
  value,
  onChange,
  rows,
  placeholder,
  parseErrors,
}: {
  value: string;
  onChange: (text: string) => void;
  rows: number;
  placeholder: string;
  parseErrors: ParseError[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const [context, setContext] = useState<SuggestionContext | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || pendingCaretRef.current == null) return;
    el.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
    pendingCaretRef.current = null;
    // An accepted suggestion (e.g. "daily: ") often lands the caret right
    // where the NEXT suggestion set should already be showing (term names
    // right after the interval's own ": ") - recompute immediately rather
    // than waiting for another keystroke/click.
    refreshSuggestions();
  }, [value]);

  function refreshSuggestions() {
    const el = textareaRef.current;
    if (!el || el.selectionStart !== el.selectionEnd) {
      setContext(null);
      return;
    }
    const ctx = computeSuggestions(el.value, el.selectionStart);
    setHighlighted(0);
    setContext(ctx);
    if (ctx) {
      const { left, top, lineHeight } = getCaretPixelPosition(el, el.selectionStart);
      setCoords({ left, top: top + lineHeight });
    }
  }

  function acceptSuggestion(option: string) {
    const el = textareaRef.current;
    if (!el || !context) return;
    const isCallable = (TWO_ARG_FUNCS_LIST as readonly string[]).includes(option) || (ONE_ARG_FUNCS_LIST as readonly string[]).includes(option);
    let insertText: string;
    if (context.kind === "interval") {
      insertText = `${option}: `;
    } else if (context.kind === "operator") {
      // Insertion-only (replaceFrom === replaceTo === caret, the term
      // before it is untouched) - pad with a leading space unless one's
      // already there (e.g. the term was typed with a trailing space
      // before the operator was even suggested).
      const needsLeadingSpace = context.replaceFrom > 0 && !/\s$/.test(value.slice(0, context.replaceFrom));
      insertText = `${needsLeadingSpace ? " " : ""}${option} `;
    } else {
      insertText = isCallable ? `${option}(` : option;
    }
    const newText = value.slice(0, context.replaceFrom) + insertText + value.slice(context.replaceTo);
    pendingCaretRef.current = context.replaceFrom + insertText.length;
    setContext(null);
    onChange(newText);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!context) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => (i + 1) % context.options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => (i - 1 + context.options.length) % context.options.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      acceptSuggestion(context.options[highlighted]);
    } else if (e.key === "Escape") {
      setContext(null);
    }
  }

  const dropdownStyle = useMemo(
    () => (coords ? { left: `${coords.left}px`, top: `${coords.top}px` } : undefined),
    [coords],
  );

  return (
    <div className="conditions-text-editor-wrap">
      <textarea
        ref={textareaRef}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          // Suggestions depend on the NEW value/caret, both only settled
          // after this render commits - see the click/keyup handlers
          // below for why those instead run synchronously.
          requestAnimationFrame(refreshSuggestions);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter" && e.key !== "Tab" && e.key !== "Escape") refreshSuggestions();
        }}
        onClick={refreshSuggestions}
        onBlur={() => {
          // Deferred so a click on a suggestion (which blurs the textarea
          // first) still registers before the dropdown disappears.
          setTimeout(() => setContext(null), 150);
        }}
      />
      {context && (
        <ul className="conditions-autocomplete" style={dropdownStyle}>
          {context.options.map((opt, i) => (
            <li
              key={opt}
              className={i === highlighted ? "active" : ""}
              onMouseEnter={() => setHighlighted(i)}
              // onMouseDown (not onClick) fires before the textarea's own
              // onBlur, so the selection/caret this reads is still valid.
              onMouseDown={(e) => {
                e.preventDefault();
                acceptSuggestion(opt);
              }}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
      {parseErrors.length > 0 && (
        <ul className="conditions-parse-errors">
          {parseErrors.map((err, i) => (
            <li key={i}>
              Line {err.line}: {err.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
