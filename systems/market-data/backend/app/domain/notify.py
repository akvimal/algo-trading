"""Outbound notifications - just Telegram for now (the price-alert
scheduler). A single configured bot + chat: settings.telegram_bot_token /
telegram_chat_id. No-op (logs a warning once) when unconfigured, so a dev
without a bot set up isn't spammed with errors."""

import logging

import requests

from app.config import settings

logger = logging.getLogger(__name__)
_warned_unconfigured = False


def telegram_configured() -> bool:
    return bool(settings.telegram_bot_token and settings.telegram_chat_id)


def notify_telegram(text: str) -> bool:
    """Send `text` to the configured Telegram chat. Returns True on a 2xx,
    False on any failure or if unconfigured - never raises (a caller in a
    scheduler job must keep going)."""
    global _warned_unconfigured
    if not telegram_configured():
        if not _warned_unconfigured:
            logger.warning("Telegram not configured (telegram_bot_token / telegram_chat_id) - notifications are off")
            _warned_unconfigured = True
        return False
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage",
            json={"chat_id": settings.telegram_chat_id, "text": text, "disable_web_page_preview": True},
            timeout=10,
        )
        if resp.status_code // 100 == 2:
            return True
        logger.warning("Telegram sendMessage failed: %s %s", resp.status_code, resp.text[:200])
        return False
    except requests.exceptions.RequestException as exc:
        logger.warning("Telegram sendMessage errored: %s", exc)
        return False
