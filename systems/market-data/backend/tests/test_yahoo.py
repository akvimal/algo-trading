from datetime import date

import pandas as pd
import pytest

from app.providers import yahoo


class _FakeTicker:
    def __init__(self, df: pd.DataFrame):
        self._df = df

    def history(self, start, end, interval):
        return self._df


def _fake_df(rows: list[tuple[str, float, float, float, float, float]]) -> pd.DataFrame:
    index = pd.to_datetime([r[0] for r in rows])
    return pd.DataFrame(
        {
            "Open": [r[1] for r in rows],
            "High": [r[2] for r in rows],
            "Low": [r[3] for r in rows],
            "Close": [r[4] for r in rows],
            "Volume": [r[5] for r in rows],
        },
        index=index,
    )


def test_get_candle_history_maps_nse_symbol_and_interval(monkeypatch):
    captured = {}

    def fake_ticker(symbol):
        captured["symbol"] = symbol
        return _FakeTicker(_fake_df([("2026-09-10", 100.0, 105.0, 95.0, 102.0, 1000.0)]))

    monkeypatch.setattr(yahoo.yf, "Ticker", fake_ticker)

    candles = yahoo.get_candle_history("NSE", "ABB", "daily", date(2026, 9, 1), date(2026, 9, 12))

    assert captured["symbol"] == "ABB.NS"  # Yahoo's NSE suffix convention
    assert len(candles) == 1
    c = candles[0]
    assert c.exchange == "NSE"
    assert c.symbol == "ABB"
    assert c.interval == "daily"
    assert c.open == 100.0
    assert c.close == 102.0
    assert c.provider == "yahoo"


def test_get_candle_history_rejects_non_nse_exchange():
    with pytest.raises(ValueError):
        yahoo.get_candle_history("MCX", "GOLDM", "daily", date(2026, 9, 1), date(2026, 9, 12))


def test_get_candle_history_rejects_unsupported_interval():
    with pytest.raises(ValueError):
        yahoo.get_candle_history("NSE", "ABB", "5min", date(2026, 9, 1), date(2026, 9, 12))


def test_get_candle_history_raises_on_empty_result(monkeypatch):
    monkeypatch.setattr(yahoo.yf, "Ticker", lambda symbol: _FakeTicker(pd.DataFrame()))
    monkeypatch.setattr(yahoo.time, "sleep", lambda seconds: None)  # skip the real retry delay

    with pytest.raises(ValueError):
        yahoo.get_candle_history("NSE", "TOTALLYFAKESYMBOL", "daily", date(2026, 9, 1), date(2026, 9, 12))


# --- _fetch_history_with_retry: yfinance/curl_cffi occasionally fails under load, confirmed live 2026-09-22 ---


def test_fetch_history_with_retry_succeeds_on_first_try(monkeypatch):
    calls = []
    df = _fake_df([("2026-09-10", 100.0, 105.0, 95.0, 102.0, 1000.0)])
    monkeypatch.setattr(yahoo.yf, "Ticker", lambda symbol: calls.append(1) or _FakeTicker(df))
    monkeypatch.setattr(yahoo.time, "sleep", lambda seconds: (_ for _ in ()).throw(AssertionError("should not sleep on a first-try success")))

    result = yahoo._fetch_history_with_retry("ABB.NS", date(2026, 9, 1), date(2026, 9, 12), "1d")

    assert len(calls) == 1
    assert not result.empty


def test_fetch_history_with_retry_recovers_from_an_empty_result_then_succeeds(monkeypatch):
    # yfinance swallows a connection failure internally and returns an
    # empty DataFrame rather than raising - confirmed live 2026-09-22 (the
    # "possibly delisted" log line was misleading; INFY/DMART/HCLTECH all
    # succeeded on a bare retry minutes later). This must retry on an
    # empty result, not just a raised exception.
    good_df = _fake_df([("2026-09-10", 100.0, 105.0, 95.0, 102.0, 1000.0)])
    responses = [pd.DataFrame(), good_df]
    sleeps = []
    monkeypatch.setattr(yahoo.yf, "Ticker", lambda symbol: _FakeTicker(responses.pop(0)))
    monkeypatch.setattr(yahoo.time, "sleep", lambda seconds: sleeps.append(seconds))

    result = yahoo._fetch_history_with_retry("INFY.NS", date(2026, 9, 1), date(2026, 9, 12), "1d")

    assert not result.empty
    assert sleeps == [yahoo._HISTORY_RETRY_SLEEP_SECONDS]


def test_fetch_history_with_retry_recovers_from_a_raised_exception(monkeypatch):
    good_df = _fake_df([("2026-09-10", 100.0, 105.0, 95.0, 102.0, 1000.0)])
    attempts = {"n": 0}

    class FlakyTicker:
        def history(self, start, end, interval):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise ConnectionError("Failed to resolve host: query2.finance.yahoo.com")
            return good_df

    monkeypatch.setattr(yahoo.yf, "Ticker", lambda symbol: FlakyTicker())
    monkeypatch.setattr(yahoo.time, "sleep", lambda seconds: None)

    result = yahoo._fetch_history_with_retry("DMART.NS", date(2026, 9, 1), date(2026, 9, 12), "1d")

    assert not result.empty
    assert attempts["n"] == 2


def test_fetch_history_with_retry_returns_empty_after_exhausting_every_attempt(monkeypatch):
    attempts = {"n": 0}

    class AlwaysFailingTicker:
        def history(self, start, end, interval):
            attempts["n"] += 1
            raise ConnectionError("Could not connect to server")

    monkeypatch.setattr(yahoo.yf, "Ticker", lambda symbol: AlwaysFailingTicker())
    monkeypatch.setattr(yahoo.time, "sleep", lambda seconds: None)

    result = yahoo._fetch_history_with_retry("TOTALLYFAKESYMBOL.NS", date(2026, 9, 1), date(2026, 9, 12), "1d")

    assert result.empty
    assert attempts["n"] == yahoo._HISTORY_RETRY_ATTEMPTS


def test_weekly_interval_maps_to_yfinance_1wk(monkeypatch):
    captured = {}

    class RecordingTicker(_FakeTicker):
        def history(self, start, end, interval):
            captured["interval"] = interval
            return super().history(start, end, interval)

    monkeypatch.setattr(
        yahoo.yf, "Ticker", lambda symbol: RecordingTicker(_fake_df([("2026-09-07", 1, 2, 0.5, 1.5, 10.0)]))
    )

    yahoo.get_candle_history("NSE", "ABB", "weekly", date(2026, 8, 1), date(2026, 9, 12))

    assert captured["interval"] == "1wk"
