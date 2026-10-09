"""Each news article is judged once per instrument (app/domain/news_scores.py): only unseen articles go to the model."""

import json

import pytest

from app.providers import news


class Store:
    """An in-memory stand-in for market_data.news_article_scores and the news_history log."""

    def __init__(self):
        self.scores: dict[tuple[str, str], dict] = {}
        self.history: dict[str, dict] = {}

    def load(self, underlying, urls):
        return {u: self.scores[(underlying, u)] for u in urls if (underlying, u) in self.scores}

    def save(self, underlying, judged):
        for url, verdict in judged.items():
            self.scores[(underlying, url)] = {"relevant": verdict is not None, "score": verdict["score"] if verdict else None, "why": verdict["why"] if verdict else None}

    def latest_digest(self, underlying):
        return self.history.get(underlying)


@pytest.fixture
def store(monkeypatch):
    st = Store()
    monkeypatch.setattr(news.news_scores, "load", st.load)
    monkeypatch.setattr(news.news_scores, "save", st.save)
    monkeypatch.setattr(news.news_scores, "latest_digest", st.latest_digest)
    return st


class Model:
    """A fake OpenRouter: records what it was sent and answers with `articles` scored from the new_articles it was given."""

    def __init__(self, monkeypatch, keep=lambda url: True, bias="bullish"):
        self.calls, self.keep, self.bias, self.extra = [], keep, bias, []
        monkeypatch.setattr(news.requests, "post", self.post)

    def post(self, url, headers, json, timeout):  # noqa: A002 - mirrors requests.post
        user = json["messages"][1]["content"]
        self.calls.append(user)
        new = self._section(user, "new_articles")
        arts = [{"url": a["url"], "relevance_score": 70, "why": f"matters {a['url']}"} for a in new if self.keep(a["url"])] + self.extra

        class Resp:
            def raise_for_status(self):
                pass

            def json(_self):
                return {"choices": [{"message": {"content": {"bias": self.bias, "bias_reason": "reason", "digest": "digest text", "articles": arts}}, "finish_reason": "stop"}]}

        return Resp()

    @staticmethod
    def _section(user: str, name: str):
        marker = f"{name} (JSON):\n"
        if marker not in user:
            return []
        import json as _json

        return _json.JSONDecoder().raw_decode(user[user.index(marker) + len(marker):])[0]

    def sent_new(self, i=-1):
        return [a["url"] for a in self._section(self.calls[i], "new_articles")]

    def sent_known(self, i=-1):
        return [a["title"] for a in self._section(self.calls[i], "already_scored_relevant")]


def row(n, published=None):
    return {"url": f"http://n/{n}", "title": f"Headline {n}", "description": f"about {n}", "source": "s", "published_at": published or f"2026-10-0{n}T10:00:00+00:00"}


def analyse(rows, underlying="NIFTY"):
    return news._analyze_via_ai(underlying, rows, "key")


def test_first_run_sends_everything_and_remembers_each_verdict_including_the_dropped(monkeypatch, store):
    model = Model(monkeypatch, keep=lambda url: url != "http://n/2")
    digest = analyse([row(1), row(2), row(3)])
    assert model.sent_new() == ["http://n/1", "http://n/2", "http://n/3"]
    assert [a.url for a in digest.articles] == ["http://n/3", "http://n/1"]
    assert store.scores[("NIFTY", "http://n/1")]["relevant"] is True
    assert store.scores[("NIFTY", "http://n/2")] == {"relevant": False, "score": None, "why": None}  # dismissed, but remembered


def test_when_nothing_is_new_the_model_is_not_called_and_the_last_digest_is_reused(monkeypatch, store):
    model = Model(monkeypatch)
    first = analyse([row(1), row(2)])
    news._cache_set("NIFTY", first)
    again = analyse([row(1), row(2)])
    assert len(model.calls) == 1
    assert (again.bias, again.bias_reason, again.digest) == (first.bias, first.bias_reason, first.digest)
    assert sorted(a.url for a in again.articles) == ["http://n/1", "http://n/2"]
    assert {a.url: a.relevance_score for a in again.articles} == {a.url: a.relevance_score for a in first.articles}


def test_after_a_restart_the_logged_digest_is_reused_instead_of_analysing_everything_again(monkeypatch, store):
    model = Model(monkeypatch)
    analyse([row(1), row(2)])
    news._cache.clear()  # a restart: nothing in memory...
    store.history["NIFTY"] = {"bias": "bearish", "bias_reason": "logged reason", "digest": "logged digest"}  # ...but the log has it
    again = analyse([row(1), row(2)])
    assert len(model.calls) == 1
    assert (again.bias, again.digest) == ("bearish", "logged digest")


