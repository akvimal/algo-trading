import json

import pytest

from app.domain import ai_language as lang


def test_english_and_accented_latin_text_passes():
    assert lang.is_english({"one_liner": "Crypto likely stays weak after the US sell-off.", "reasons": ["Nasdaq futures fell 2.5%.", "Café, naïve, Zoë"]})
    assert lang.is_english({"x": 5, "y": None, "z": []})  # nothing to judge is fine


def test_a_reply_in_another_script_is_refused():
    chinese = {"one_liner": "加密货币在美股大幅下跌、VIX飙升和情绪恶化的压力下，下一交易日可能跟随走弱。", "reasons": ["纳斯达克期货下跌2.496%"]}
    assert not lang.is_english(chinese)
    assert not lang.is_english({"watch": "Следите за открытием рынка и фьючерсами на Nasdaq"})
    assert not lang.is_english({"a": ["fine", {"b": "हिंदी में लिखा गया उत्तर यहाँ है"}]})


def test_a_few_foreign_characters_in_an_english_reply_are_tolerated():
    assert lang.is_english({"one_liner": "The yen (円) strengthened while Nifty slipped modestly in early trade today."})


def test_the_wrapped_parser_raises_value_error_so_the_caller_retries():
    parse = lang.english_only(json.loads)
    assert parse('{"one_liner": "Stay cautious."}') == {"one_liner": "Stay cautious."}
    with pytest.raises(ValueError):
        parse(json.dumps({"one_liner": "下一交易日可能跟随走弱，注意风险。"}, ensure_ascii=False))


def test_every_prompt_carries_the_english_rule():
    from app.domain import ai_read, premarket_report, rbi_reader, segment_brief

    assert lang.ENGLISH_RULE in premarket_report._SYSTEM_PROMPT
    assert lang.ENGLISH_RULE in rbi_reader._SYSTEM_PROMPT
    assert lang.ENGLISH_RULE in ai_read.system_prompt("NSE")
    assert all(lang.ENGLISH_RULE in p for p in segment_brief._PROMPTS.values())


def test_an_earlier_read_in_another_language_is_not_reused():
    from app.domain import premarket_report

    prior = {"ai": {"one_liner": "下一交易日可能跟随走弱，注意风险管理。"}, "model": "m", "inputs": [], "rules": {}, "macro": None}
    assert premarket_report._same_data(prior, {}) is False
