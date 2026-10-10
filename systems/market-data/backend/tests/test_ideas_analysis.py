"""An AI analysis attached to a published idea: what the post shows, what it can never show, and that the server writes the words."""

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.routes import ideas as route
from app.domain import ideas
from tests.test_ideas import ADMIN, FakeDB, FakeTelegram, make_idea, payload


def analysis(**over):
    base = dict(
        verdict="Price is rising, but the business case is weak", agreement="conflicting", overall="bullish", overall_strength="strong",
        chart_bias="bullish", chart_points=["Weekly: price is above its 50-week average", "Trend strength is strong (ADX 31, rising)", "Volume is above its 20-bar average", "A fourth point"],
        price=366.1, as_of="2026-10-12", business_bias="neutral", business_confidence=0.65,
        business_summary="Strong growth, but a very high price to book and no dividend.",
        pros=["Profit growth 31% a year", "Working capital days down", "Third"], cons=["Trades at 109 times book value", "No dividend", "Third"],
        support=ideas.AnalysisLevel(low=340, high=348, distance_pct=5.2), resistance=ideas.AnalysisLevel(low=380, high=392, distance_pct=3.8),
    )
    base.update(over)
    return ideas.Analysis(**base)


def analysis_in(**over):
    base = dict(
        verdict="Price is rising, but the business case is weak", agreement="conflicting", overall="bullish", overall_strength="strong", chart_bias="bullish",
        chart_points=["Weekly: price is above its 50-week average"], price=366.1, as_of="2026-10-12", business_bias="neutral", business_confidence=0.65,
        business_summary="Strong growth.", pros=["Profit growth"], cons=["Costly"],
        support={"low": 340, "high": 348, "distance_pct": 5.2}, resistance={"low": 380, "high": 392, "distance_pct": 3.8},
    )
    base.update(over)
    return route.AnalysisIn(**base)


# ---- what the section says -------------------------------------------------------------------------------------------------------------


def test_the_block_reads_verdict_chart_business_strengths_concerns_and_nearby_levels():
    lines = ideas.analysis_block(analysis()).split("\n")
    assert lines[0] == "🔎 AI analysis · price 366.10 (2026-10-12)"
    assert lines[1] == "Verdict: Price is rising, but the business case is weak. Chart and business disagree · overall ▲ bullish (strong)."
    assert lines[2] == "Chart ▲ bullish: Weekly: price is above its 50-week average · Trend strength is strong (ADX 31, rising) · Volume is above its 20-bar average"
    assert lines[3] == "Business ◆ neutral (65% sure): Strong growth, but a very high price to book and no dividend."
    assert lines[4] == "✓ Profit growth 31% a year · Working capital days down"
    assert lines[5] == "✕ Trades at 109 times book value · No dividend"
    assert lines[6] == "Nearby: resistance 380.00–392.00 (+3.8%) · support 340.00–348.00 (−5.2%)"
    assert lines[7] == ideas.ANALYSIS_NOTICE


def test_only_the_first_three_chart_points_and_two_strengths_and_concerns_are_shown():
    block = ideas.analysis_block(analysis())
    assert "A fourth point" not in block and "Third" not in block


def test_a_chart_only_analysis_has_no_business_lines():
    block = ideas.analysis_block(analysis(agreement="technical_only", business_bias=None, business_confidence=None, business_summary=None, pros=None, cons=None))
    assert "Business" not in block and "✓" not in block and "✕" not in block
    assert "Chart only" in block and block.endswith(ideas.ANALYSIS_NOTICE)


def test_missing_levels_and_price_are_simply_left_out():
    block = ideas.analysis_block(analysis(price=None, as_of=None, support=None, resistance=None))
    assert block.split("\n")[0] == "🔎 AI analysis" and "Nearby" not in block


def test_one_level_only_is_shown_without_a_separator():
    assert ideas.analysis_block(analysis(support=None)).split("\n")[-2] == "Nearby: resistance 380.00–392.00 (+3.8%)"


def test_long_or_messy_text_is_trimmed_to_one_short_line():
    messy = "line one\n\nline   two\t" + "x" * 500
    block = ideas.analysis_block(analysis(business_summary=messy, verdict=messy, pros=[messy], chart_points=[messy]))
    assert "\n\n" not in block
    for line in block.split("\n"):
        assert len(line) < 420
    assert "line one line two" in block and "…" in block


def test_the_notice_that_it_is_machine_made_is_always_there_and_the_disclaimer_still_comes_last():
    text = ideas.build_text(make_idea(analysis=analysis()))
    assert ideas.ANALYSIS_NOTICE in text and text.endswith(ideas.disclaimer())
    assert text.index("AI analysis") > text.index("Watching 23,100")  # after the note
    assert text.index("AI analysis") < text.index(ideas.disclaimer())


def test_the_analysis_sits_between_the_note_and_an_attached_trade():
    trade = ideas.Trade(kind="position", label="NIFTY", side="BUY", live=False, entry=100.0, stop=95.0, target=110.0, exit=108.0, exit_reason="target")
    text = ideas.build_text(make_idea(analysis=analysis(), trade=trade))
    assert text.index("Watching") < text.index("AI analysis") < text.index("Paper trade")


def test_a_post_without_an_analysis_is_exactly_what_it_was():
    assert "AI analysis" not in ideas.build_text(make_idea())


def test_with_a_chart_the_longer_post_goes_as_a_photo_with_a_header_then_the_full_text():
    plan = ideas.plan_post(make_idea(analysis=analysis(), image=b"\x89PNG" + b"0" * 10))
    assert [kind for kind, _ in plan.messages] == ["photo", "text"]
    assert plan.messages[0][1] == ideas.header(make_idea()) and "AI analysis" in plan.messages[1][1]


def test_an_analysis_with_no_verdict_is_refused():
    with pytest.raises(ideas.IdeaError) as e:
        ideas.check_publishable(make_idea(analysis=analysis(verdict="   ")))
    assert e.value.status == 422


# ---- what the request can carry --------------------------------------------------------------------------------------------------------


def test_the_request_accepts_only_the_fields_of_an_analysis():
    assert analysis_in().verdict.startswith("Price is rising")
    with pytest.raises(ValidationError):
        analysis_in(quantity=10)  # anything else is refused, not quietly dropped
    with pytest.raises(ValidationError):
        analysis_in(support={"low": 1, "high": 2, "distance_pct": 1, "note": "x"})


def test_the_request_limits_the_values():
    for bad in (dict(overall="maybe"), dict(agreement="whatever"), dict(business_confidence=1.5), dict(price=-1), dict(verdict=""), dict(verdict="x" * 301),
                dict(chart_points=["a"] * 9), dict(overall_strength="huge"), dict(support={"low": 0, "high": 2, "distance_pct": 1})):
        with pytest.raises(ValidationError):
            analysis_in(**bad)


def test_the_route_turns_the_request_into_the_idea_with_its_levels():
    idea = route._idea(payload(analysis=analysis_in()))
    assert idea.analysis.verdict.startswith("Price is rising") and idea.analysis.support.high == 348 and idea.analysis.resistance.distance_pct == 3.8
    assert route._idea(payload()).analysis is None


def test_preview_shows_the_analysis_and_publish_posts_the_same_text(monkeypatch):
    tg = FakeTelegram(monkeypatch)
    db = FakeDB()
    body = payload(analysis=analysis_in())
    preview = route.preview(body, db, ADMIN)
    assert "🔎 AI analysis" in preview.text and preview.text.endswith(ideas.disclaimer())
    route.publish(body, db, ADMIN)
    assert tg.sent[0][1] == preview.text  # what was previewed is what was sent
