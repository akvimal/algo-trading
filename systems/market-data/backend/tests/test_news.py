import pytest

from app.config import settings
from app.providers import news


def _row(title: str, entities: list[dict], published_at: str = "2026-09-12T00:00:00.000000Z") -> dict:
    return {
        "title": title,
        "url": f"https://example.com/{title}",
        "source": "example.com",
        "published_at": published_at,
        "image_url": None,
        "entities": entities,
    }


@pytest.fixture(autouse=True)
def _fake_api_key(monkeypatch):
    monkeypatch.setattr(settings, "marketaux_api_key", "test-key")
    monkeypatch.setattr(settings, "openrouter_api_key", "")  # AI off unless a test opts in


class _NoopSession:
    def add(self, obj):
        pass

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


@pytest.fixture(autouse=True)
def _stub_session_local(monkeypatch):
    """_refresh_crypto_bucket/_refresh_search_underlying call _persist_digest
    on every refresh, which opens a real SessionLocal() - without stubbing
    it, every test above would try to write to whatever Postgres
    settings.database_url happens to point at (e.g. the dev stack on a dev
    machine). Tests that want to verify persistence itself override this
    back with their own fake session (see below) - since monkeypatch is
    shared per test, a later setattr in the test body wins over this one."""
    monkeypatch.setattr(news, "SessionLocal", lambda: _NoopSession())


def test_get_news_rejects_unsupported_underlying():
    with pytest.raises(ValueError):
        news.get_news("DOGEUSD")


def test_get_news_without_api_key_raises(monkeypatch):
    monkeypatch.setattr(settings, "marketaux_api_key", "")
    with pytest.raises(RuntimeError):
        news.get_news("BTCUSD")


def test_crypto_bucket_is_one_call_covering_all_three_symbols(monkeypatch):
    calls = []

    def fake_fetch(params):
        calls.append(params)
        return [
            _row("BTC and ETH both rally", [{"symbol": "CC:BTC", "sentiment_score": 0.5}, {"symbol": "CC:ETH", "sentiment_score": 0.2}]),
            _row("SOL breaks out", [{"symbol": "CC:SOL", "sentiment_score": -0.1}]),
            _row("Unrelated equity news", [{"symbol": "AAPL", "sentiment_score": 0.9}]),
        ]

    monkeypatch.setattr(news, "_fetch", fake_fetch)

    btc = news.get_news("BTCUSD")
    eth = news.get_news("ETHUSD")
    sol = news.get_news("SOLUSD")

    assert len(calls) == 1  # one combined call served all three underlyings
    assert calls[0]["symbols"] == "CC:BTC,CC:ETH,CC:SOL"

    assert [a.title for a in btc.articles] == ["BTC and ETH both rally"]
    assert btc.articles[0].sentiment_score == 0.5
    assert [a.title for a in eth.articles] == ["BTC and ETH both rally"]
    assert eth.articles[0].sentiment_score == 0.2
    assert [a.title for a in sol.articles] == ["SOL breaks out"]


def test_search_underlying_uses_its_own_keyword(monkeypatch):
    calls = []

    def fake_fetch(params):
        calls.append(params)
        return [_row("Nifty 50 hits record high", [])]

    monkeypatch.setattr(news, "_fetch", fake_fetch)

    digest = news.get_news("NIFTY")

    assert len(calls) == 1
    assert calls[0]["search"] == "Nifty 50"
    assert digest.articles[0].title == "Nifty 50 hits record high"


def test_cache_is_reused_within_ttl(monkeypatch):
    calls = []
    monkeypatch.setattr(news, "_fetch", lambda params: calls.append(params) or [])

    news.get_news("BTCUSD")
    news.get_news("BTCUSD")
    news.get_news("ETHUSD")  # same bucket, already warm

    assert len(calls) == 1


def test_stale_cache_is_served_when_refresh_fails(monkeypatch):
    good_rows = [_row("Gold steady ahead of Fed", [])]
    monkeypatch.setattr(news, "_fetch", lambda params: good_rows)
    first = news.get_news("GOLDM")
    assert first.articles[0].title == "Gold steady ahead of Fed"

    # Expire the cache, then make the next refresh fail - should fall back
    # to the stale copy instead of raising.
    underlying, (digest, _fetched_at) = "GOLDM", news._cache["GOLDM"]
    news._cache[underlying] = (digest, 0.0)

    def failing_fetch(params):
        raise RuntimeError("marketaux is down")

    monkeypatch.setattr(news, "_fetch", failing_fetch)
    second = news.get_news("GOLDM")
    assert second.articles[0].title == "Gold steady ahead of Fed"


def test_raises_when_nothing_cached_and_refresh_fails(monkeypatch):
    monkeypatch.setattr(news, "_fetch", lambda params: (_ for _ in ()).throw(RuntimeError("down")))
    with pytest.raises(RuntimeError):
        news.get_news("CRUDEOILM")


def test_without_openrouter_key_falls_back_to_unscored_headlines(monkeypatch):
    monkeypatch.setattr(news, "_fetch", lambda params: [_row("Nifty 50 hits record high", [])])

    digest = news.get_news("NIFTY")

    assert digest.bias == "neutral"
    assert digest.articles[0].relevance_score is None
    assert digest.articles[0].why is None


