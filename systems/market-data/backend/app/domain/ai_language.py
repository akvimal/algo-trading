"""Keep the model's words in English.

Some models on OpenRouter answer in the language of their training data (a Chinese brief for an Indian trader, confirmed live
2026-10-17 with deepseek). Two guards: every prompt ends with ENGLISH_RULE, and a reply that still comes back mostly in another
script is refused (`english_only` wraps a prompt's JSON parser), so ai_retry.post_json asks once more and, failing that, the
rule-based read stands with 'AI read temporarily unavailable' instead of text the reader cannot use. An earlier read stored in a
foreign language is never reused (`is_english`)."""

from __future__ import annotations

from typing import Any, Callable

ENGLISH_RULE = (
    "Write every word of your reply in English (Latin script), whatever language the inputs, headlines or your own training favour; "
    "keep proper names as given."
)
# Accented Latin (up to U+024F) is fine; Han, Hangul, kana, Cyrillic, Arabic, Devanagari and the rest are not.
_LATIN_MAX = 0x024F
FOREIGN_SHARE = 0.10


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _strings(v)


def is_english(value: Any) -> bool:
    """Whether the text in a parsed reply (any nesting of dicts, lists and strings) is overwhelmingly Latin script."""
    letters = foreign = 0
    for text in _strings(value):
        for ch in text:
            if ch.isalpha():
                letters += 1
                if ord(ch) > _LATIN_MAX:
                    foreign += 1
    return letters == 0 or foreign / letters <= FOREIGN_SHARE


def english_only(parse: Callable[[str], dict]) -> Callable[[str], dict]:
    """A parser that raises ValueError (which post_json treats as 'try once more') when the reply is not in English."""

    def wrapped(content: str) -> dict:
        parsed = parse(content)
        if not is_english(parsed):
            raise ValueError("model replied in a language other than English")
        return parsed

    return wrapped
