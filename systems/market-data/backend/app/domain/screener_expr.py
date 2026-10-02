"""The custom equity screener's expression language - a small, safe grammar
(no eval()/exec(), nothing that can do anything but read a price/indicator
value and compare it), built to say exactly what was asked for:

    weekly_close < min(weekly_low, 20) and ema(5) crosses_below ema(20)
    close > 1500
    weekly_close < min(weekly_low, 20) or close > 1500

Grammar (informal):
    or_expr    := and_expr ("or" and_expr)*
    and_expr   := unary ("and" unary)*
    unary      := "not" unary | comparison
    comparison := value comp_op value          # exactly one comparator - "a < b < c" is not supported
    comp_op    := "<" | "<=" | ">" | ">=" | "==" | "!=" | "crosses_above" | "crosses_below"
    value      := NUMBER | IDENT ["(" value ("," value)* ")"] | "(" or_expr ")"

Bare identifiers (no parens): close, open, high, low - today's latest DAILY
bar; weekly_close, weekly_open, weekly_high, weekly_low - the latest WEEKLY
bar (see app/domain/indicators.py's resample_weekly - may be the current,
still-forming week). The same names take an INTRADAY prefix - m5_, m15_, m30_,
h1_ (5, 15, 30 and 60 minute bars): m15_close, m15_high, m15_ema(20) - the latest
bar of that size, which may still be forming. Intraday bars are not stored: they
are fetched from the exchange feed on demand for each stock the expression
actually gets to (see EvalContext.load_intraday) and are limited per run.
Calls: ema(N) / weekly_ema(N) / m15_ema(N) ... (app/domain/indicators.py's
compute_ema); prev(X) / prev(X, N) - the value N bars BACK in X's own timeframe
(prev(m15_close) is the previous 15 minute bar's close, prev(close, 2) the close
two days ago; N defaults to 1; prev(ema(5), 1) works too); min(X, N) / max(X, N) - the rolling N-period minimum/maximum of
another value (a price identifier or an ema(...) call), over the N periods
BEFORE the point being evaluated - EXCLUDING it (see RollRef's own docstring
for why: a window that included it would make "close < min(low, 20)"
impossible to ever trigger on the very bar that sets the new low) - "min of
the last 20 weeks' low" is min(weekly_low, 20).

Evaluated once per symbol, against its own EvalContext (that symbol's own
daily bars, oldest-first, weekly resampled lazily on first use and cached) -
this is a screener, not a backtest: every AST node's `value`/`prior` are
"as of now" and "one period back", not a full time series. Kept completely
separate from any DB/route concern (same "pure core" split every other
domain module here uses) so parsing and evaluation are both unit-testable
without a session."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol

from app.domain.indicators import compute_ema
from app.domain.models import Candle

_PRICE_FIELDS = {"open", "high", "low", "close"}

# The timeframes a name can be read in, by the prefix that selects them ("" = daily, the default). The intraday ones map to the interval
# name the exchange feed understands.
DAILY, WEEKLY = "daily", "weekly"
INTRADAY_INTERVALS: dict[str, str] = {"m5": "5min", "m15": "15min", "m30": "30min", "h1": "60min"}
_PREFIXES: dict[str, str] = {"weekly_": WEEKLY, "daily_": DAILY, **{f"{tf}_": tf for tf in INTRADAY_INTERVALS}}


def is_intraday(timeframe: str) -> bool:
    return timeframe in INTRADAY_INTERVALS


class IntradayUnavailable(RuntimeError):
    """Raised by an intraday loader that is not allowed (or not able) to fetch more bars for this run - the stock is skipped, not failed,
    and reported as skipped in the result."""
_COMPARATORS: dict[str, Callable[[float, float], bool]] = {
    "<": lambda a, b: a < b,
    "<=": lambda a, b: a <= b,
    ">": lambda a, b: a > b,
    ">=": lambda a, b: a >= b,
    "==": lambda a, b: a == b,
    "!=": lambda a, b: a != b,
}
_CROSS_OPS = {"crosses_above", "crosses_below"}
_KEYWORDS = {"and", "or", "not"} | _CROSS_OPS


class ExpressionError(ValueError):
    """A screener expression that does not parse - always carries a plain-
    language reason, since this is shown straight back to whoever typed it."""


# ---- tokenizer ---------------------------------------------------------------------------------------------

_TOKEN_RE = re.compile(
    r"""
    \s*(?:
        (?P<number>\d+(?:\.\d+)?)
      | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
      | (?P<le><=) | (?P<ge>>=) | (?P<eq>==) | (?P<ne>!=)
      | (?P<lt><) | (?P<gt>>)
      | (?P<lparen>\() | (?P<rparen>\)) | (?P<comma>,)
    )""",
    re.VERBOSE,
)


@dataclass
class _Token:
    kind: str
    text: str


def _tokenize(text: str) -> list[_Token]:
    tokens: list[_Token] = []
    pos = 0
    n = len(text)
    while pos < n:
        if text[pos].isspace():
            pos += 1
            continue
        m = _TOKEN_RE.match(text, pos)
        if not m or m.end() == pos:
            raise ExpressionError(f"Can't make sense of '{text[pos:pos + 12].strip()}' - unexpected character.")
        kind = m.lastgroup
        assert kind is not None
        tokens.append(_Token(kind, m.group(kind)))
        pos = m.end()
    return tokens


# ---- AST ----------------------------------------------------------------------------------------------------


@dataclass
class EvalContext:
    """One symbol's own bars - daily oldest-first (as fetched); weekly is
    resampled lazily on first reference and cached, since not every
    expression needs it. `_ema_cache` avoids recomputing the same ema(N)
    series twice within one expression (e.g. "ema(20) crosses_above ema(20)"
    referencing it from both sides of a comparison, or two conditions
    sharing a term)."""

    daily_bars: list[Candle]
    # Intraday bars are fetched lazily, only for a stock whose evaluation reaches an intraday name, by this loader: it takes the interval
    # ("15min") and returns the bars oldest-first, or raises IntradayUnavailable. None (the default) means there is no intraday feed here.
    load_intraday: Optional[Callable[[str], list[Candle]]] = None
    _weekly_bars: Optional[list[Candle]] = field(default=None, repr=False)
    _intraday_bars: dict[str, list[Candle]] = field(default_factory=dict, repr=False)
    _ema_cache: dict[tuple[str, int], list[Optional[float]]] = field(default_factory=dict, repr=False)

    def bars(self, timeframe: str) -> list[Candle]:
        if timeframe == DAILY:
            return self.daily_bars
        if timeframe == WEEKLY:
            if self._weekly_bars is None:
                from app.domain.indicators import resample_weekly

                self._weekly_bars = resample_weekly(self.daily_bars)
            return self._weekly_bars
        if timeframe not in self._intraday_bars:
            if self.load_intraday is None:
                raise IntradayUnavailable("no intraday data is available for this screen")
            self._intraday_bars[timeframe] = self.load_intraday(INTRADAY_INTERVALS[timeframe])
        return self._intraday_bars[timeframe]

    def ema_series(self, timeframe: str, period: int) -> list[Optional[float]]:
        key = (timeframe, period)
        if key not in self._ema_cache:
            closes = [b.close for b in self.bars(timeframe)]
            self._ema_cache[key] = compute_ema(closes, period)
        return self._ema_cache[key]


class Node(Protocol):
    def value_at(self, ctx: EvalContext, back: int) -> Optional[float]:
        """The value `back` periods before the latest one (0 = latest, 1 =
        one before that, in this node's OWN timeframe) - None if there is
        not enough history yet."""
        ...


@dataclass
class Literal:
    number: float

    def value_at(self, ctx: EvalContext, back: int) -> Optional[float]:
        return self.number  # a constant reads the same at any point


@dataclass
class PriceRef:
    field: str  # one of _PRICE_FIELDS
    timeframe: str = DAILY

    def value_at(self, ctx: EvalContext, back: int) -> Optional[float]:
        bars = ctx.bars(self.timeframe)
        i = len(bars) - 1 - back
        return getattr(bars[i], self.field) if 0 <= i < len(bars) else None


@dataclass
class EmaRef:
    period: int
    timeframe: str = DAILY

    def value_at(self, ctx: EvalContext, back: int) -> Optional[float]:
        series = ctx.ema_series(self.timeframe, self.period)
        i = len(series) - 1 - back
        return series[i] if 0 <= i < len(series) else None


@dataclass
class ShiftRef:
    """`inner` as it was `periods` bars ago, in inner's OWN timeframe - prev(m15_close) is the previous 15 minute bar's close, prev(close, 3)
    the close three days back. Stacks with everything else (a crossover of prev(ema(5)) and so on), since a Node is already "the value `back`
    bars before the latest"."""

    inner: Node
    periods: int

    def value_at(self, ctx: EvalContext, back: int) -> Optional[float]:
        return self.inner.value_at(ctx, back + self.periods)


@dataclass
class RollRef:
    """The rolling min/max of `inner` over the `window` periods BEFORE
    `back` - deliberately excluding `back` itself. A rolling window that
    included the reference point would make "close < min(low, 20)" true
    only when an EARLIER period's low undercuts even the reference bar's
    own low (since a bar's close can never be below its own low) - useless
    for exactly the "N-period breakout" screens this exists for, which need
    to fire on the very bar that sets the new extreme. Standard breakout-
    screen convention (Donchian channels, "new 52-week low" scans, ...)
    compares against the PRECEDING N periods for the same reason."""

    inner: Node
    window: int
    kind: str  # "min" or "max"

    def value_at(self, ctx: EvalContext, back: int) -> Optional[float]:
        values = [self.inner.value_at(ctx, back + 1 + k) for k in range(self.window)]
        if any(v is None for v in values):
            return None
        return min(values) if self.kind == "min" else max(values)


@dataclass
class Comparison:
    left: Node
    op: str
    right: Node

    def evaluate(self, ctx: EvalContext) -> bool:
        if self.op in _CROSS_OPS:
            lv, lp = self.left.value_at(ctx, 0), self.left.value_at(ctx, 1)
            rv, rp = self.right.value_at(ctx, 0), self.right.value_at(ctx, 1)
            if None in (lv, lp, rv, rp):
                return False
            if self.op == "crosses_above":
                return lp <= rp and lv > rv
            return lp >= rp and lv < rv  # crosses_below
        lv, rv = self.left.value_at(ctx, 0), self.right.value_at(ctx, 0)
        if lv is None or rv is None:
            return False
        return _COMPARATORS[self.op](lv, rv)


@dataclass
class BoolOp:
    op: str  # "and" or "or"
    operands: list["Condition"]

    def evaluate(self, ctx: EvalContext) -> bool:
        results = (c.evaluate(ctx) for c in self.operands)
        return all(results) if self.op == "and" else any(results)


@dataclass
class Not:
    inner: "Condition"

    def evaluate(self, ctx: EvalContext) -> bool:
        return not self.inner.evaluate(ctx)


Condition = Comparison | BoolOp | Not


# ---- parser ---------------------------------------------------------------------------------------------------


class _Parser:
    def __init__(self, tokens: list[_Token], source: str):
        self.tokens = tokens
        self.source = source
        self.pos = 0

    def _peek(self) -> Optional[_Token]:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def _is_ident(self, *words: str) -> bool:
        t = self._peek()
        return t is not None and t.kind == "ident" and t.text.lower() in words

    def _advance(self) -> _Token:
        t = self._peek()
        if t is None:
            raise ExpressionError("The expression ends too soon - something is missing.")
        self.pos += 1
        return t

    def _expect(self, kind: str, what: str) -> _Token:
        t = self._peek()
        if t is None or t.kind != kind:
            raise ExpressionError(f"Expected {what}" + (f", found '{t.text}'" if t else " at the end of the expression") + ".")
        return self._advance()

    def parse(self) -> Condition:
        node = self._or_expr()
        if self._peek() is not None:
            raise ExpressionError(f"Unexpected '{self._peek().text}' after a complete expression.")  # type: ignore[union-attr]
        return node

    def _or_expr(self) -> Condition:
        operands = [self._and_expr()]
        while self._is_ident("or"):
            self._advance()
            operands.append(self._and_expr())
        return operands[0] if len(operands) == 1 else BoolOp("or", operands)

    def _and_expr(self) -> Condition:
        operands = [self._unary()]
        while self._is_ident("and"):
            self._advance()
            operands.append(self._unary())
        return operands[0] if len(operands) == 1 else BoolOp("and", operands)

    def _unary(self) -> Condition:
        # "not" applies to one comparison ("not close > 100 and high > 50" is
        # "(not (close > 100)) and (high > 50)", same precedence as a normal
        # reading of the words) - there is no parenthesised AND/OR grouping;
        # and/or read strictly left to right (see _or_expr/_and_expr). A
        # parenthesis always wraps a VALUE (see _value), never a whole
        # condition - not needed for anything in this language's own grammar
        # (every comparator takes exactly one left/right value, and min/max/ema
        # already use parens for their own arguments).
        if self._is_ident("not"):
            self._advance()
            return Not(self._unary())
        return self._comparison()

    def _is_comp_op(self) -> bool:
        t = self._peek()
        if t is None:
            return False
        if t.kind in ("le", "ge", "eq", "ne", "lt", "gt"):
            return True
        return t.kind == "ident" and t.text.lower() in _CROSS_OPS

    def _comparison(self) -> Comparison:
        left = self._value()
        if not self._is_comp_op():
            t = self._peek()
            raise ExpressionError(
                "Expected a comparison here (e.g. 'close < 100') - "
                + (f"found '{t.text}'" if t else "the expression ended")
                + "."
            )
        op_tok = self._advance()
        op = {"le": "<=", "ge": ">=", "eq": "==", "ne": "!=", "lt": "<", "gt": ">"}.get(op_tok.kind, op_tok.text.lower())
        right = self._value()
        return Comparison(left, op, right)

    def _value(self) -> Node:
        t = self._peek()
        if t is None:
            raise ExpressionError("Expected a value (a price, an indicator, or a number).")
        if t.kind == "number":
            self._advance()
            return Literal(float(t.text))
        if t.kind == "lparen":
            self._advance()
            inner = self._value()
            self._expect("rparen", "')'")
            return inner
        if t.kind == "ident":
            return self._identifier_value()
        raise ExpressionError(f"Expected a value, found '{t.text}'.")

    def _identifier_value(self) -> Node:
        t = self._advance()
        name = t.text.lower()
        if name in _KEYWORDS:
            raise ExpressionError(f"'{t.text}' can't be used as a value here.")

        timeframe = DAILY
        bare = name
        for prefix, tf in _PREFIXES.items():
            if name.startswith(prefix):
                timeframe, bare = tf, name[len(prefix):]
                break

        has_args = self._peek() is not None and self._peek().kind == "lparen"  # type: ignore[union-attr]

        if bare in _PRICE_FIELDS and not has_args:
            return PriceRef(bare, timeframe)
        if bare == "ema":
            args = self._call_args(name)
            if len(args) != 1 or not isinstance(args[0], Literal):
                raise ExpressionError(f"'{name}(...)' needs exactly one number, the EMA period - e.g. {name}(20).")
            return EmaRef(int(args[0].number), timeframe)
        if name == "prev":
            args = self._call_args(name)
            if len(args) not in (1, 2) or (len(args) == 2 and not isinstance(args[1], Literal)):
                raise ExpressionError("'prev(value)' or 'prev(value, N)' - the value one bar back, or N bars back - e.g. prev(m15_close) or prev(close, 2).")
            periods = 1 if len(args) == 1 else int(args[1].number)  # type: ignore[union-attr]
            if periods < 1:
                raise ExpressionError("prev(value, N) needs N of 1 or more - 1 is the previous bar.")
            return ShiftRef(args[0], periods)
        if name in ("min", "max"):
            args = self._call_args(name)
            if len(args) != 2 or not isinstance(args[1], Literal):
                raise ExpressionError(f"'{name}(series, N)' needs a value and a whole-number window - e.g. {name}(low, 20).")
            return RollRef(args[0], int(args[1].number), name)
        if bare in _PRICE_FIELDS and has_args:
            raise ExpressionError(f"'{name}' does not take arguments - use '{name}' on its own.")
        raise ExpressionError(
            f"Unknown name '{t.text}'. Expected one of: close, open, high, low (daily); weekly_close ...; m5_/m15_/m30_/h1_close ...; "
            "ema(N); prev(x) or prev(x, N); min(x, N), max(x, N)."
        )

    def _call_args(self, name: str) -> list[Node]:
        self._expect("lparen", f"'(' after {name}")
        if self._peek() is not None and self._peek().kind == "rparen":  # type: ignore[union-attr]
            self._advance()
            return []  # e.g. "ema()" - let the caller give the specific "needs N args" message
        args = [self._value()]
        while self._peek() is not None and self._peek().kind == "comma":  # type: ignore[union-attr]
            self._advance()
            args.append(self._value())
        self._expect("rparen", f"')' to close {name}(...)")
        return args


def parse_expression(text: str) -> Condition:
    """Raises ExpressionError with a plain-language reason on anything that
    does not parse - never a raw traceback, since this is shown straight
    back to whoever typed it."""
    if not text or not text.strip():
        raise ExpressionError("Type a condition, e.g. 'close > 100'.")
    return _Parser(_tokenize(text), text).parse()


def evaluate_expression(condition: Condition, ctx: EvalContext) -> bool:
    return condition.evaluate(ctx)


def expression_timeframes(condition: Condition) -> set[str]:
    """Every timeframe the expression reads (daily, weekly, m15 ...), so a caller can tell whether it needs intraday data at all."""
    found: set[str] = set()

    def walk(node: object) -> None:
        if isinstance(node, (PriceRef, EmaRef)):
            found.add(node.timeframe)
        elif isinstance(node, (ShiftRef, RollRef)):
            walk(node.inner)
        elif isinstance(node, Comparison):
            walk(node.left)
            walk(node.right)
        elif isinstance(node, BoolOp):
            for operand in node.operands:
                walk(operand)
        elif isinstance(node, Not):
            walk(node.inner)

    walk(condition)
    return found
