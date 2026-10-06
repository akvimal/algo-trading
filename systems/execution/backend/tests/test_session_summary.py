"""The numbers behind the post-session Telegram summary (app/domain/session_summary.py)."""

import uuid
from datetime import date, datetime, timezone

from app.domain import session_summary as ss
from app.domain.performance import TradeRecord

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
DAY = date(2026, 10, 6)


def trade(pnl, *, day=DAY, live=False, auto=False, order_type="limit", stop=95.0, entry=100.0, qty=10, charges=2.0, symbol="NIFTY"):
    # 10:00 UTC is 15:30 IST: the same IST day
    return TradeRecord(
        segment="NSE", symbol=symbol, pnl=pnl, entry_price=entry, stop_loss_price=stop, target_price=None, quantity=qty,
        exit_time=datetime(day.year, day.month, day.day, 10, 0, tzinfo=timezone.utc), exit_reason="target", order_type=order_type,
        entry_setup_tag=None, entry_confidence=None, setup_tag=None, confidence=None, reviewed=False, auto_traded=auto,
        charges=charges, costs_applied=True, live=live,
    )


def run(monkeypatch, trades, open_count=0):
    monkeypatch.setattr(ss, "load_manual_trades", lambda db, user, seg, since=None: trades)
    monkeypatch.setattr(ss, "open_now", lambda db, user, seg: open_count)
    return ss.trader_day(None, USER, "NSE", DAY)


def test_only_the_days_trades_count_and_paper_and_live_stay_apart(monkeypatch):
    out = run(monkeypatch, [trade(500), trade(-200), trade(900, live=True), trade(300, day=date(2026, 10, 5))], open_count=2)
    assert out["paper"]["trades"] == 2 and out["paper"]["net_pnl"] == 300 and (out["paper"]["wins"], out["paper"]["losses"]) == (1, 1)
    assert out["live"]["trades"] == 1 and out["live"]["net_pnl"] == 900
    assert out["open_now"] == 2 and out["segment"] == "NSE" and out["day"] == "2026-10-06"


def test_best_and_worst_carry_the_result_in_r(monkeypatch):
    out = run(monkeypatch, [trade(500), trade(-250)])
    # risk = |100 - 95| * 10 = 50, so +500 is 10R and -250 is -5R
    assert out["paper"]["best"]["r"] == 10.0 and out["paper"]["worst"]["r"] == -5.0


def test_a_day_without_trades_has_no_sections(monkeypatch):
    out = run(monkeypatch, [trade(100, day=date(2026, 10, 5))])
    assert out["paper"] is None and out["live"] is None


def test_the_auto_traders_fills_are_not_the_persons_own_trades(monkeypatch):
    out = run(monkeypatch, [trade(400, auto=True)])
    assert out["paper"] is None


def test_plan_count_is_limit_orders_with_a_stop(monkeypatch):
    out = run(monkeypatch, [trade(1), trade(1, order_type="market"), trade(1, stop=None)])
    assert out["paper"]["trades"] == 3 and out["paper"]["with_plan"] == 1
