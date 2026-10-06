import threading
from types import SimpleNamespace
from uuid import uuid4

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

import app.domain.price_alerts as pa
from app.api.routes import price_alerts as route
from app.auth import User, require_admin, require_user
from app.config import settings
from app.domain.price_alerts import alert_fires

# ---- the crossing test ----------------------------------------------------------------------------------------------------


def test_directional_alert_only_fires_on_the_crossing():
    assert alert_fires("above", 100.0, 95.0, "below") is False
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
    assert alert_fires("above", 100.0, 150.0, None) is False
    assert alert_fires("cross", 100.0, 50.0, None) is False


# ---- dispatch: delivery is part of firing ---------------------------------------------------------------------------------

OWNER = uuid4()
OTHER = uuid4()


def make_alert(**over):
    base = dict(id="a1", user_id=OWNER, exchange="NSE", symbol="NIFTY", target_price=100.0, direction="above", note="n", repeat=False,
                active=True, last_side="below", trigger_count=0, last_triggered_at=None, delivery_failures=0, last_error=None)
    base.update(over)
    return SimpleNamespace(**base)


class FakeDB:
    def __init__(self, alerts):
        self.alerts, self.commits = alerts, 0

    def query(self, *a, **k):
        return self

    def filter(self, *a, **k):
        return self

    def all(self):
        return [a for a in self.alerts if a.active]

    def commit(self):
        self.commits += 1


def run(alert_or_list, price=105.0, channels=None, send=None, monkeypatch=None):
    alerts = alert_or_list if isinstance(alert_or_list, list) else [alert_or_list]
    sent = []
    monkeypatch.setattr(pa, "send_telegram", send or (lambda text, chat: sent.append((chat, text)) or None))
    n = pa.dispatch_due(FakeDB(alerts), batch_quote=lambda ex, syms: {s: price for s in syms}, channels_loader=lambda db: channels if channels is not None else {OWNER: "111"})
    return n, sent


def test_a_delivered_one_shot_alert_fires_and_is_used_up(monkeypatch):
    a = make_alert()
    n, sent = run(a, monkeypatch=monkeypatch)
    assert n == 1 and a.active is False and a.trigger_count == 1 and a.last_side == "above"
    assert a.delivery_failures == 0 and a.last_error is None
    assert sent[0][0] == "111" and "NIFTY" in sent[0][1]


def test_a_failed_send_does_not_use_up_a_one_shot_alert(monkeypatch):
    a = make_alert()
    n, _ = run(a, send=lambda text, chat: "could not reach Telegram", monkeypatch=monkeypatch)
    assert n == 0
    assert a.active is True and a.trigger_count == 0 and a.last_triggered_at is None
    assert a.delivery_failures == 1 and a.last_error == "could not reach Telegram"
    assert a.last_side == "below"  # NOT moved to "above": the crossing must be seen again


def test_the_crossing_is_delivered_on_a_later_pass_once_telegram_works(monkeypatch):
    a = make_alert()
    run(a, send=lambda text, chat: "could not reach Telegram", monkeypatch=monkeypatch)
    n, sent = run(a, price=104.0, monkeypatch=monkeypatch)  # price is still above; Telegram is back
    assert n == 1 and a.active is False and a.trigger_count == 1 and a.delivery_failures == 0 and a.last_error is None
    assert "104" in sent[0][1]


def test_a_repeating_alert_stays_armed_after_a_delivered_send(monkeypatch):
    a = make_alert(repeat=True)
    run(a, monkeypatch=monkeypatch)
    assert a.active is True and a.trigger_count == 1 and a.last_side == "above"


def test_a_user_with_no_chat_is_never_sent_to_the_operators_chat(monkeypatch):
    monkeypatch.setattr(settings, "telegram_chat_id", "OPERATOR")
    a = make_alert(user_id=OTHER)
    n, sent = run(a, channels={OWNER: "111"}, monkeypatch=monkeypatch)
    assert n == 0 and sent == [] and a.active is True
    assert a.last_error == "no Telegram chat set for this account"


