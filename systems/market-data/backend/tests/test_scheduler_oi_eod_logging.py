"""_record_oi_eod_snapshot must leave a trace of what it did. It used to skip
symbols with bare `continue`s and no log line, so a run that wrote nothing
(empty symbol list, nothing resolving, no expiries) was indistinguishable from
a run that never happened. Plain fakes, same convention as the other
scheduler tests."""

import logging
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from app import scheduler

FRIDAY = datetime(2026, 9, 25, 15, 40, tzinfo=ZoneInfo("Asia/Kolkata"))
SATURDAY = datetime(2026, 9, 26, 15, 40, tzinfo=ZoneInfo("Asia/Kolkata"))


def freeze(monkeypatch, moment):
    class FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return moment

    monkeypatch.setattr(scheduler, "datetime", FakeDatetime)


class FakeQuery:
    def filter(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def first(self):
        return None


class FakeDb:
    def __init__(self):
        self.added = []
        self.rollbacks = 0

    def query(self, *a):
        return FakeQuery()

    def add(self, row):
        self.added.append(row)

    def commit(self):
        pass

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        pass


def chain(call_oi=100, put_oi=150):
    return SimpleNamespace(
        strikes=[SimpleNamespace(ce=SimpleNamespace(oi=call_oi), pe=SimpleNamespace(oi=put_oi))],
        underlying_last_price=500.0,
    )


class FakeProvider:
    def __init__(self, symbols, resolve=True, expiries=("2026-09-29",), option_chain=None, boom_on=()):
        self.symbols = symbols
        self.resolve = resolve
        self.expiries = list(expiries)
        self.option_chain = option_chain
        self.boom_on = set(boom_on)

    def list_fno_stock_underlyings(self):
        return self.symbols

    def resolve_underlying(self, symbol):
        if symbol in self.boom_on:
            raise RuntimeError("Dhan 401")
        return SimpleNamespace(chart_symbol=symbol) if self.resolve else None

    def get_expiry_list(self, symbol):
        return self.expiries

    def get_option_chain(self, symbol, expiry):
        return self.option_chain


@pytest.fixture
def db(monkeypatch):
    fake = FakeDb()
    monkeypatch.setattr(scheduler, "SessionLocal", lambda: fake)
    monkeypatch.setattr(scheduler.time, "sleep", lambda _s: None)
    return fake


def run(monkeypatch, provider, moment=FRIDAY):
    freeze(monkeypatch, moment)
    monkeypatch.setattr(scheduler, "get_provider", lambda name: provider)
    scheduler._record_oi_eod_snapshot()


def messages(caplog):
    return [(r.levelno, r.getMessage()) for r in caplog.records if r.name == scheduler.logger.name]


def test_an_empty_symbol_list_is_a_warning_not_silence(monkeypatch, db, caplog):
    with caplog.at_level(logging.INFO, logger=scheduler.logger.name):
        run(monkeypatch, FakeProvider([]))
    assert any(level == logging.WARNING and "0 NSE F&O stocks" in m for level, m in messages(caplog))


def test_a_run_where_nothing_resolves_says_so_and_why(monkeypatch, db, caplog):
    with caplog.at_level(logging.INFO, logger=scheduler.logger.name):
        run(monkeypatch, FakeProvider(["TCS", "INFY", "SBIN"], resolve=False))
    summary = [(lv, m) for lv, m in messages(caplog) if "finished" in m]
    assert len(summary) == 1
    level, text = summary[0]
    assert level == logging.WARNING and "NOTHING WAS WRITTEN" in text
    assert "0/3 written" in text and "unresolved=3" in text
    assert db.added == []


@pytest.mark.parametrize(
    "provider_kwargs, key",
    [({"expiries": []}, "no_expiry=2"), ({"option_chain": None}, "no_chain=2")],
)
def test_each_skip_reason_is_counted(monkeypatch, db, caplog, provider_kwargs, key):
    with caplog.at_level(logging.INFO, logger=scheduler.logger.name):
        run(monkeypatch, FakeProvider(["TCS", "INFY"], **provider_kwargs))
    text = [m for _, m in messages(caplog) if "finished" in m][0]
    assert key in text and "0/2 written" in text


def test_a_mixed_run_reports_written_and_failed_at_info(monkeypatch, db, caplog):
    provider = FakeProvider(["TCS", "INFY"], option_chain=chain(), boom_on={"INFY"})
    with caplog.at_level(logging.INFO, logger=scheduler.logger.name):
        run(monkeypatch, provider)
    level, text = [(lv, m) for lv, m in messages(caplog) if "finished" in m][0]
    assert level == logging.INFO and "1/2 written" in text and "failed=1" in text
    assert any("starting, 2 symbols" in m for _, m in messages(caplog))
    assert len(db.added) == 1 and db.rollbacks == 1


def test_a_weekend_run_logs_that_it_skipped(monkeypatch, db, caplog):
    with caplog.at_level(logging.INFO, logger=scheduler.logger.name):
        run(monkeypatch, FakeProvider(["TCS"], option_chain=chain()), moment=SATURDAY)
    assert any("weekend" in m for _, m in messages(caplog))
    assert db.added == []
