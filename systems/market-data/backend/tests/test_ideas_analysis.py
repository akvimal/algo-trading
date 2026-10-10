"""An AI analysis attached to a published idea: what the post shows, what it can never show, and that the server writes the words."""

import pytest
from pydantic import ValidationError

from app.api.routes import ideas as route
from app.domain import ideas
from tests.test_ideas import ADMIN, FakeDB, FakeTelegram, make_idea, payload

PNG = b"\x89PNG" + b"0" * 8


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


def test_written_out_without_a_picture_it_reads_the_leans_the_verdict_the_reasons_and_the_nearby_levels():
    lines = ideas.analysis_block(analysis()).split("\n")
    assert lines[0] == "🔎 AI analysis · 366.10 (2026-10-12)"
    assert lines[1] == "🟢 Chart bullish  ·  🟡 Business neutral (65% sure)"
    assert lines[2] == "⚠️ Price is rising, but the business case is weak"
    assert lines[3] == "Overall ▲ bullish (strong) · chart and business disagree."
    assert lines[4] == "Chart: Weekly: price is above its 50-week average · Trend strength is strong (ADX 31, rising) · Volume is above its 20-bar average"
    assert lines[5] == "Business: Strong growth, but a very high price to book and no dividend."
    assert lines[6] == "✓ Profit growth 31% a year · Working capital days down"
    assert lines[7] == "✕ Trades at 109 times book value · No dividend"
    assert lines[8] == "📍 Resistance 380.00–392.00 (+3.8%) · Support 340.00–348.00 (−5.2%)"
    assert lines[9] == ideas.ANALYSIS_NOTICE


def test_with_a_picture_it_is_a_few_lines_because_the_card_carries_the_rest():
    lines = ideas.analysis_block(analysis(), compact=True).split("\n")
    assert lines == [
        "🔎 AI analysis · 366.10 (2026-10-12)",
        "🟢 Chart bullish  ·  🟡 Business neutral (65% sure)",
        "⚠️ Price is rising, but the business case is weak",
        "📍 Resistance 380.00–392.00 (+3.8%) · Support 340.00–348.00 (−5.2%)",
        ideas.ANALYSIS_NOTICE,
    ]


def test_each_lean_has_its_own_colour_and_each_agreement_its_own_mark():
    for bias, dot in (("bullish", "🟢"), ("bearish", "🔴"), ("neutral", "🟡")):
        assert f"{dot} Chart {bias}" in ideas.analysis_block(analysis(chart_bias=bias), compact=True)
    for agreement, mark in (("aligned", "✅"), ("conflicting", "⚠️"), ("mixed", "➖"), ("technical_only", "📈")):
        assert f"\n{mark} " in ideas.analysis_block(analysis(agreement=agreement), compact=True)


def test_a_post_with_a_picture_uses_the_short_form_and_one_without_uses_the_written_out_form():
    with_picture = ideas.build_text(make_idea(analysis=analysis(), image=PNG))
    without = ideas.build_text(make_idea(analysis=analysis()))
    assert "Working capital days down" not in with_picture and "Working capital days down" in without
    assert len(with_picture) < len(without) - 300


def test_a_summary_stops_at_the_end_of_a_sentence_not_mid_thought():
    summary = (
        "RR Kabel Ltd shows strong historical profit growth and a consistent dividend payout, coupled with a growing distribution network. "
        "While the stock is trading at a premium to its book value, the overall outlook for the next year stays positive."
    )
    block = ideas.analysis_block(analysis(business_summary=summary))
    line = next(x for x in block.split("\n") if x.startswith("Business:"))
    assert line.endswith("growing distribution network.") and "…" not in line


def test_when_no_sentence_ends_in_time_it_cuts_at_a_word_with_an_ellipsis():
    out = ideas._clip_sentence("word " * 100, 40)
    assert out.endswith("…") and len(out) <= 41 and out.rstrip("…").endswith("word")
    assert ideas._clip_sentence("short", 40) == "short"


def test_only_the_first_three_chart_points_and_two_strengths_and_concerns_are_shown():
    block = ideas.analysis_block(analysis())
    assert "A fourth point" not in block and "Third" not in block


def test_a_chart_only_analysis_has_no_business_lines():
    block = ideas.analysis_block(analysis(agreement="technical_only", business_bias=None, business_confidence=None, business_summary=None, pros=None, cons=None))
    assert "Business" not in block and "✓" not in block and "✕" not in block
    assert "📈 " in block and block.endswith(ideas.ANALYSIS_NOTICE)


def test_missing_levels_and_price_are_simply_left_out():
    block = ideas.analysis_block(analysis(price=None, as_of=None, support=None, resistance=None))
    assert block.split("\n")[0] == "🔎 AI analysis" and "📍" not in block


def test_one_level_only_is_shown_without_a_separator():
    assert ideas.analysis_block(analysis(support=None)).split("\n")[-2] == "📍 Resistance 380.00–392.00 (+3.8%)"


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


def test_with_a_chart_a_typical_post_with_the_analysis_is_one_photo_with_everything_as_its_caption():
    plan = ideas.plan_post(make_idea(analysis=analysis(), image=PNG))
    assert [kind for kind, _ in plan.messages] == ["photo"]
    assert len(plan.text) <= ideas.CAPTION_MAX and "AI analysis" in plan.text and plan.text.endswith(ideas.disclaimer())


def test_a_very_long_note_still_falls_back_to_a_photo_with_a_header_then_the_text():
    plan = ideas.plan_post(make_idea(text="n" * 480, analysis=analysis(), image=PNG))
    assert [kind for kind, _ in plan.messages] == ["photo", "text"] and plan.messages[0][1] == ideas.header(make_idea())


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
