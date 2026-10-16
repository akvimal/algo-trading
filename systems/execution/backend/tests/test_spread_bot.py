"""The intraday credit-spread bot (app/domain/spread_bot.py): the four reads and when they agree, the OI-wall spread, the 1% sizing, and one cycle."""

import uuid
from datetime import datetime, time as dt_time, timezone
from types import SimpleNamespace

import pytest

from app.domain import spread_bot as bot

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
# Monday 2026-10-12 11:00 in Mumbai: inside the market and the entry window
OPEN_NOW = datetime(2026, 10, 12, 5, 30, tzinfo=timezone.utc)


# --- the reads ------------------------------------------------------------------------------------------------------------


def test_each_read_leans_up_down_or_nowhere():
    v = bot.read_votes({"regime": "trending_up"}, {"direction": "bearish"}, {"trend": "range"}, None)
    assert v == {"trend": 1, "oi": -1, "structure": 0, "premarket": 0}


def test_it_acts_only_when_enough_agree_and_none_disagree():
    assert bot.decide_bias({"trend": 1, "oi": 1, "structure": 1, "premarket": 0}, 3)[0] == "BUY"
    assert bot.decide_bias({"trend": -1, "oi": -1, "structure": 0, "premarket": -1}, 3)[0] == "SELL"
    assert bot.decide_bias({"trend": 1, "oi": 1, "structure": 0, "premarket": 0}, 3)[0] is None  # two is not enough
    bias, why = bot.decide_bias({"trend": 1, "oi": 1, "structure": 1, "premarket": -1}, 3)  # one against vetoes it
    assert bias is None and "disagree" in why


# --- the spread -------------------------------------------------------------------------------------------------------------


def leg(oi, ltp):
    return {"oi": oi, "last_price": ltp}


def chain(spot=24512.0):
    # strikes every 50; the put wall is 24400 (huge put OI), the call wall 24700
    rows = []
    for k in range(24000, 25000, 50):
        pe_oi = 900_000 if k == 24400 else 100_000
        ce_oi = 800_000 if k == 24700 else 100_000
        pe_ltp = max(2.0, 40 - (spot - k) * 0.12) if k < spot else 30 + (k - spot) * 0.8
        ce_ltp = max(2.0, 40 - (k - spot) * 0.12) if k > spot else 30 + (spot - k) * 0.8
        rows.append({"strike": float(k), "ce": leg(ce_oi, round(ce_ltp, 2)), "pe": leg(pe_oi, round(pe_ltp, 2))})
    return {"underlying_last_price": spot, "strikes": rows}


def test_bullish_sells_the_put_wall_below_the_price_and_buys_two_strikes_further_out():
    s = bot.pick_spread(chain(), "BUY", 2)
    assert (s["side"], s["short_strike"], s["long_strike"]) == ("pe", 24400.0, 24300.0)
    assert s["width"] == 100 and 0 < s["credit"] < 100 and s["max_loss_per_unit"] == pytest.approx(100 - s["credit"])


def test_bearish_sells_the_call_wall_above_the_price():
    s = bot.pick_spread(chain(), "SELL", 2)
    assert (s["side"], s["short_strike"], s["long_strike"]) == ("ce", 24700.0, 24800.0)


def test_no_spread_when_there_is_no_open_interest_a_long_leg_or_enough_credit():
    assert isinstance(bot.pick_spread({"underlying_last_price": 100.0, "strikes": []}, "BUY", 2), str)
    c = chain()
    c["strikes"] = [r for r in c["strikes"] if r["strike"] >= 24350]  # the long leg would fall off the chain
    assert "far enough" in bot.pick_spread(c, "BUY", 2)
    thin = chain()
    for r in thin["strikes"]:
        r["pe"]["last_price"] = 5.0  # every put pays the same: no credit
    assert isinstance(bot.pick_spread(thin, "BUY", 2), str)


def test_size_is_the_most_lots_whose_max_loss_fits_one_percent():
    assert bot.lots_for(1_000_000, 1, 50, 75) == 2  # 3750 a lot, 10000 allowed
    assert bot.lots_for(1_000_000, 1, 50, 300) == 0  # 15000 a lot: not even one
    assert bot.lots_for(1_000_000, 1, 0, 75) == 0
    # the account's per-trade capital caps it too: 1% of 13.3M would allow 33 lots, 50,000 only 12 at 4,033 a lot... and 0 at 75,000 a lot
    assert bot.lots_for(13_300_000, 1, 62, 65, 50_000) == 12
    assert bot.lots_for(13_300_000, 1, 62, 65, None) == 33
    assert bot.lots_for(13_300_000, 1, 1000, 75, 50_000) == 0


