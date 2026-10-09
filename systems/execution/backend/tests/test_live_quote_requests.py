"""The stop-loss / target check asks market-data for LIVE prices (the feed's ticks), and nothing else does."""

from types import SimpleNamespace

from app import scheduler
from app.adapters.quotes import client


class FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {"prices": {"NIFTY": 22300.5}}


def test_the_batch_client_only_asks_for_live_prices_when_told_to(monkeypatch):
    sent = []
    monkeypatch.setattr(client.requests, "post", lambda url, json=None, **kw: (sent.append(json), FakeResponse())[1])
    assert client.get_ltp_batch("NSE", ["NIFTY"]) == {"NIFTY": 22300.5}
    assert client.get_ltp_batch("NSE", ["NIFTY"], live=True) == {"NIFTY": 22300.5}
    assert sent == [{"exchange": "NSE", "symbols": ["NIFTY"]}, {"exchange": "NSE", "symbols": ["NIFTY"], "live": True}]  # the plain call is byte-for-byte what it was


def test_the_live_wrapper_passes_everything_else_through(monkeypatch):
    seen = []
    monkeypatch.setattr(scheduler, "get_ltp_batch", lambda exchange, symbols, **kw: (seen.append((exchange, symbols, kw)), {})[1])
    scheduler.get_ltp_batch_live("NSE", ["NIFTY"], on_behalf_of="u1")
    assert seen == [("NSE", ["NIFTY"], {"live": True, "on_behalf_of": "u1"})]


def test_the_exit_check_uses_live_prices_and_the_other_jobs_do_not(monkeypatch):
    class Session:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    got = {}
    empty = {"closed_stop_loss": 0, "closed_target": 0, "closed_exit_condition": 0, "trailed": 0}
    monkeypatch.setattr(scheduler, "SessionLocal", Session)
    monkeypatch.setattr(scheduler, "check_exits", lambda db, ltp, *a: (got.__setitem__("positions", ltp), empty)[1])
    monkeypatch.setattr(scheduler, "check_option_group_exits", lambda db, ltp, *a: (got.__setitem__("groups", ltp), empty)[1])
    scheduler.run_check_exits()
    assert got["positions"] is scheduler.get_ltp_batch_live and got["groups"] is scheduler.get_ltp_batch_live
    squared = {}
    monkeypatch.setattr(scheduler, "square_off_due_positions", lambda db, ltp: (squared.__setitem__("ltp", ltp), {"closed": 0, "failed": 0})[1])
    monkeypatch.setattr(scheduler, "square_off_due_option_groups", lambda db, ltp: {"closed": 0, "failed": 0})
    scheduler.run_square_off_due()
    assert squared["ltp"] is scheduler.get_ltp_batch  # a square-off is not time-critical to the second
