from datetime import datetime, timezone

from app.domain import session_grid as sg
from app.domain.discipline_v2 import TradeFacts


def trade(day: int, pnl: float = 100, root_cause=None, tags=None, stop0=100.0, auto=False, hour=5) -> TradeFacts:
    when = datetime(2026, 10, day, hour, 0, tzinfo=timezone.utc)
    return TradeFacts(
        id=f"{day}-{pnl}-{root_cause}-{tags}", kind="position", segment="NSE", symbol="X", action="BUY", entry_time=when, exit_time=when,
        exit_reason=None, order_type=None, entry_price=100, exit_price=101, quantity=1, system_quantity=1, stop0=stop0, target0=None,
        stop_final=stop0, target_final=None, pnl=pnl, entry_setup_tag=None, reviewed=root_cause is not None, auto_traded=auto,
        mistake_tags=tags, root_cause=root_cause,
    )


def test_bands_use_the_thresholds_asked_for():
    assert sg.band(0.81) == "good" and sg.band(0.8) == "mid" and sg.band(0.5) == "mid" and sg.band(0.49) == "poor" and sg.band(None) == "none"


def test_each_level_is_the_share_of_reviewed_trades_without_a_mistake_there():
    facts = [
        trade(3, root_cause="clean", tags=[]),
        trade(3, root_cause="plan", tags=["no_stop", "revenge"]),  # a plan failure and an execution one: each level counts its own
        trade(3, root_cause="study", tags=["impulse"]),
    ]
    day = sg.manual_sessions(facts)[0]
    assert day["date"] == "2026-10-03" and day["trades"] == 3 and day["unreviewed"] == 0
    assert (day["study"]["ok"], day["study"]["of"]) == (2, 3) and day["study"]["band"] == "mid"
    assert (day["plan"]["ok"], day["plan"]["of"]) == (2, 3)
    assert (day["trade"]["ok"], day["trade"]["of"]) == (2, 3)


def test_unreviewed_trades_give_no_verdict_and_are_counted():
    day = sg.manual_sessions([trade(3), trade(3, root_cause="clean", tags=[])])[0]
    assert day["unreviewed"] == 1 and day["study"]["of"] == 1 and day["study"]["band"] == "good"
    none = sg.manual_sessions([trade(2), trade(2)])[0]
    assert none["unreviewed"] == 2 and none["study"] == {"ok": 0, "of": 0, "rate": None, "band": "none"} and none["trade"]["band"] == "none"


def test_sessions_are_newest_first_capped_and_a_day_without_trades_never_appears():
    facts = [trade(d, root_cause="clean", tags=[]) for d in (1, 2, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16)]
    days = [s["date"] for s in sg.manual_sessions(facts)]
    assert days == ["2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12", "2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06", "2026-10-05"]


def test_a_late_evening_trade_belongs_to_the_indian_trading_day():
    late = trade(3, root_cause="clean", tags=[], hour=19)  # 19:00 UTC is 00:30 IST on the 4th
    assert sg.manual_sessions([late])[0]["date"] == "2026-10-04"


def test_the_bot_grid_judges_result_wins_and_a_clean_run():
    from datetime import date
    facts = [trade(3, pnl=300, auto=True), trade(3, pnl=-100, auto=True, stop0=None), trade(4, pnl=-50, auto=True)]
    out = {s["date"]: s for s in sg.bot_sessions(facts, {date(2026, 10, 4): 2})}
    d3 = out["2026-10-03"]
    assert d3["pnl"] == 200 and d3["result"] == "good" and d3["wins"] == 1 and d3["wins_band"] == "mid" and d3["clean"] == "mid" and d3["no_stop"] == 1
    d4 = out["2026-10-04"]
    assert d4["result"] == "poor" and d4["wins_band"] == "poor" and d4["clean"] == "poor" and d4["failed"] == 2


def test_an_override_that_paid_off_does_not_count_against_study_but_other_study_mistakes_still_do():
    paid = trade(3, root_cause="study", tags=["against_trend"])
    paid_but_impulsive = trade(3, pnl=250, root_cause="study", tags=["against_trend", "impulse"])
    lost = trade(3, pnl=-100, root_cause="study", tags=["against_trend"])
    verdicts = {paid.id: "paid_off", paid_but_impulsive.id: "paid_off", lost.id: "lost"}
    day = sg.manual_sessions([paid, paid_but_impulsive, lost], verdicts=verdicts)[0]
    assert (day["study"]["ok"], day["study"]["of"]) == (1, 3)  # only the first is cleared
    assert day["overrides"] == 3 and day["paid_off"] == 2
    assert sg.manual_sessions([paid], verdicts={})[0]["study"]["ok"] == 0  # without the override it counts


def test_sessions_without_overrides_report_zero():
    day = sg.manual_sessions([trade(3, root_cause="clean", tags=[])])[0]
    assert day["overrides"] == 0 and day["paid_off"] == 0
