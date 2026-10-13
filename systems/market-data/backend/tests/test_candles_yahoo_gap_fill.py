from datetime import date

from app.api.routes import candles as mod
from app.domain.models import Candle


def _c(day, o, h, l, c, v, interval="daily", provider="yahoo"):
    return Candle(exchange="NSE", symbol="X", interval=interval, open=o, high=h, low=l, close=c, volume=v,
                  timestamp=f"{day}T00:00:00+05:30", provider=provider)


YAHOO_DAILY = [_c("2026-10-09", 3015, 3165, 3010, 3130, 600), _c("2026-10-13", 3256, 3429, 3245, 3426.7, 1000)]
DHAN_DAILY = [_c("2026-10-09", 3015, 3165, 3010, 3130, 600, provider="dhan"), _c("2026-10-12", 3130, 3270, 3120, 3257, 800, provider="dhan")]
YAHOO_WEEKLY = [_c("2026-10-12", 3256, 3429, 3245, 3426.7, 2000, interval="weekly")]


def _patch(monkeypatch, dhan_error=False):
    def fake(provider, exchange, symbol, interval, f, t, creds=None, source=None):
        if source == "yahoo":
            return YAHOO_DAILY
        if dhan_error:
            raise RuntimeError("no token")
        return DHAN_DAILY
    monkeypatch.setattr(mod, "fetch_candle_history_cached", fake)
    monkeypatch.setattr(mod, "get_provider", lambda e: object())
    monkeypatch.setattr(mod, "data_credentials", lambda caller, e: None)


def test_daily_missing_day_is_filled(monkeypatch):
    _patch(monkeypatch)
    out = mod._fill_yahoo_gaps(YAHOO_DAILY, None, "X", "daily", date(2026, 9, 1), date(2026, 10, 13))
    assert [c.timestamp[:10] for c in out] == ["2026-10-09", "2026-10-12", "2026-10-13"]


def test_weekly_bar_rebuilt_from_filled_days(monkeypatch):
    _patch(monkeypatch)
    out = mod._fill_yahoo_gaps(YAHOO_WEEKLY, None, "X", "weekly", date(2026, 9, 1), date(2026, 10, 13))
    w = out[-1]
    assert (w.open, w.high, w.low, w.close, w.volume) == (3130, 3429, 3120, 3426.7, 1800)


def test_dhan_failure_serves_yahoo_untouched(monkeypatch):
    _patch(monkeypatch, dhan_error=True)
    assert mod._fill_yahoo_gaps(YAHOO_DAILY, None, "X", "daily", date(2026, 9, 1), date(2026, 10, 13)) == YAHOO_DAILY