def test_each_alert_goes_to_its_own_owners_chat(monkeypatch):
    a, b = make_alert(id="a", user_id=OWNER), make_alert(id="b", user_id=OTHER, symbol="BANKNIFTY")
    n, sent = run([a, b], channels={OWNER: "111", OTHER: "222"}, monkeypatch=monkeypatch)
    assert n == 2 and {chat for chat, _ in sent} == {"111", "222"}
    assert [chat for chat, text in sent if "BANKNIFTY" in text] == ["222"]


def test_an_old_unowned_alert_still_goes_to_the_platform_chat(monkeypatch):
    monkeypatch.setattr(settings, "telegram_chat_id", "OPERATOR")
    n, sent = run(make_alert(user_id=None), channels={}, monkeypatch=monkeypatch)
    assert n == 1 and sent[0][0] == "OPERATOR"


def test_an_alert_that_keeps_failing_is_switched_off_with_the_reason(monkeypatch):
    a = make_alert(delivery_failures=pa.MAX_DELIVERY_FAILURES - 1)
    run(a, send=lambda text, chat: "Telegram rejected the chat id", monkeypatch=monkeypatch)
    assert a.active is False and "switched off after 10 failed sends" in a.last_error and "rejected the chat id" in a.last_error


def test_an_alert_with_no_price_is_left_alone(monkeypatch):
    a = make_alert()
    monkeypatch.setattr(pa, "send_telegram", lambda *a_: pytest.fail("no price, nothing to send"))
    assert pa.dispatch_due(FakeDB([a]), batch_quote=lambda ex, syms: {}, channels_loader=lambda db: {}) == 0
    assert a.last_side == "below" and a.delivery_failures == 0


def test_two_passes_at_once_cannot_both_send_the_same_alert(monkeypatch):
    a = make_alert()
    sent, inside = [], threading.Event()

    def slow_send(text, chat):
        inside.set()
        threading.Event().wait(0.15)  # the second pass would read the alert as still armed here, without the lock
        sent.append(text)

    monkeypatch.setattr(pa, "send_telegram", slow_send)
    db = FakeDB([a])
    args = dict(batch_quote=lambda ex, syms: {s: 105.0 for s in syms}, channels_loader=lambda d: {OWNER: "111"})
    t1 = threading.Thread(target=lambda: pa.dispatch_due(db, **args))
    t1.start()
    inside.wait(2)
    t2 = threading.Thread(target=lambda: pa.dispatch_due(db, **args))
    t2.start()
    t1.join(5)
    t2.join(5)
    assert len(sent) == 1


# ---- the routes: login, chat, symbol, limits --------------------------------------------------------------------------------


def token(sub, admin=False):
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=jwt.encode({"sub": str(sub), "is_admin": admin}, settings.jwt_secret, algorithm=settings.jwt_algorithm))


def test_every_price_alert_route_needs_a_signed_in_user_and_the_operator_ones_an_admin():
    guards = {}
    for r in route.router.routes:
        calls = {d.call for d in r.dependant.dependencies}
        guards[(r.path, tuple(sorted(r.methods)))] = "admin" if require_admin in calls else "user" if require_user in calls else None
    assert None not in guards.values(), f"unauthenticated alert route: {[k for k, v in guards.items() if v is None]}"
    assert guards[("/price-alerts/check", ("POST",))] == "admin"
    assert len(guards) == 8


def test_require_user_reads_the_admin_flag_and_rejects_a_missing_or_bad_token():
    assert require_user(token(OWNER, admin=True)) == User(OWNER, True)
    assert require_user(token(OWNER)).is_admin is False
    for bad in (None, HTTPAuthorizationCredentials(scheme="Bearer", credentials="garbage")):
        with pytest.raises(HTTPException) as e:
            require_user(bad)
        assert e.value.status_code == 401


class RouteDB:
    def __init__(self):
        self.added, self.commits, self.deleted = [], 0, []

    def add(self, row):
        self.added.append(row)

    def commit(self):
        self.commits += 1

    def refresh(self, row):
        pass

    def delete(self, row):
        self.deleted.append(row)

    def get(self, model, key):
        return getattr(self, "channel_row", None)


PAYLOAD = dict(exchange="nse", symbol=" nifty ", target_price=100.0, direction="above", note=None, repeat=False)


