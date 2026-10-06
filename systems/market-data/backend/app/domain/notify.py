"""Outbound notifications - just Telegram for now (the price-alert scheduler). One platform bot (settings.telegram_bot_token); the
chat a message goes to is chosen by the caller: a user's own chat id for their alerts (market_data.alert_channels), or the
platform chat (settings.telegram_chat_id) for the operator's own / legacy alerts.

`send_telegram` says WHY a send failed, so the alert scheduler can keep a one-shot alert armed instead of using it up on a
message nobody received. `notify_telegram` is the old boolean form. Neither ever raises (a caller in a scheduler job must
keep going); an unconfigured bot logs one warning, so a dev without one is not spammed with errors."""

import logging
from typing import Optional

import requests

from app.config import settings

logger = logging.getLogger(__name__)
_warned_unconfigured = False


def bot_configured() -> bool:
    return bool(settings.telegram_bot_token)


def telegram_configured() -> bool:
    """The platform bot AND the platform chat (the operator's own destination)."""
    return bool(settings.telegram_bot_token and settings.telegram_chat_id)


def send_telegram(text: str, chat_id: Optional[str] = None) -> Optional[str]:
    """Send `text` to `chat_id` (default: the platform chat). Returns None when delivered, else a short reason."""
    global _warned_unconfigured
    chat = chat_id or settings.telegram_chat_id
    if not settings.telegram_bot_token:
        if not _warned_unconfigured:
            logger.warning("Telegram bot not configured (telegram_bot_token) - notifications are off")
            _warned_unconfigured = True
        return "Telegram is not set up on this server"
    if not chat:
        return "no Telegram chat to send to"
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage",
            json={"chat_id": chat, "text": text, "disable_web_page_preview": True},
            timeout=10,
        )
        if resp.status_code // 100 == 2:
            return None
        logger.warning("Telegram sendMessage failed: %s %s", resp.status_code, resp.text[:200])
        hint = {400: "Telegram rejected the chat id", 403: "the bot cannot message this chat (start the bot first)"}.get(resp.status_code, f"Telegram returned {resp.status_code}")
        return hint
    except requests.exceptions.RequestException as exc:
        logger.warning("Telegram sendMessage errored: %s", exc)
        return "could not reach Telegram"


def send_telegram_photo(png: bytes, caption: str, chat_id: Optional[str] = None) -> Optional[str]:
    """Send a picture (PNG bytes) with a caption of at most 1024 characters. Returns None when delivered, else a short reason."""
    chat = chat_id or settings.telegram_chat_id
    if not settings.telegram_bot_token:
        return "Telegram is not set up on this server"
    if not chat:
        return "no Telegram chat to send to"
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendPhoto",
            data={"chat_id": chat, "caption": caption[:1024]},
            files={"photo": ("summary.png", png, "image/png")},
            timeout=30,
        )
        if resp.status_code // 100 == 2:
            return None
        logger.warning("Telegram sendPhoto failed: %s %s", resp.status_code, resp.text[:200])
        return {400: "Telegram rejected the picture", 403: "the bot cannot message this chat (start the bot first)"}.get(resp.status_code, f"Telegram returned {resp.status_code}")
    except requests.exceptions.RequestException as exc:
        logger.warning("Telegram sendPhoto errored: %s", exc)
        return "could not reach Telegram"


def notify_telegram(text: str) -> bool:
    """Send to the platform chat. True on delivery, False on any failure or if unconfigured."""
    return send_telegram(text) is None