def test_the_spreads_own_stop_and_target_follow_the_tickets_arithmetic():
    s = {"long_ltp": 10.0, "short_ltp": 30.0, "credit": 20.0, "max_loss_per_unit": 80.0}
    stop, target = bot.combined_levels(s)
    assert (stop, target) == (-20.0 - 40.0, -20.0 + 14.0)


# --- one cycle -------------------------------------------------------------------------------------------------------------


class Q:
    """A tiny query stand-in: counts rows by the model the bot asks about."""

    def __init__(self, db, model):
        self.db, self.model = db, model

    def filter(self, *a):
        return self

    def count(self):
        return self.db.counts.get(self.model.__name__, 0)

    def all(self):
        return list(getattr(self.db, "closed", [])) if self.model.__name__ == "OptionPositionGroup" else []

    def first(self):
        if not self.db.counts.get(self.model.__name__, 0):
            return None
        return SimpleNamespace(id="g1", underlying_symbol="NIFTY", strategy_type="credit_spread", entry_time=datetime(2026, 10, 12, 4, 30, tzinfo=timezone.utc))


class FakeDb:
    def __init__(self, **counts):
        self.counts, self.added, self.commits, self.closed = counts, [], 0, []

    def query(self, model):
        return Q(self, model)

    def add(self, row):
        self.added.append(row)

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass


def cfg(**o):
    return SimpleNamespace(user_id=ALICE, enabled=True, risk_pct=1, symbols="NIFTY", entry_from=dt_time(9, 45), entry_to=dt_time(13, 30), min_votes=3, width_strikes=2, max_trades_per_day=2, **o)


GOOD_READS = {
    "/regime": {"regime": "trending_up"}, "/order-blocks": {"trend": "up"}, "/premarket": {"day": "2026-10-12", "bias": "bullish"},
    "/options/sentiment-history": {"points": [{"recorded_at": "2026-10-12T05:25:00Z", "direction": "bullish"}]},
}


def fake_deps(reads=None, group_status="OPEN", **over):
    reads = reads if reads is not None else GOOD_READS
    opened, attached, deps_strategies = [], [], []

    def get_json(path, params):
        value = reads[path]
        if isinstance(value, Exception):
            raise value
        return value

    def open_group(db, user_id, symbol, action, strategy, short, long, expiry, lots, notes):
        opened.append((symbol, action, short, long, expiry, lots, notes))
        deps_strategies.append(strategy)
        return SimpleNamespace(id=uuid.uuid4(), status=group_status, rejection_reason="nope")

    deps = bot.BotDeps(
        get_json=get_json, get_expiry_list=lambda ex, sym: ["2026-10-12", "2026-10-20"], get_option_chain=lambda ex, sym, e: chain(),
        get_lot_size=lambda ex, sym: 75, open_group=open_group,
        set_spot_stop=lambda db, u, g, p: attached.append(("spot", p)), set_combined_stop=lambda db, u, g, p: attached.append(("stop", p)),
        set_combined_target=lambda db, u, g, p: attached.append(("target", p)),
    )
    for k, v in over.items():
        setattr(deps, k, v)
    deps.attached, deps.opened, deps.strategies = attached, opened, deps_strategies
    return deps


@pytest.fixture(autouse=True)
def account(monkeypatch):
    from app.domain import position_manager as pm

    state = SimpleNamespace(live_trading_enabled=False, current_balance=1_000_000, capital_per_trade=1_000_000)
    monkeypatch.setattr(pm, "load_account", lambda db, uid, seg, book="intraday": state)
    return state


def test_agreeing_reads_open_a_put_spread_on_the_wall_sized_to_one_percent_with_its_protection():
    db, deps = FakeDb(), fake_deps()
    counts = bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)
    assert counts == {"entered": 1, "skipped": 0, "failed": 0}
    symbol, action, short, long, expiry, lots, notes = deps.opened[0]
    assert (symbol, action, short, long) == ("NIFTY", "BUY", 24400.0, 24300.0)
    assert expiry == "2026-10-20"  # never today's expiry
    assert lots >= 1 and "OI wall" in notes
    assert [k for k, _ in deps.attached] == ["spot", "stop", "target"] and deps.attached[0][1] == 24400.0
    d = db.added[-1]
    assert d.outcome == "entered" and d.votes == {"trend": 1, "oi": 1, "structure": 1, "premarket": 1} and d.detail["short_strike"] == 24400.0


TREND = {"regime": "trending_up", "adx": 31.0, "atr_percentile": 40}
ALL_UP = {"trend": 1, "oi": 1, "structure": 1, "premarket": 1}


def test_the_default_mode_always_sells_the_credit_spread():
    assert bot.choose_strategy("BUY", ALL_UP, TREND, "credit_spread", 3)[0] == "credit_spread"


