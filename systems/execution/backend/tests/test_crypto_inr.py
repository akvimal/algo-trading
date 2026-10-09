"""A crypto trade's P&L is stored in dollars (like its prices); everything that is shown or summed as money gets the rupee figure."""
from datetime import datetime, timezone
from types import SimpleNamespace

from app.domain.performance import TradeRecord, compute_performance
from app.domain.position_manager import _apply_realized_pnl, inr_of


def pos(segment="CRYPTO", at_close=None):
    return SimpleNamespace(segment=segment, usdinr_at_close=at_close, id="p1", pnl=None, exit_price=None, open_fee=None)


def test_inr_of_is_the_value_itself_for_indian_markets():
    assert inr_of(pos("NSE"), 125.0, 90.0) == 125.0
    assert inr_of(pos("MCX"), -40.0, None) == -40.0


def test_inr_of_converts_crypto_at_the_current_rate_while_open():
    assert inr_of(pos(), 50.0, 90.0) == 4500.0


def test_inr_of_uses_the_rate_the_trade_closed_at_even_after_the_rate_changes():
    assert inr_of(pos(at_close=88.0), 50.0, 95.0) == 4400.0


def test_inr_of_has_no_figure_for_crypto_without_any_rate():
    assert inr_of(pos(), 50.0, None) is None
    assert inr_of(pos(), None, 90.0) is None


def test_closing_a_crypto_trade_records_the_rate_it_credited_at_and_credits_rupees():
    p = pos()
    account = SimpleNamespace(current_balance=100000.0, apply_charges=False, slippage_bps=0)
    _apply_realized_pnl(p, account, 50.0, 90.0)
    assert p.pnl == 50.0 and p.usdinr_at_close == 90.0 and account.current_balance == 104500.0


def test_closing_an_indian_trade_records_no_rate():
    p = pos("NSE")
    account = SimpleNamespace(current_balance=100000.0, apply_charges=False, slippage_bps=0)
    _apply_realized_pnl(p, account, 50.0, None)
    assert p.usdinr_at_close is None and account.current_balance == 100050.0


def record(pnl, fx, entry=100.0, stop=90.0, qty=1.0, charges=0.0):
    return TradeRecord(
        segment="CRYPTO", symbol="BTCUSD", pnl=pnl, entry_price=entry, stop_loss_price=stop, target_price=None, quantity=qty,
        exit_time=datetime(2026, 10, 9, tzinfo=timezone.utc), exit_reason=None, order_type=None, entry_setup_tag=None, entry_confidence=None,
        setup_tag=None, confidence=None, reviewed=False, auto_traded=False, charges=charges, fx=fx,
    )


def test_performance_totals_are_in_rupees_but_the_r_multiple_stays_a_ratio():
    stats = compute_performance([record(20.0, 90.0), record(-10.0, 90.0)])
    assert stats.total_pnl == 900.0 and stats.best_trade == 1800.0 and stats.worst_trade == -900.0
    assert stats.avg_r == (2.0 + -1.0) / 2  # 20/10 and -10/10, unaffected by the rate


def test_an_accounts_open_result_is_summed_in_rupees(monkeypatch):
    from app.api.routes import accounts as route

    p = SimpleNamespace(id="a", segment="CRYPTO", user_id="u", usdinr_at_close=None)
    q = SimpleNamespace(id="b", segment="CRYPTO", user_id="u", usdinr_at_close=None)
    monkeypatch.setattr(route, "compute_unrealized_pnl", lambda positions, quote: {"a": (80500.0, 50.0), "b": (80500.0, -10.0)})
    monkeypatch.setattr(route, "_usdinr_rate_by_user", lambda db, positions: {"u": 90.0})
    assert route._unrealized_pnl(None, [p, q]) == 40.0 * 90.0
