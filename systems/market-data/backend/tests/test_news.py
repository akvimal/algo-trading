import pytest

from app.config import settings
from app.providers import news


def _row(title: str, published_at: str = "2026-09-12T00:00:00+00:00", description: str = "") -> dict:
    return {
        "title": title,
        "url": f"https://example.com/{title}",
        "description": description,
        "published_at": published_at,
        "source": "Test Source",
    }


@pytest.fixture(autouse=True)
def _fake_openrouter_key_off(monkeypatch):
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
    """_refresh_bucket calls _persist_digest on every refresh, which opens
    a real SessionLocal() - without stubbing it, every test above would try
    to write to whatever Postgres settings.database_url happens to point
    at (e.g. the dev stack on a dev machine). Tests that want to verify
    persistence itself override this back with their own fake session (see
    below) - since monkeypatch is shared per test, a later setattr in the
    test body wins over this one."""
    monkeypatch.setattr(news, "SessionLocal", lambda: _NoopSession())


def test_get_news_rejects_unsupported_underlying():
    with pytest.raises(ValueError):
        news.get_news("DOGEUSD")


def test_get_news_rejects_unsupported_underlying_even_with_non_nse_segment():
    with pytest.raises(ValueError):
        news.get_news("DOGEUSD", segment="CRYPTO")


# --- generic NSE stock fallback (segment="NSE", underlying not curated) --


def test_generic_stock_news_matches_bare_ticker_as_a_whole_word(monkeypatch):
    monkeypatch.setattr(
        news,
        "_fetch_bucket",
        lambda feeds: [
            _row("TCS reports strong Q2 results", description="Tata Consultancy Services beat estimates"),
            _row("Some abbreviation nonsense"),  # must NOT match "ABB" as a bare substring
            _row("Unrelated market wrap"),
        ],
    )

    digest = news.get_news("TCS", segment="NSE")

    assert [a.title for a in digest.articles] == ["TCS reports strong Q2 results"]


def test_generic_stock_news_does_not_substring_match_inside_another_word(monkeypatch):
    monkeypatch.setattr(
        news,
        "_fetch_bucket",
        lambda feeds: [_row("Some abbreviation nonsense"), _row("Cabbage prices unrelated")],
    )

    digest = news.get_news("ABB", segment="NSE")

    assert digest.articles == []


def test_generic_stock_news_falls_back_to_stale_cache_on_fetch_failure(monkeypatch):
    monkeypatch.setattr(news, "_fetch_bucket", lambda feeds: [_row("TCS wins a new deal")])
    first = news.get_news("TCS", segment="NSE")

    news._cache.pop("TCS")  # simulate TTL expiry while keeping the stale-fallback path exercised
    news._cache["TCS"] = (first, 0.0)  # re-seed as "stale" (fetched_at=0 is always expired)

    def fail_fetch(feeds):
        raise RuntimeError("feed down")

    monkeypatch.setattr(news, "_fetch_bucket", fail_fetch)

    second = news.get_news("TCS", segment="NSE")
    assert second is first


def test_crypto_bucket_is_one_fetch_covering_all_three_symbols(monkeypatch):
    calls = []

    def fake_fetch_bucket(feeds):
        calls.append(feeds)
        return [
            _row("Bitcoin and Ethereum both rally", description="Bitcoin and Ethereum surge together"),
            _row("Solana breaks out"),
            _row("Unrelated equity news"),
        ]

    monkeypatch.setattr(news, "_fetch_bucket", fake_fetch_bucket)

    btc = news.get_news("BTCUSD")
    eth = news.get_news("ETHUSD")
    sol = news.get_news("SOLUSD")

    assert len(calls) == 1  # one combined fetch served all three underlyings
    assert calls[0] is news._CRYPTO_FEEDS

    assert [a.title for a in btc.articles] == ["Bitcoin and Ethereum both rally"]
    assert [a.title for a in eth.articles] == ["Bitcoin and Ethereum both rally"]
    assert [a.title for a in sol.articles] == ["Solana breaks out"]


def test_nse_mcx_bucket_is_one_fetch_covering_all_four_underlyings(monkeypatch):
    calls = []

    def fake_fetch_bucket(feeds):
        calls.append(feeds)
        return [
            _row("Nifty 50 hits record high"),
            _row("Bank Nifty slips on rate fears"),
            _row("Gold prices steady ahead of Fed"),
            _row("Crude oil rises on supply concerns"),
        ]

    monkeypatch.setattr(news, "_fetch_bucket", fake_fetch_bucket)

    nifty = news.get_news("NIFTY")
    banknifty = news.get_news("BANKNIFTY")
    goldm = news.get_news("GOLDM")
    crudeoilm = news.get_news("CRUDEOILM")

    assert len(calls) == 1
    assert calls[0] is news._NSE_MCX_FEEDS

    assert nifty.articles[0].title == "Nifty 50 hits record high"
    assert banknifty.articles[0].title == "Bank Nifty slips on rate fears"
    assert goldm.articles[0].title == "Gold prices steady ahead of Fed"
    assert crudeoilm.articles[0].title == "Crude oil rises on supply concerns"