def test_auto_buys_the_move_only_on_a_strong_aligned_trend():
    assert bot.choose_strategy("BUY", ALL_UP, TREND, "auto", 3)[0] == "naked"
    assert bot.choose_strategy("BUY", ALL_UP, {**TREND, "atr_percentile": 80}, "auto", 3)[0] == "debit_spread"  # dear premiums: capped spread
    assert bot.choose_strategy("BUY", ALL_UP, {**TREND, "adx": 20}, "auto", 3)[0] == "credit_spread"  # weak trend
    assert bot.choose_strategy("BUY", ALL_UP, {**TREND, "regime": "ranging"}, "auto", 3)[0] == "credit_spread"
    assert bot.choose_strategy("SELL", ALL_UP, TREND, "auto", 3)[0] == "credit_spread"  # the trend is up, the bias is down
    assert bot.choose_strategy("BUY", ALL_UP, None, "auto", 3)[0] == "credit_spread"  # no regime read: the safe default
    assert bot.choose_strategy("BUY", {**ALL_UP, "oi": 0, "premarket": 0}, TREND, "auto", 2)[0] == "credit_spread"  # only two reads agree


def test_a_long_option_is_the_strike_nearest_the_price_and_a_debit_spread_adds_a_short_leg_further_out():
    n = bot.pick_directional(chain(), "BUY", "naked", 2)
    assert (n["side"], n["long_strike"], n["short_strike"]) == ("ce", 24500.0, None) and n["max_loss_per_unit"] == n["long_ltp"]
    d = bot.pick_directional(chain(), "BUY", "debit_spread", 2)
    assert (d["long_strike"], d["short_strike"], d["width"]) == (24500.0, 24600.0, 100.0) and 0 < d["debit"] < 100
    p = bot.pick_directional(chain(), "SELL", "debit_spread", 2)
    assert (p["side"], p["long_strike"], p["short_strike"]) == ("pe", 24500.0, 24400.0)
    assert isinstance(bot.pick_directional({"underlying_last_price": 100.0, "strikes": []}, "BUY", "naked", 2), str)


def test_a_bought_option_is_stopped_after_losing_forty_percent_and_targets_sixty_percent_more():
    stop, target = bot.combined_levels({"style": "naked", "long_ltp": 50.0, "short_ltp": 0.0, "max_loss_per_unit": 50.0})
    assert (stop, target) == (30.0, 80.0)
    stop, target = bot.combined_levels({"style": "debit_spread", "long_ltp": 60.0, "short_ltp": 20.0, "width": 100.0, "max_loss_per_unit": 40.0})
    assert (stop, target) == (24.0, 40.0 + 0.6 * 60.0)


def test_auto_mode_enters_a_long_option_on_a_strong_trend_with_no_underlying_stop():
    db = FakeDb()
    deps = fake_deps(reads={**GOOD_READS, "/regime": {**TREND, "regime": "trending_up"}})
    counts = bot.run_bot_for_user(db, cfg(strategy_mode="auto"), deps, OPEN_NOW)
    assert counts["entered"] == 1 and deps.strategies == ["naked"]
    assert deps.opened[0][2:4] == (24500.0, None)
    assert [k for k, _ in deps.attached] == ["stop", "target"]  # a bought option has no OI wall to stop on
    d = db.added[-1]
    assert d.detail["strategy"] == "naked" and "long option" in d.reason


def test_auto_mode_falls_back_to_the_credit_spread_without_a_strong_trend():
    deps = fake_deps(reads={**GOOD_READS, "/regime": {"regime": "trending_up", "adx": 19.0, "atr_percentile": 40}})
    bot.run_bot_for_user(FakeDb(), cfg(strategy_mode="auto"), deps, OPEN_NOW)
    assert deps.strategies == ["credit_spread"]


def test_disagreement_is_recorded_as_a_skip_with_the_reads():
    db = FakeDb()
    deps = fake_deps(reads={"/regime": {"regime": "trending_up"}, "/order-blocks": {"trend": "down"}, "/premarket": None, "/options/sentiment-history": None})
    counts = bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)
    assert counts["skipped"] == 1 and deps.opened == []
    assert db.added[-1].outcome == "skipped" and db.added[-1].votes["structure"] == -1


def test_a_failed_read_counts_as_no_lean_and_is_recorded():
    db = FakeDb()
    deps = fake_deps(reads={**GOOD_READS, "/regime": RuntimeError("boom")})
    bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)  # three of four still agree
    assert deps.opened and "regime" in db.added[-1].detail["errors"]


