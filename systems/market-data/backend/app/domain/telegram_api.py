"""The three Telegram Bot API calls the ideas channel needs, each returning WHY it failed instead of raising: send a message, send a
photo, delete a message. The token is passed in (the ideas bot is a different bot from the alerts one - see app/domain/notify.py).

Plain text only (no parse_mode): a note's words go out exactly as written, with no markup to break or inject."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import requests

logger = logging.getLogger(__name__)
_TIMEOUT = 20


@dataclass
class TgResult:
    ok: bool
    message_id: Optional[int] = None
    error: Optional[str] = None


def _explain(resp: requests.Response) -> str:
    try:
        description = (resp.json().get("description") or "").strip()
    except ValueError:
        description = ""
    hint = {
        400: "Telegram rejected the request" + (f" ({description})" if description else ""),
        401: "the bot token was rejected",
        403: "the bot is not allowed to post there (add it to the channel or group as an admin)",
        404: "Telegram could not find that bot or chat",
        429: "Telegram is rate limiting this bot, try again shortly",
    }
    return hint.get(resp.status_code, f"Telegram returned {resp.status_code}")


def _call(token: str, method: str, **kwargs) -> TgResult:
    try:
        resp = requests.post(f"https://api.telegram.org/bot{token}/{method}", timeout=_TIMEOUT, **kwargs)
    except requests.exceptions.RequestException as exc:
        logger.warning("Telegram %s errored: %s", method, exc)
        return TgResult(False, error="could not reach Telegram")
    if resp.status_code // 100 != 2:
        logger.warning("Telegram %s failed: %s %s", method, resp.status_code, resp.text[:200])
        return TgResult(False, error=_explain(resp))
    try:
        result = resp.json().get("result")
    except ValueError:
        result = None
    message_id = result.get("message_id") if isinstance(result, dict) else None
    return TgResult(True, message_id=message_id)


def send_message(token: str, chat_id: str, text: str) -> TgResult:
    return _call(token, "sendMessage", json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True})


def send_photo(token: str, chat_id: str, png: bytes, caption: str) -> TgResult:
    return _call(token, "sendPhoto", data={"chat_id": chat_id, "caption": caption}, files={"photo": ("idea.png", png, "image/png")})


def delete_message(token: str, chat_id: str, message_id: int) -> TgResult:
    return _call(token, "deleteMessage", json={"chat_id": chat_id, "message_id": message_id})