def test_ai_analysis_scores_and_filters_articles(monkeypatch):
    monkeypatch.setattr(settings, "openrouter_api_key", "test-or-key")
    rows = [
        _row("Bitcoin ETF sees record inflows", [{"symbol": "CC:BTC", "sentiment_score": 0.6}]),
        _row("Celebrity chef opens new restaurant", [{"symbol": "CC:BTC", "sentiment_score": 0.0}]),
    ]
    monkeypatch.setattr(news, "_fetch", lambda params: rows)

    calls = []

    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": {
                                "bias": "bullish",
                                "bias_reason": "Strong ETF inflows",
                                "digest": "Bitcoin ETF inflows are driving bullish momentum.",
                                "articles": [
                                    {
                                        "url": rows[0]["url"],
                                        "relevance_score": 85,
                                        "why": "Direct demand signal for BTC.",
                                    }
                                ],
                            }
                        }
                    }
                ]
            }

    def fake_post(url, headers, json, timeout):
        calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
        return FakeResponse()

    monkeypatch.setattr(news.requests, "post", fake_post)

    digest = news.get_news("BTCUSD")

    assert len(calls) == 1
    assert calls[0]["headers"]["Authorization"] == "Bearer test-or-key"
    assert calls[0]["json"]["model"] == settings.openrouter_model
    assert digest.bias == "bullish"
    assert digest.bias_reason == "Strong ETF inflows"
    assert len(digest.articles) == 1  # the irrelevant celebrity-chef article was filtered out
    assert digest.articles[0].title == "Bitcoin ETF sees record inflows"
    assert digest.articles[0].relevance_score == 85
    assert digest.articles[0].why == "Direct demand signal for BTC."
    assert digest.articles[0].sentiment_score == 0.6  # re-attached from the original marketaux row


def test_ai_analysis_failure_falls_back_to_unscored_headlines(monkeypatch):
    monkeypatch.setattr(settings, "openrouter_api_key", "test-or-key")
    monkeypatch.setattr(news, "_fetch", lambda params: [_row("Gold rises on Fed bets", [])])

    def failing_post(*args, **kwargs):
        raise RuntimeError("OpenRouter is down")

    monkeypatch.setattr(news.requests, "post", failing_post)

    digest = news.get_news("GOLDM")

    assert digest.bias == "neutral"
    assert digest.articles[0].title == "Gold rises on Fed bets"
    assert digest.articles[0].relevance_score is None


def test_ai_scored_articles_are_sorted_newest_first(monkeypatch):
    """Confirmed live: the AI's own article order isn't chronological (it
    orders by whatever it judged most relevant) - the tab should still
    show newest first regardless of that order."""
    monkeypatch.setattr(settings, "openrouter_api_key", "test-or-key")
    rows = [
        _row("Older article", [{"symbol": "CC:BTC"}], published_at="2026-09-10T00:00:00.000000Z"),
        _row("Newest article", [{"symbol": "CC:BTC"}], published_at="2026-09-12T00:00:00.000000Z"),
        _row("Middle article", [{"symbol": "CC:BTC"}], published_at="2026-09-11T00:00:00.000000Z"),
    ]
    monkeypatch.setattr(news, "_fetch", lambda params: rows)

    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": {
                                "bias": "neutral",
                                "bias_reason": "mixed",
                                "digest": "mixed signals",
                                # Deliberately NOT in chronological order.
                                "articles": [
                                    {"url": rows[0]["url"], "relevance_score": 90, "why": "x"},
                                    {"url": rows[1]["url"], "relevance_score": 50, "why": "y"},
                                    {"url": rows[2]["url"], "relevance_score": 70, "why": "z"},
                                ],
                            }
                        }
                    }
                ]
            }

    monkeypatch.setattr(news.requests, "post", lambda *a, **k: FakeResponse())

    digest = news.get_news("BTCUSD")

    assert [a.title for a in digest.articles] == ["Newest article", "Middle article", "Older article"]


def test_persist_digest_writes_a_news_history_row(monkeypatch):
    added = []

    class FakeSession:
        def add(self, obj):
            added.append(obj)

        def commit(self):
            pass

        def rollback(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(news, "SessionLocal", lambda: FakeSession())

    digest = news.NewsDigest(
        bias="bullish",
        bias_reason="Strong demand",
        digest="Demand is picking up.",
        articles=[
            news.NewsArticle(
                title="Test headline",
                url="https://example.com/test",
                source="example.com",
                published_at="2026-09-12T00:00:00.000000Z",
                relevance_score=80,
                why="Direct demand signal.",
            )
        ],
    )

    news._persist_digest("BTCUSD", digest)

    assert len(added) == 1
    row = added[0]
    assert row.underlying == "BTCUSD"
    assert row.bias == "bullish"
    assert row.articles[0]["title"] == "Test headline"


def test_persist_digest_failure_does_not_raise(monkeypatch):
    class FailingSession:
        def add(self, obj):
            raise RuntimeError("db is down")

        def rollback(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(news, "SessionLocal", lambda: FailingSession())

    digest = news.NewsDigest(bias="neutral", bias_reason="n/a", digest="n/a", articles=[])
    news._persist_digest("BTCUSD", digest)  # should not raise