def test_nothing_happens_outside_the_market_the_window_a_live_account_or_a_spread_already_open(account):
    closed = datetime(2026, 10, 12, 13, 0, tzinfo=timezone.utc)  # 18:30 in Mumbai
    early = datetime(2026, 10, 12, 4, 0, tzinfo=timezone.utc)  # 09:30: before the entry window
    deps, db = fake_deps(), FakeDb()
    assert bot.run_bot_for_user(db, cfg(), deps, closed) == {"entered": 0, "skipped": 0, "failed": 0} and deps.opened == [] and db.added == []  # shut: silent
    deps, db = fake_deps(), FakeDb()
    assert bot.run_bot_for_user(db, cfg(), deps, early)["entered"] == 0 and deps.opened == []
    assert "Outside the entry window" in db.added[-1].reason and db.added[-1].detail["status"]  # a heartbeat, not silence
    account.live_trading_enabled = True
    deps, db = fake_deps(), FakeDb()
    assert bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)["entered"] == 0 and deps.opened == [] and db.added == []
    account.live_trading_enabled = False
    deps, db = fake_deps(), FakeDb(OptionPositionGroup=1)
    assert bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)["entered"] == 0 and deps.opened == []  # one at a time
    assert db.added[-1].reason.startswith("Holding NIFTY") and db.added[-1].detail["group_id"] == "g1"
    deps, db = fake_deps(), FakeDb(SpreadBotDecision=2)
    assert bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)["entered"] == 0 and "limit" in db.added[-1].reason  # the day's limit


def test_a_day_that_has_lost_the_daily_limit_stops_looking_for_entries(account):
    # balance 1,000,000 and the default 2%: 20,000 allowed. Two stopped-out trades today lost 12,000 + 9,000.
    db, deps = FakeDb(), fake_deps()
    db.closed = [SimpleNamespace(pnl=-12_000), SimpleNamespace(pnl=-9_000)]
    assert bot.run_bot_for_user(db, cfg(daily_loss_pct=2), deps, OPEN_NOW)["entered"] == 0 and deps.opened == []
    assert "Daily loss limit reached" in db.added[-1].reason and db.added[-1].detail["lost_today"] == 21_000 and db.added[-1].detail["status"]
    # a win in between nets the day back inside the limit
    db, deps = FakeDb(), fake_deps()
    db.closed = [SimpleNamespace(pnl=-12_000), SimpleNamespace(pnl=5_000)]
    assert bot.run_bot_for_user(db, cfg(daily_loss_pct=2), deps, OPEN_NOW)["entered"] == 1
    # a limit left unset is the old behaviour
    db, deps = FakeDb(), fake_deps()
    db.closed = [SimpleNamespace(pnl=-900_000)]
    assert bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)["entered"] == 1


def test_a_balance_too_small_for_one_lot_skips_and_says_what_one_lot_risks(account):
    account.current_balance = 20_000
    db, deps = FakeDb(), fake_deps()
    bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)
    assert deps.opened == [] and "more than 1% of the balance" in db.added[-1].reason


def test_the_per_trade_capital_caps_the_lots_and_a_lot_that_does_not_fit_is_skipped_with_that_reason(account):
    account.capital_per_trade = 1  # far below what one lot risks
    db, deps = FakeDb(), fake_deps()
    bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)
    assert deps.opened == [] and "capital per trade" in db.added[-1].reason


def test_a_rejected_order_is_a_failure_and_a_missing_attachment_is_flagged():
    db, deps = FakeDb(), fake_deps(group_status="REJECTED")
    assert bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)["failed"] == 1

    def refuse(*a):
        raise RuntimeError("refused")

    db, deps = FakeDb(), fake_deps(set_combined_stop=refuse)
    bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)
    assert db.added[-1].outcome == "entered" and "NOT ATTACHED" in db.added[-1].reason


def test_the_scheduler_pass_runs_every_enabled_user(monkeypatch):
    calls = []
    monkeypatch.setattr(bot, "run_bot_for_user", lambda db, c, d, now, cache: calls.append(c.user_id) or {"entered": 1, "skipped": 0, "failed": 0})

    class Db:
        def query(self, m):
            return self

        def filter(self, *a):
            return self

        def all(self):
            return [cfg(), cfg()]

    assert bot.run_spread_bot(Db(), fake_deps(), OPEN_NOW)["entered"] == 2 and len(calls) == 2


def test_a_stale_oi_read_or_yesterdays_premarket_report_counts_for_nothing():
    stale = {**GOOD_READS, "/options/sentiment-history": {"points": [{"recorded_at": "2026-10-12T04:00:00Z", "direction": "bullish"}]},
             "/premarket": {"day": "2026-10-09", "bias": "bullish"}}
    db, deps = FakeDb(), fake_deps(reads=stale)
    bot.run_bot_for_user(db, cfg(), deps, OPEN_NOW)
    assert db.added[-1].votes == {"trend": 1, "oi": 0, "structure": 1, "premarket": 0} and deps.opened == []  # two of four: not enough