def test_cache_is_reused_within_ttl(monkeypatch):
    calls = []
    monkeypatch.setattr(news, "_fetch_bucket", lambda feeds: calls.append(feeds) or [])

    news.get_news("BTCUSD")
    news.get_news("BTCUSD")
    news.get_news("ETHUSD")  # same bucket, already warm

    assert len(calls) == 1


def test_stale_cache_is_served_when_refresh_fails(monkeypatch):
    good_rows = [_row("Gold steady ahead of Fed")]
    monkeypatch.setattr(news, "_fetch_bucket", lambda feeds: good_rows)
    first = news.get_news("GOLDM")
    assert first.articles[0].title == "Gold steady ahead of Fed"

    # Expire the cache, then make the next refresh fail - should fall back
    # to the stale copy instead of raising.
    underlying, (digest, _fetched_at) = "GOLDM", news._cache["GOLDM"]
    news._cache[underlying] = (digest, 0.0)

    def failing_fetch(feeds):
        raise RuntimeError("all news feeds are down")

    monkeypatch.setattr(news, "_fetch_bucket", failing_fetch)
    second = news.get_news("GOLDM")
    assert second.articles[0].title == "Gold steady ahead of Fed"


def test_raises_when_nothing_cached_and_refresh_fails(monkeypatch):
    monkeypatch.setattr(news, "_fetch_bucket", lambda feeds: (_ for _ in ()).throw(RuntimeError("down")))
    with pytest.raises(RuntimeError):
        news.get_news("CRUDEOILM")


def test_fetch_bucket_tolerates_one_feed_failing(monkeypatch):
    """A Livemint hiccup shouldn't blank ET's articles too - only raises
    when every feed in the bucket failed."""

    def fake_fetch_rss(url, label):
        if label == "Mint":
            raise RuntimeError("Mint is down")
        return [_row("ET headline")]

    monkeypatch.setattr(news, "_fetch_rss", fake_fetch_rss)

    rows = news._fetch_bucket(news._NSE_MCX_FEEDS)

    assert [r["title"] for r in rows] == ["ET headline"]


def test_fetch_bucket_raises_when_every_feed_fails(monkeypatch):
    monkeypatch.setattr(news, "_fetch_rss", lambda url, label: (_ for _ in ()).throw(RuntimeError(f"{label} down")))

    with pytest.raises(RuntimeError):
        news._fetch_bucket(news._NSE_MCX_FEEDS)


def test_without_openrouter_key_falls_back_to_unscored_headlines(monkeypatch):
    monkeypatch.setattr(news, "_fetch_bucket", lambda feeds: [_row("Nifty 50 hits record high")])

    digest = news.get_news("NIFTY")

    assert digest.bias == "neutral"
    assert digest.articles[0].relevance_score is None
    assert digest.articles[0].why is None


def test_ai_analysis_scores_and_filters_articles(monkeypatch):
    monkeypatch.setattr(settings, "openrouter_api_key", "test-or-key")
    # Both rows mention "bitcoin" so both pass the keyword pre-filter and
    # reach the (mocked) AI call - the AI's own response below excludes
    # the second one, demonstrating AI-level relevance filtering rather
    # than the keyword-match step doing the work.
    rows = [
        _row("Bitcoin ETF sees record inflows", description="Spot ETF inflows hit a record"),
        _row("Bitcoin-themed restaurant opens downtown"),
    ]
    monkeypatch.setattr(news, "_fetch_bucket", lambda feeds: rows)

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
    assert len(digest.articles) == 1  # the AI excluded the irrelevant restaurant article
    assert digest.articles[0].title == "Bitcoin ETF sees record inflows"
    assert digest.articles[0].relevance_score == 85
    assert digest.articles[0].why == "Direct demand signal for BTC."


