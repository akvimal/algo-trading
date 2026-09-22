"""Pure-function tests for the performance aggregation - the DB-backed
save/trade/list routes themselves follow this repo's existing convention
(see tests/generation/test_watchlist.py's own docstring) of being verified
live against the running dev stack rather than with a fake Session/
TestClient here."""
from datetime import datetime, timezone

from app.domain.weekly_advisor.journal import TradeLeg, TradeOut, compute_performance_summary, unrealized_pnl


def _trade(status, symbol="TCS", realized_pnl=None, quantity=1, legs=None) -> TradeOut:
    return TradeOut(
        id="t1", recommendation_id="r1", symbol=symbol, action="short_strangle", status=status,
        quantity=quantity, entry_credit=None, entry_notes=None, taken_at=datetime.now(timezone.utc),
        exit_debit=None, realized_pnl=realized_pnl, exit_notes=None,
        closed_at=datetime.now(timezone.utc) if status == "closed" else None,
        legs=legs,
    )


def test_summary_with_no_trades():
    summary = compute_performance_summary([])
    assert summary.open_count == 0
    assert summary.closed_count == 0
    assert summary.win_rate is None
    assert summary.total_realized_pnl == 0


def test_summary_counts_open_separately_from_closed():
    trades = [_trade("open"), _trade("open"), _trade("closed", realized_pnl=100.0)]
    summary = compute_performance_summary(trades)
    assert summary.open_count == 2
    assert summary.closed_count == 1


def test_summary_win_rate_and_totals():
    trades = [
        _trade("closed", symbol="TCS", realized_pnl=500.0),
        _trade("closed", symbol="TCS", realized_pnl=-200.0),
        _trade("closed", symbol="ABB", realized_pnl=300.0),
    ]
    summary = compute_performance_summary(trades)
    assert summary.win_count == 2
    assert summary.loss_count == 1
    assert summary.win_rate == round(2 / 3, 3)
    assert summary.total_realized_pnl == 600.0
    assert summary.by_symbol == {"TCS": 300.0, "ABB": 300.0}


def test_summary_excludes_closed_trade_with_no_pnl_entered_from_win_loss_math():
    trades = [_trade("closed", realized_pnl=None), _trade("closed", realized_pnl=50.0)]
    summary = compute_performance_summary(trades)
    assert summary.closed_count == 2
    assert summary.win_count == 1
    assert summary.win_rate == 1.0
    assert summary.total_realized_pnl == 50.0


def test_a_break_even_closed_trade_counts_as_a_loss_not_a_win():
    trades = [_trade("closed", realized_pnl=0.0)]
    summary = compute_performance_summary(trades)
    assert summary.win_count == 0
    assert summary.loss_count == 1


def test_summary_counts_expired_separately_from_open_and_closed():
    trades = [_trade("open"), _trade("expired"), _trade("expired"), _trade("closed", realized_pnl=10.0)]
    summary = compute_performance_summary(trades)
    assert summary.open_count == 1
    assert summary.expired_count == 2
    assert summary.closed_count == 1


# --- unrealized_pnl: mark-to-market from each leg's current_price vs. entry_price ---


def test_unrealized_pnl_none_when_trade_is_closed():
    trade = _trade("closed", legs=[TradeLeg(option_type="PE", strike=100, side="sell", entry_price=10.0, current_price=5.0)])
    assert unrealized_pnl(trade) is None


def test_unrealized_pnl_none_when_no_legs():
    assert unrealized_pnl(_trade("open", legs=None)) is None
    assert unrealized_pnl(_trade("open", legs=[])) is None


def test_unrealized_pnl_none_when_any_leg_missing_entry_or_current_price():
    trade = _trade("open", legs=[
        TradeLeg(option_type="PE", strike=100, side="sell", entry_price=10.0, current_price=None),
    ])
    assert unrealized_pnl(trade) is None


def test_unrealized_pnl_sell_leg_profits_as_price_falls():
    # Sold at 10, now worth 6 -> +4 profit per unit, x quantity 5 -> +20.
    trade = _trade("open", quantity=5, legs=[
        TradeLeg(option_type="PE", strike=100, side="sell", entry_price=10.0, current_price=6.0),
    ])
    assert unrealized_pnl(trade) == 20.0


def test_unrealized_pnl_buy_leg_profits_as_price_rises():
    # Bought at 5, now worth 8 -> +3 profit per unit, x quantity 2 -> +6.
    trade = _trade("open", quantity=2, legs=[
        TradeLeg(option_type="PE", strike=90, side="buy", entry_price=5.0, current_price=8.0),
    ])
    assert unrealized_pnl(trade) == 6.0


def test_unrealized_pnl_combines_multiple_legs():
    # A bull put spread: sold 10->6 (+4), bought 5->3 (-2) -> net +2, x1.
    trade = _trade("open", quantity=1, legs=[
        TradeLeg(option_type="PE", strike=100, side="sell", entry_price=10.0, current_price=6.0),
        TradeLeg(option_type="PE", strike=90, side="buy", entry_price=5.0, current_price=3.0),
    ])
    assert unrealized_pnl(trade) == 2.0
