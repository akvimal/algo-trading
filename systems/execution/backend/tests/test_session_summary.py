"""The numbers behind the post-session Telegram summary (app/domain/session_summary.py)."""

import uuid
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

from app.domain import session_summary as ss
from app.domain.performance import TradeRecord

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
DAY = date(2026, 10, 6)


def trade(pnl, *, day=DAY, live=False, auto=False, order_type="limit", stop=95.0, entry=100.0, qty=10, charges=2.0, symbol="NIFTY", reason="target", side="long", minutes=45):
    # 10:00 UTC is 15:30 IST: the same IST day
    exit_time = datetime(day.year, day.month, day.day, 10, 0, tzinfo=timezone.utc)
    return TradeRecord(
        segment="NSE", symbol=symbol, pnl=pnl, entry_price=entry, stop_loss_price=stop, target_price=None, quantity=qty,
        exit_time=exit_time, exit_reason=reason, order_type=order_type,
        entry_setup_tag=None, entry_confidence=None, setup_tag=None, confidence=None, reviewed=False, auto_traded=auto,
        charges=charges, costs_applied=True, live=live, side=side, exit_price=entry + 5, entry_time=exit_time - timedelta(minutes=minutes),
    )


def run(monkeypatch, trades, open_count=0, account=None):
    monkeypatch.setattr(ss, "load_manual_trades", lambda db, user, seg, since=None: trades)
    monkeypatch.setattr(ss, "open_now", lambda db, user, seg: open_count)
    monkeypatch.setattr(ss, "account_view", lambda db, user, seg, day_pnl, month_pnl: account if account is not None else {"day_pnl": day_pnl, "month_pnl": month_pnl})
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


# ---- good and bad are about the plan, not the result ------------------------------------------------------------------------------


def test_a_loss_inside_the_plan_is_good_and_a_win_without_one_is_luck():
    assert ss.classify(trade(-300))["verdict"] == "good_loss"
    assert ss.classify(trade(300))["verdict"] == "good_win"
    lucky = ss.classify(trade(300, stop=None, order_type="market"))
    assert lucky["verdict"] == "lucky_win" and lucky["issues"] == ["no stop", "market entry"]
    avoidable = ss.classify(trade(-300, order_type="market"))
    assert avoidable["verdict"] == "avoidable_loss" and avoidable["issues"] == ["market entry"]
    assert ss.classify(trade(0))["verdict"] == "flat"


def test_closing_by_hand_breaks_the_plan_even_with_a_stop_and_a_limit_entry():
    c = ss.classify(trade(120, reason="manual"))
    assert c["followed"] is False and c["verdict"] == "lucky_win" and c["issues"] == ["closed by hand"]


def test_the_day_splits_into_followed_and_broke_the_plan_with_the_money_each_made(monkeypatch):
    out = run(monkeypatch, [trade(900), trade(-300), trade(250, stop=None, order_type="market"), trade(-260, reason="manual")])
    p = out["paper"]
    assert (p["followed_count"], p["followed_pnl"]) == (2, 600) and (p["broke_count"], p["broke_pnl"]) == (2, -10)


def test_each_trade_is_listed_newest_first_with_its_verdict_levels_and_time_held(monkeypatch):
    out = run(monkeypatch, [trade(900, symbol="TCS", minutes=90), trade(-300, symbol="INFY", stop=None)])
    first = out["paper"]["items"][0]
    assert {"symbol", "side", "pnl", "r", "entry", "exit", "held_minutes", "verdict", "followed", "issues"} <= set(first)
    assert {i["symbol"]: i["verdict"] for i in out["paper"]["items"]} == {"TCS": "good_win", "INFY": "avoidable_loss"}
    assert {i["held_minutes"] for i in out["paper"]["items"]} == {90, 45}


def test_a_long_day_lists_the_first_trades_and_counts_the_rest(monkeypatch):
    out = run(monkeypatch, [trade(10 + i) for i in range(11)])
    assert len(out["paper"]["items"]) == ss.MAX_TRADES_LISTED and out["paper"]["more"] == 3


# ---- the last 30 days and the account ---------------------------------------------------------------------------------------------


def test_thirty_day_stats_use_only_that_window_and_keep_paper_and_live_apart(monkeypatch):
    old = date(2026, 8, 1)
    out = run(monkeypatch, [trade(500), trade(-200), trade(100, day=date(2026, 9, 20)), trade(9999, day=old), trade(700, live=True)])
    paper = out["stats"]["paper"]
    assert paper["trades"] == 3 and paper["net_pnl"] == 400 and round(paper["win_rate_pct"]) == 67 and paper["profit_factor"] == 3.0
    assert out["stats"]["live"]["trades"] == 1 and out["stats"]["live"]["net_pnl"] == 700


def test_the_account_change_for_the_day_and_the_month_come_from_paper_trades_only(monkeypatch):
    out = run(monkeypatch, [trade(500), trade(-200), trade(900, live=True), trade(150, day=date(2026, 10, 1)), trade(77, day=date(2026, 9, 30))])
    assert out["account"] == {"day_pnl": 300, "month_pnl": 450}  # the live trade is not in the paper account; September is not October


class _Q:
    def __init__(self, rows):
        self.rows = rows

    def filter_by(self, **kw):
        return self

    def order_by(self, *a):
        return self

    def first(self):
        return self.rows[0] if self.rows else None

    def all(self):
        return self.rows


def test_the_account_view_works_out_the_percent_change_from_the_start_of_the_day():
    account = SimpleNamespace(id=1, current_balance=102_000, starting_balance=100_000)
    snaps = [SimpleNamespace(snapshot_date=date(2026, 10, 5), starting_balance=100_000, balance=101_000, unrealized_pnl=0, equity=101_000, is_reset_point=False)]

    class DB:
        def query(self, model):
            return _Q([account] if model.__name__ == "Account" else snaps)

    view = ss.account_view(DB(), USER, "NSE", day_pnl=1000.0, month_pnl=2000.0)
    assert view["balance"] == 102_000 and view["day_change"] == 1000.0
    assert round(view["day_change_pct"], 3) == round(1000 / 101_000 * 100, 3)  # against where the day started: 102,000 - 1,000
    assert round(view["since_start_pct"], 2) == 2.0 and view["curve"] == [101_000, 102_000]
    assert ss.account_view(type("D", (), {"query": lambda self, m: _Q([])})(), USER, "NSE", 0.0, 0.0) is None