def test_one_new_article_sends_only_that_one_and_gives_the_old_relevant_ones_as_context(monkeypatch, store):
    model = Model(monkeypatch, keep=lambda url: url != "http://n/2")
    analyse([row(1), row(2)])
    digest = analyse([row(1), row(2), row(3)])
    assert model.sent_new() == ["http://n/3"]  # the two old articles are not re-sent for scoring
    assert model.sent_known() == ["Headline 1"]  # only the relevant old one, as context; the dismissed one is not sent at all
    assert sorted(a.url for a in digest.articles) == ["http://n/1", "http://n/3"]  # old + new, merged


def test_an_old_articles_score_does_not_drift_when_a_new_one_arrives(monkeypatch, store):
    model = Model(monkeypatch)
    analyse([row(1)])
    old_score = store.scores[("NIFTY", "http://n/1")]["score"]
    model.extra = [{"url": "http://n/1", "relevance_score": 5, "why": "re-scored!"}]  # a model that re-scores an old article anyway
    digest = analyse([row(1), row(2)])
    by = {a.url: a for a in digest.articles}
    assert by["http://n/1"].relevance_score == old_score and by["http://n/1"].why == "matters http://n/1"
    assert store.scores[("NIFTY", "http://n/1")]["score"] == old_score


def test_a_dismissed_article_is_never_shown_to_the_model_again(monkeypatch, store):
    model = Model(monkeypatch, keep=lambda url: url == "http://n/1")
    analyse([row(1), row(2)])
    analyse([row(1), row(2), row(3)])
    assert "http://n/2" not in model.sent_new() and "Headline 2" not in model.sent_known()


def test_instruments_do_not_share_verdicts(monkeypatch, store):
    model = Model(monkeypatch)
    analyse([row(1)], "NIFTY")
    analyse([row(1)], "GOLDM")  # the same headline, a different instrument: judged afresh
    assert len(model.calls) == 2 and model.sent_new() == ["http://n/1"]


def test_with_nothing_to_reuse_it_analyses_everything_rather_than_returning_nothing(monkeypatch, store):
    model = Model(monkeypatch)
    store.scores[("NIFTY", "http://n/1")] = {"relevant": True, "score": 60, "why": "w"}  # judged earlier, but no digest anywhere
    digest = analyse([row(1)])
    assert len(model.calls) == 1 and model.sent_new() == ["http://n/1"]
    assert digest.digest == "digest text"


def test_a_logged_placeholder_digest_is_not_reused_as_if_it_were_real(monkeypatch, store):
    model = Model(monkeypatch)
    analyse([row(1)])
    news._cache.clear()
    store.history["NIFTY"] = {"bias": "neutral", "bias_reason": "AI analysis temporarily unavailable - showing raw headlines.", "digest": "AI analysis temporarily unavailable - showing raw headlines."}
    digest = analyse([row(1)])
    assert len(model.calls) == 2 and digest.digest == "digest text"


def test_a_failed_call_remembers_nothing_so_the_articles_are_retried(monkeypatch, store):
    def boom(*a, **k):
        raise news.requests.ConnectionError("down")

    monkeypatch.setattr(news.requests, "post", boom)
    digest = analyse([row(1), row(2)])
    assert "temporarily unavailable" in digest.bias_reason and store.scores == {}
    model = Model(monkeypatch)
    analyse([row(1), row(2)])
    assert model.sent_new() == ["http://n/1", "http://n/2"]


def test_a_model_that_returns_an_url_it_was_not_given_is_ignored(monkeypatch, store):
    model = Model(monkeypatch)
    model.extra = [{"url": "http://made-up", "relevance_score": 99, "why": "x"}]
    digest = analyse([row(1)])
    assert [a.url for a in digest.articles] == ["http://n/1"] and ("NIFTY", "http://made-up") not in store.scores


def test_only_the_most_relevant_few_are_shown_newest_first(monkeypatch, store):
    Model(monkeypatch)
    rows = [row(i, published=f"2026-10-{i:02d}T10:00:00+00:00") for i in range(1, 13)]
    digest = analyse(rows[:12])
    assert len(digest.articles) == news._MAX_ARTICLES_IN_DIGEST
    assert [a.published_at for a in digest.articles] == sorted([a.published_at for a in digest.articles], reverse=True)


def test_the_prompt_asks_for_new_articles_only(monkeypatch, store):
    sent = {}

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": {"bias": "neutral", "bias_reason": "r", "digest": "d", "articles": []}}, "finish_reason": "stop"}]}

    monkeypatch.setattr(news.requests, "post", lambda url, headers, json, timeout: (sent.update(json), Resp())[1])
    analyse([row(1)])
    system = sent["messages"][0]["content"]
    assert "ONLY the articles under new_articles" in system and "already_scored_relevant" in system
    assert json.loads(sent["messages"][1]["content"].split("new_articles (JSON):\n")[1])[0]["url"] == "http://n/1"