def test_ai_analysis_failure_falls_back_to_unscored_headlines(monkeypatch):
    monkeypatch.setattr(settings, "openrouter_api_key", "test-or-key")
    monkeypatch.setattr(news, "_fetch_bucket", lambda feeds: [_row("Gold rises on Fed bets")])

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
        _row("Older Bitcoin article", published_at="2026-09-10T00:00:00+00:00"),
        _row("Newest Bitcoin article", published_at="2026-09-12T00:00:00+00:00"),
        _row("Middle Bitcoin article", published_at="2026-09-11T00:00:00+00:00"),
    ]
    monkeypatch.setattr(news, "_fetch_bucket", lambda feeds: rows)

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

    assert [a.title for a in digest.articles] == ["Newest Bitcoin article", "Middle Bitcoin article", "Older Bitcoin article"]


def _fake_ai_response(bias="neutral"):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": {"bias": bias, "bias_reason": "x", "digest": "y", "articles": []}}}]}

    return FakeResponse()


def test_unchanged_articles_skip_a_second_ai_call(monkeypatch):
    """The whole point of _last_fingerprint: an RSS refresh that turns up
    the exact same matched articles as last time shouldn't spend another
    OpenRouter call (or log another news_history row) re-digesting input
    it's already analyzed."""
    monkeypatch.setattr(settings, "openrouter_api_key", "test-or-key")
    rows = [_row("Bitcoin holds steady above $70k")]
    monkeypatch.setattr(news, "_fetch_bucket", lambda feeds: rows)

    ai_calls = []
    persisted = []
    monkeypatch.setattr(news.requests, "post", lambda *a, **k: ai_calls.append(1) or _fake_ai_response())
    monkeypatch.setattr(news, "_persist_digest", lambda underlying, digest: persisted.append(underlying))

    first = news.get_news("BTCUSD")
    assert len(ai_calls) == 1
    # ETHUSD/SOLUSD also persist on this first pass (no matching rows for
    # either, but still a first-ever - and therefore fresh - digest each).
    assert persisted.count("BTCUSD") == 1

    # Expire the cache (simulating the next refresh cycle) without changing
    # the underlying feed content at all.
    digest, _fetched_at = news._cache["BTCUSD"]
    news._cache["BTCUSD"] = (digest, 0.0)

    second = news.get_news("BTCUSD")
    assert len(ai_calls) == 1  # no second OpenRouter call
    assert persisted.count("BTCUSD") == 1  # no second news_history row
    assert second is first  # the exact same digest object was reused


def test_new_articles_trigger_a_fresh_ai_call(monkeypatch):
    monkeypatch.setattr(settings, "openrouter_api_key", "test-or-key")
    rows = [_row("Bitcoin holds steady above $70k")]
    current_rows = list(rows)
    monkeypatch.setattr(news, "_fetch_bucket", lambda feeds: current_rows)

    ai_calls = []
    monkeypatch.setattr(news.requests, "post", lambda *a, **k: ai_calls.append(1) or _fake_ai_response())

    news.get_news("BTCUSD")
    assert len(ai_calls) == 1

    # Expire the cache AND let a genuinely new article show up this time.
    digest, _fetched_at = news._cache["BTCUSD"]
    news._cache["BTCUSD"] = (digest, 0.0)
    current_rows.append(_row("Bitcoin ETF sees fresh inflows"))

    news.get_news("BTCUSD")
    assert len(ai_calls) == 2  # the changed article set triggered a new call


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
                source="Test Source",
                published_at="2026-09-12T00:00:00+00:00",
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


def test_parse_pubdate_normalizes_rfc822_to_iso():
    iso = news._parse_pubdate("Sat, 12 Sep 2026 13:24:36 +0530")
    assert iso.startswith("2026-09-12T13:24:36")


def test_parse_pubdate_passes_through_unparseable_input():
    assert news._parse_pubdate("not a date") == "not a date"
    assert news._parse_pubdate(None) == ""


def test_fetch_rss_parses_items(monkeypatch):
    xml = """<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item>
        <title><![CDATA[Nifty 50 hits record high]]></title>
        <link>https://example.com/nifty-record</link>
        <description><![CDATA[Some <b>bold</b> summary text]]></description>
        <pubDate>Sat, 12 Sep 2026 13:24:36 +0530</pubDate>
      </item>
      <item>
        <title></title>
        <link>https://example.com/no-title</link>
      </item>
    </channel></rss>"""

    class FakeResponse:
        content = xml.encode("utf-8")

        def raise_for_status(self):
            pass

    monkeypatch.setattr(news.requests, "get", lambda url, timeout, headers: FakeResponse())

    rows = news._fetch_rss("https://example.com/rss", "Example")

    assert len(rows) == 1  # the title-less item is skipped
    assert rows[0]["title"] == "Nifty 50 hits record high"
    assert rows[0]["url"] == "https://example.com/nifty-record"
    assert rows[0]["source"] == "Example"
    assert rows[0]["published_at"].startswith("2026-09-12T13:24:36")
