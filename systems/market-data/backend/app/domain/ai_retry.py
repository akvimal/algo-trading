"""One OpenRouter chat call that returns parsed JSON, with a single retry when the reply was cut off.

Every AI task here caps the reply (`max_tokens`), because without a cap OpenRouter reserves the model's full output
allowance and a small credit balance is refused with a 402 (see news.py). A *reasoning* model spends part of that cap on
thinking before it writes the answer, so a cap sized for a short JSON reply can be used up mid-answer and the JSON comes
back cut off ("Unterminated string"). Confirmed live 2026-10-06: gpt-5-mini failed the pre-market task this way at
1,200 tokens. The model picker offers reasoning models, so the call must cope with them: when the reply is cut off
(finish_reason "length", or text that does not parse), ask again once with a larger cap, up to a ceiling.
"""

from __future__ import annotations

import logging
from typing import Callable

logger = logging.getLogger(__name__)

HEADROOM_FACTOR = 4
CEILING_TOKENS = 8000


def post_json(post: Callable, url: str, headers: dict, body: dict, timeout: float, parse: Callable[[str], dict]) -> dict:
    """`post` is requests.post (passed in so callers and tests keep patching it where they always did). `body` carries the
    base `max_tokens`. HTTP errors propagate for the caller to turn into a message; a reply that is still unusable after
    the retry raises whatever `parse` raised."""
    base = int(body.get("max_tokens") or 1000)
    attempt_body = body
    for attempt in (1, 2):
        resp = post(url, headers=headers, json=attempt_body, timeout=timeout)
        resp.raise_for_status()
        choice = resp.json()["choices"][0]
        content = choice["message"]["content"]
        cut_off = choice.get("finish_reason") == "length"
        try:
            if not cut_off:
                return parse(content)
        except ValueError:  # JSONDecodeError is one; so is a model reply with no JSON at all
            pass
        if attempt == 2 or base >= CEILING_TOKENS:
            return parse(content)  # raises the real parse error for the caller
        bigger = min(base * HEADROOM_FACTOR, CEILING_TOKENS)
        logger.info("openrouter: reply cut off at %s tokens (model %s); retrying with %s", base, body.get("model"), bigger)
        attempt_body = {**body, "max_tokens": bigger}
    raise AssertionError("unreachable")
