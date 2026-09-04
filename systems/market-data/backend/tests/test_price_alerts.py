from app.domain.price_alerts import alert_fires


def test_directional_alert_only_fires_on_the_crossing():
    # above-alert at 100, price walking up through it
    assert alert_fires("above", 100.0, 95.0, "below") is False  # seeding, no fire (last_side None handled below)
    assert alert_fires("above", 100.0, 101.0, "below") is True  # below -> above
    assert alert_fires("above", 100.0, 102.0, "above") is False  # already above, no re-fire
    assert alert_fires("above", 100.0, 98.0, "above") is False  # dropped back - an 'above' alert ignores this


def test_below_alert():
    assert alert_fires("below", 100.0, 99.0, "above") is True
    assert alert_fires("below", 100.0, 98.0, "below") is False


def test_cross_alert_fires_either_way():
    assert alert_fires("cross", 100.0, 101.0, "below") is True
    assert alert_fires("cross", 100.0, 99.0, "above") is True
    assert alert_fires("cross", 100.0, 101.0, "above") is False


def test_never_fires_before_the_first_check_seeds_last_side():
    # an alert added while price is already past its level must not fire
    # immediately - last_side is None until the first pass.
    assert alert_fires("above", 100.0, 150.0, None) is False
    assert alert_fires("cross", 100.0, 50.0, None) is False


def test_dispatch_due_fires_and_deactivates_one_shot(monkeypatch):
    from types import SimpleNamespace

    import app.domain.price_alerts as pa

    sent: list[str] = []
    monkeypatch.setattr(pa, "notify_telegram", lambda text: sent.append(text) or True)

    alert = SimpleNamespace(
        id="a1",
        user_id=None,
        exchange="NSE",
        symbol="NIFTY",
        target_price=100.0,
        direction="above",
        note="test",
        repeat=False,
        active=True,
        last_side="below",
        trigger_count=0,
        last_triggered_at=None,
    )

    class FakeQuery:
        def filter(self, *a, **k):
            return self

        def all(self):
            return [alert]

    class FakeDB:
        def query(self, *a, **k):
            return FakeQuery()

        def commit(self):
            pass

    n = pa.dispatch_due(FakeDB(), batch_quote=lambda ex, syms: {"NIFTY": 105.0})
    assert n == 1
    assert sent and "NIFTY" in sent[0]
    assert alert.active is False
    assert alert.trigger_count == 1
    assert alert.last_side == "above"
