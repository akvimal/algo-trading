import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.routes import ideas as route
from app.config import settings
from app.domain import ideas
from tests.test_ideas import ADMIN, FakeDB, make_idea, payload


def trade(**over):
    base = dict(kind="position", label="NIFTY", side="BUY", live=False, entry=23140.5, stop=23090.0, target=23240.0, exit=23235.0, exit_reason="target", result_pct=None)
    base.update(over)
    return ideas.Trade(**base)


def trade_in(**over):
    base = dict(kind="position", label="NIFTY", side="BUY", live=False, entry=23140.5, stop=23090.0, target=23240.0, exit=23235.0, exit_reason="target")
    base.update(over)
    return route.TradeIn(**base)


# ---- the numbers ----------------------------------------------------------------------------------------------------------------


def test_a_winning_buy_shows_its_levels_the_planned_ratio_and_the_result_in_r():
    block = ideas.trade_block(trade())
    assert block == "Paper trade: BUY NIFTY · entry 23,140.50 · stop 23,090.00 · target 23,240.00 · R:R 2.0 · exit 23,235.00 (hit the target) · +1.9R (before charges)"


def test_a_sell_that_was_stopped_out_is_a_loss_of_one_r_the_other_way_round():
    sell = trade(side="SELL", entry=100.0, stop=105.0, target=90.0, exit=105.0, exit_reason="stop_loss")
    assert ideas.trade_result(sell) == "−1.0R"
    assert "exit 105.00 (stopped out)" in ideas.trade_block(sell) and "R:R 2.0" in ideas.trade_block(sell)
    assert ideas.trade_result(trade(side="SELL", entry=100.0, stop=105.0, exit=95.0)) == "+1.0R"


def test_without_a_stop_the_result_is_a_percentage_move_not_r():
    t = trade(stop=None, target=None, entry=200.0, exit=210.0, exit_reason=None)
    assert ideas.trade_result(t) == "+5.0%"
    block = ideas.trade_block(t)
    assert "R:R" not in block and "stop" not in block and "exit 210.00" in block and "(" not in block.split("exit 210.00")[1].split(" ·")[0]  # no reason, no brackets


def test_a_result_that_rounds_to_zero_carries_no_sign():
    assert ideas.trade_result(trade(entry=100.0, stop=95.0, exit=100.001)) == "0.0R"


def test_a_stop_on_the_entry_price_cannot_divide_by_zero():
    assert ideas.trade_result(trade(entry=100.0, stop=100.0, exit=102.0)) == "+2.0%"
    assert ideas.planned_risk_reward(trade(entry=100.0, stop=100.0, target=110.0)) is None


def test_an_option_spread_shows_underlying_levels_and_its_result_as_a_percentage_of_the_premium():
    g = trade(kind="group", label="NIFTY bull call spread", entry=23100.0, stop=22950.0, target=23350.0, exit=None, exit_reason="target", result_pct=62.4)
    assert ideas.trade_block(g) == "Paper trade: BUY NIFTY bull call spread · Underlying entry 23,100.00 · Underlying stop 22,950.00 · Underlying target 23,350.00 · R:R 1.7 · closed: hit the target · +62% of the premium paid (after charges)"
    assert ideas.trade_result(trade(kind="group", exit=None, result_pct=-100.0)) == "−100% of the premium paid"


def test_a_positions_result_is_before_charges_and_a_spreads_is_after_because_that_is_how_the_app_records_them():
    assert ideas.trade_block(trade()).endswith("+1.9R (before charges)")
    assert ideas.trade_block(trade(kind="group", exit=None, result_pct=10.0)).endswith("of the premium paid (after charges)")


def test_every_trade_is_labelled_paper_or_live():
    assert ideas.trade_block(trade(live=False)).startswith("Paper trade: ")
    assert ideas.trade_block(trade(live=True)).startswith("Live trade: ")


def test_an_exit_reason_the_app_does_not_know_is_left_out_not_shown_raw():
    assert "exit 23,235.00 · +1.9R" in ideas.trade_block(trade(exit_reason="some_new_reason"))  # no reason in brackets after the exit
    assert "(squared off at the end of the day)" in ideas.trade_block(trade(exit_reason="square_off"))


# ---- only closed trades --------------------------------------------------------------------------------------------------------


def test_a_position_with_no_exit_is_refused_as_not_closed():
    with pytest.raises(ideas.IdeaError) as e:
        ideas.check_publishable(make_idea(trade=trade(exit=None)))
    assert e.value.status == 422 and "closed trade" in e.value.detail


def test_a_spread_with_no_result_is_refused_as_not_closed():
    with pytest.raises(ideas.IdeaError) as e:
        ideas.check_publishable(make_idea(trade=trade(kind="group", exit=None, result_pct=None)))
    assert e.value.status == 422


def test_a_closed_trade_passes():
    ideas.check_publishable(make_idea(trade=trade()))
    ideas.check_publishable(make_idea(trade=trade(kind="group", exit=None, result_pct=12.0)))


# ---- nothing private can ride along ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("field, value", [("quantity", 75), ("lots", 3), ("pnl", 4200.5), ("charges", 38.2), ("capital", 500000), ("balance", 1), ("strategy_id", "abc"), ("review_notes", "x")])
def test_a_request_carrying_a_private_trade_field_is_refused_not_dropped(field, value):
    with pytest.raises(ValidationError):
        route.TradeIn(**{**trade_in().model_dump(), field: value})


@pytest.mark.parametrize("bad", [dict(entry=0), dict(entry=-5), dict(stop=float("nan")), dict(exit=float("inf")), dict(label=""), dict(label="x" * 81), dict(side="HOLD"), dict(kind="basket"), dict(result_pct=-101), dict(exit_reason="x" * 31)])
def test_a_malformed_trade_is_refused(bad):
    with pytest.raises(ValidationError):
        trade_in(**bad)


def test_the_post_has_no_room_for_a_quantity_or_a_rupee_amount():
    fields = set(ideas.Trade.__dataclass_fields__)
    assert not fields & {"quantity", "lots", "pnl", "charges", "capital", "balance", "net_debit"}


# ---- in the post ---------------------------------------------------------------------------------------------------------------------


def test_the_trade_comes_after_the_note_before_the_market_line_and_the_disclaimer_is_still_last():
    text = ideas.build_text(make_idea(trade=trade(), context={"price": 23100}))
    note, block, market = text.index("Watching 23,100"), text.index("Paper trade:"), text.index("Price 23,100.00")
    assert note < block < market < text.index(ideas.DEFAULT_DISCLAIMER) and text.endswith(ideas.DEFAULT_DISCLAIMER)


def test_a_post_without_a_trade_is_unchanged():
    assert "trade:" not in ideas.build_text(make_idea())


def test_the_preview_shows_the_trade_and_publish_uses_the_same_text(monkeypatch):
    monkeypatch.setattr(settings, "telegram_ideas_bot_token", "TOKEN")
    shown = route.preview(payload(trade=trade_in()), FakeDB(), ADMIN).text
    assert "Paper trade: BUY NIFTY" in shown and shown.endswith(ideas.DEFAULT_DISCLAIMER)


def test_the_routes_refuse_an_open_trade(monkeypatch):
    monkeypatch.setattr(settings, "telegram_ideas_bot_token", "TOKEN")
    with pytest.raises(HTTPException) as e:
        route.preview(payload(trade=trade_in(exit=None)), FakeDB(), ADMIN)
    assert e.value.status_code == 422 and "closed trade" in e.value.detail
    with pytest.raises(HTTPException):
        route.publish(payload(trade=trade_in(exit=None)), FakeDB(), ADMIN)
