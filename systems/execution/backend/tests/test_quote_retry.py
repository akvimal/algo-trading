from app.domain import option_position_manager as opm


def test_a_quote_that_comes_back_empty_once_is_asked_for_again(monkeypatch):
    calls = []

    def fake(segment, symbols):
        calls.append(list(symbols))
        return {} if len(calls) == 1 else {s: 10.0 for s in symbols}

    monkeypatch.setattr(opm, "get_ltp_batch", fake)
    monkeypatch.setattr(opm.time, "sleep", lambda s: None)
    assert opm._quotes_for_open("NSE", ["A-CE", "A"]) == {"A-CE": 10.0, "A": 10.0}
    assert len(calls) == 2


def test_it_gives_up_after_the_retries_and_returns_what_it_has(monkeypatch):
    calls = []
    monkeypatch.setattr(opm, "get_ltp_batch", lambda segment, symbols: calls.append(1) or {})
    monkeypatch.setattr(opm.time, "sleep", lambda s: None)
    assert opm._quotes_for_open("NSE", ["A-CE"]) == {}
    assert len(calls) == 1 + opm.QUOTE_RETRIES


def test_nothing_is_retried_when_every_price_arrives(monkeypatch):
    calls = []
    monkeypatch.setattr(opm, "get_ltp_batch", lambda segment, symbols: calls.append(1) or {s: 5.0 for s in symbols})
    assert opm._quotes_for_open("NSE", ["A-CE"]) == {"A-CE": 5.0}
    assert len(calls) == 1