def create(monkeypatch, *, chat="111", count=0, ltp=95.0, payload=None):
    monkeypatch.setattr(route, "get_channel", lambda db, uid: chat)
    monkeypatch.setattr(route, "active_count", lambda db, uid: count)
    monkeypatch.setattr(route, "current_ltp", lambda ex, sym, *a: ltp)
    db = RouteDB()
    out = route.create_price_alert(route.PriceAlertCreate(**(payload or PAYLOAD)), User(OWNER, False), db)
    return out, db


def test_create_normalises_the_symbol_owns_the_alert_and_seeds_its_side(monkeypatch):
    out, db = create(monkeypatch, ltp=95.0)
    assert out.current_price == 95.0  # the response says where the price is, so the page can say how far the level is
    row = db.added[0]
    assert (row.exchange, row.symbol, row.user_id) == ("NSE", "NIFTY", OWNER)
    assert row.last_side == "below"  # evaluated from the first minute, not left unseeded
    assert create(monkeypatch, ltp=120.0)[1].added[0].last_side == "above"


def test_create_refuses_without_a_telegram_chat(monkeypatch):
    with pytest.raises(HTTPException) as e:
        create(monkeypatch, chat=None)
    assert e.value.status_code == 400 and "Telegram" in e.value.detail


def test_create_refuses_a_symbol_that_has_no_price(monkeypatch):
    with pytest.raises(HTTPException) as e:
        create(monkeypatch, ltp=None, payload={**PAYLOAD, "symbol": "ZZNOSUCHSYM"})
    assert e.value.status_code == 422 and "NSE:ZZNOSUCHSYM" in e.value.detail


def test_create_refuses_an_unknown_market(monkeypatch):
    with pytest.raises(HTTPException) as e:
        create(monkeypatch, payload={**PAYLOAD, "exchange": "LSE"})
    assert e.value.status_code == 422


def test_create_refuses_past_the_per_user_limit(monkeypatch):
    with pytest.raises(HTTPException) as e:
        create(monkeypatch, count=route.MAX_ACTIVE_ALERTS_PER_USER)
    assert e.value.status_code == 400


def test_the_chat_id_must_be_a_number_and_an_empty_one_clears_it():
    db = RouteDB()
    with pytest.raises(HTTPException) as e:
        route.set_alert_channel(route.ChannelIn(telegram_chat_id="@somebody"), User(OWNER, False), db)
    assert e.value.status_code == 422
    out = route.set_alert_channel(route.ChannelIn(telegram_chat_id=" -1001234567890 "), User(OWNER, False), db)
    assert out.chat_set and out.chat_id_hint == "…7890" and db.added[0].telegram_chat_id == "-1001234567890"
    db.channel_row = db.added[0]
    cleared = route.set_alert_channel(route.ChannelIn(telegram_chat_id=""), User(OWNER, False), db)
    assert not cleared.chat_set and db.deleted == [db.added[0]]


def test_the_test_message_goes_to_the_callers_own_chat_and_is_rate_limited(monkeypatch):
    sent = []
    monkeypatch.setattr(route, "get_channel", lambda db, uid: "555")
    monkeypatch.setattr(route, "send_telegram", lambda text, chat: sent.append(chat) or None)
    route._last_test.clear()
    me = User(uuid4(), False)
    assert route.test_telegram(me, RouteDB()) == {"sent": True} and sent == ["555"]
    with pytest.raises(HTTPException) as e:
        route.test_telegram(me, RouteDB())
    assert e.value.status_code == 429


def test_a_failed_test_message_says_why(monkeypatch):
    monkeypatch.setattr(route, "get_channel", lambda db, uid: "555")
    monkeypatch.setattr(route, "send_telegram", lambda text, chat: "the bot cannot message this chat (start the bot first)")
    route._last_test.clear()
    with pytest.raises(HTTPException) as e:
        route.test_telegram(User(uuid4(), False), RouteDB())
    assert e.value.status_code == 503 and "start the bot first" in e.value.detail


def test_without_a_chat_the_test_message_is_refused(monkeypatch):
    monkeypatch.setattr(route, "get_channel", lambda db, uid: None)
    with pytest.raises(HTTPException) as e:
        route.test_telegram(User(uuid4(), False), RouteDB())
    assert e.value.status_code == 400
