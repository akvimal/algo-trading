import pytest

from app.domain import premarket_report, rbi_reader

SPEECH_HTML = (
    "<html><body><div class='menu'>Home About Us Skip to main content</div>"
    '<div id="doublescroll"><table><tr><td>( 140 kb )</td></tr><tr><td><b> Date : Oct 03, 2026</b></td></tr>'
    "<tr><td><b>Preserving Financial Stability in an Evolving World</b></td></tr>"
    "<tr><td>Thank you for inviting me to speak today. 2. I would like to speak on financial stability.&nbsp;3. "
    + ("Banks remain well capitalised and asset quality is strong. " * 20)
    + "</td></tr></table></div><div class='footer'>Copyright</div></body></html>"
)


class _Resp:
    def __init__(self, text="", status=200, payload=None):
        self.text, self.status_code, self._p = text, status, payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise rbi_reader.requests.exceptions.HTTPError("bad")

    def json(self):
        return self._p


class _Db:
    """Just enough of a Session for attach_summaries: get / add / commit / rollback / close."""

    def __init__(self, rows=None):
        self.rows, self.added, self.commits, self.rollbacks, self.closed = dict(rows or {}), [], 0, 0, False

    def get(self, _model, key):
        return self.rows.get(key)

    def add(self, row):
        self.added.append(row)
        self.rows[row.url] = row

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


def _item(n, kind="speech"):
    return {"title": f"Item {n}", "url": f"http://rbi/{n}", "published": f"2026-10-0{n}T10:00:00+05:30", "kind": kind}


GOOD = {"summary": "Governor says banks are well capitalised.", "stance": "not about policy", "rates": ""}


@pytest.fixture
def db(monkeypatch):
    d = _Db()
    monkeypatch.setattr(rbi_reader, "SessionLocal", lambda: d)
    return d


# --- text extraction ---------------------------------------------------------------------------------------------------


def test_extract_text_keeps_the_speech_and_drops_page_chrome_and_the_pdf_size():
    text = rbi_reader.extract_text(SPEECH_HTML)
    assert text.startswith("Date : Oct 03, 2026 Preserving Financial Stability")
    assert "Thank you for inviting me to speak today." in text
    assert "Home About Us" not in text and "Copyright" not in text and "140 kb" not in text
    assert "&nbsp;" not in text and "  " not in text


def test_extract_text_is_empty_for_a_page_without_the_body_block():
    assert rbi_reader.extract_text("<html><body>nothing</body></html>") == ""


def test_fetch_text_returns_none_for_an_unreadable_or_too_short_page(monkeypatch):
    monkeypatch.setattr(rbi_reader.requests, "get", lambda *a, **k: _Resp(SPEECH_HTML))
    assert len(rbi_reader.fetch_text("u")) > 400
    monkeypatch.setattr(rbi_reader.requests, "get", lambda *a, **k: _Resp('<div id="doublescroll">Short notice.</div>'))
    assert rbi_reader.fetch_text("u") is None
    monkeypatch.setattr(rbi_reader.requests, "get", lambda *a, **k: _Resp("", status=500))
    assert rbi_reader.fetch_text("u") is None


def test_a_very_long_page_is_cut_to_the_cap(monkeypatch):
    big = '<div id="doublescroll">' + ("word " * 20000) + "</div>"
    monkeypatch.setattr(rbi_reader.requests, "get", lambda *a, **k: _Resp(big))
    assert len(rbi_reader.fetch_text("u")) == rbi_reader.MAX_TEXT_CHARS


# --- summarising ----------------------------------------------------------------------------------------------------------


def test_summarise_rejects_a_reply_without_a_valid_stance_or_summary(monkeypatch):
    def reply(content):
        return lambda url, **k: _Resp(payload={"choices": [{"message": {"content": content}, "finish_reason": "stop"}]})

    monkeypatch.setattr(rbi_reader.requests, "post", reply('{"summary": "x", "stance": "bullish", "rates": ""}'))
    with pytest.raises(ValueError):
        rbi_reader.summarise("t", "text", "k", "m")
    monkeypatch.setattr(rbi_reader.requests, "post", reply('{"summary": "  ", "stance": "neutral", "rates": ""}'))
    with pytest.raises(ValueError):
        rbi_reader.summarise("t", "text", "k", "m")
    monkeypatch.setattr(rbi_reader.requests, "post", reply('{"summary": "ok", "stance": "neutral", "rates": ""}'))
    assert rbi_reader.summarise("t", "text", "k", "m")["stance"] == "neutral"


# --- attaching to the report's items -----------------------------------------------------------------------------------


def test_a_new_item_is_fetched_summarised_stored_and_attached(monkeypatch, db):
    monkeypatch.setattr(rbi_reader, "fetch_text", lambda url: "full text " * 100)
    seen = []
    monkeypatch.setattr(rbi_reader, "summarise", lambda title, text, key, model: (seen.append((title, model)), {**GOOD, "rates": "Nothing on rates."})[1])
    items = rbi_reader.attach_summaries([_item(3)], "key")
    assert items[0]["summary"]["text"] == GOOD["summary"] and items[0]["summary"]["stance"] == "not about policy"
    assert items[0]["summary"]["rates"] == "Nothing on rates."
    assert db.commits == 1 and db.added[0].url == "http://rbi/3" and db.added[0].kind == "speech"
    assert seen == [("Item 3", premarket_report.ai_models.model_for("rbi_summary"))]


def test_an_item_read_before_is_reused_and_costs_no_call(monkeypatch, db):
    db.rows["http://rbi/3"] = type("Row", (), {"url": "http://rbi/3", "summary": "Stored.", "stance": "neutral", "rates": None, "model": "m"})()
    monkeypatch.setattr(rbi_reader, "fetch_text", lambda url: pytest.fail("must not refetch a stored item"))
    monkeypatch.setattr(rbi_reader, "summarise", lambda *a: pytest.fail("must not pay to read it again"))
    items = rbi_reader.attach_summaries([_item(3)], "key")
    assert items[0]["summary"] == {"text": "Stored.", "stance": "neutral", "rates": None, "model": "m"}


def test_without_a_key_stored_summaries_still_attach_but_nothing_new_is_read(monkeypatch, db):
    db.rows["http://rbi/1"] = type("Row", (), {"url": "http://rbi/1", "summary": "Stored.", "stance": "neutral", "rates": None, "model": "m"})()
    monkeypatch.setattr(rbi_reader, "fetch_text", lambda url: pytest.fail("no key, so no fetch"))
    items = rbi_reader.attach_summaries([_item(1), _item(2)], None)
    assert "summary" in items[0] and "summary" not in items[1]


def test_only_the_newest_items_are_read(monkeypatch, db):
    monkeypatch.setattr(rbi_reader, "fetch_text", lambda url: "t " * 300)
    monkeypatch.setattr(rbi_reader, "summarise", lambda *a: GOOD)
    items = rbi_reader.attach_summaries([_item(5), _item(4), _item(3), _item(2)], "key")
    assert ["summary" in i for i in items] == [True, True, True, False]
    assert rbi_reader.READ_NEWEST == 3


def test_odd_spaces_in_a_summary_are_normalised_before_it_is_stored(monkeypatch, db):
    monkeypatch.setattr(rbi_reader, "fetch_text", lambda url: "t " * 300)
    messy = {"summary": "Governor\u202fMalhotra\u00a0said  banks   are strong.", "stance": "neutral", "rates": " Repo\u202funchanged. "}
    monkeypatch.setattr(rbi_reader, "summarise", lambda *a: messy)
    s = rbi_reader.attach_summaries([_item(3)], "key")[0]["summary"]
    assert s["text"] == "Governor Malhotra said banks are strong." and s["rates"] == "Repo unchanged."


def test_a_page_that_cannot_be_read_or_a_model_failure_leaves_the_item_without_a_summary(monkeypatch, db):
    monkeypatch.setattr(rbi_reader, "fetch_text", lambda url: None if url.endswith("/5") else "t " * 300)

    def boom(*a):
        raise RuntimeError("OpenRouter returned 402")

    monkeypatch.setattr(rbi_reader, "summarise", boom)
    items = rbi_reader.attach_summaries([_item(5), _item(4)], "key")
    assert "summary" not in items[0] and "summary" not in items[1]
    assert db.rollbacks == 1 and db.closed  # the failed model call rolled back; the session is always closed


def test_an_item_without_a_url_is_skipped(monkeypatch, db):
    monkeypatch.setattr(rbi_reader, "fetch_text", lambda url: pytest.fail("no url, nothing to fetch"))
    assert "summary" not in rbi_reader.attach_summaries([{"title": "t", "url": None, "published": None, "kind": "speech"}], "key")[0]


# --- how the report uses it --------------------------------------------------------------------------------------------


def test_the_model_sees_the_summary_marked_as_an_ai_reading():
    rbi = {"kind": "speech", "published": "2026-10-03T05:30:00+00:00", "title": "T", "summary": {"text": "S.", "stance": "neutral", "rates": "R."}}
    assert premarket_report._rbi_for_model(rbi)["ai_summary_of_full_text"] == {"stance": "neutral", "summary": "S.", "says_about_rates": "R."}
    assert "ai_summary_of_full_text" not in premarket_report._rbi_for_model({"kind": "speech", "published": None, "title": "T"})


def _report_with_rbi(monkeypatch, seen):
    macro = {"indicators": [], "derived": {"real_rate": None, "spread_10y_repo": None, "india_10y": None}, "rbi": [_item(3)]}
    monkeypatch.setattr(premarket_report.provider, "fetch_inputs", lambda: [])
    monkeypatch.setattr(premarket_report, "fetch_macro", lambda y=None: macro)
    monkeypatch.setattr(premarket_report.rbi_reader, "attach_summaries", lambda items, key: (seen.update(key=key), items)[1])


def test_a_manual_refresh_only_reuses_stored_summaries_and_never_reads_new_items(monkeypatch):
    seen = {}
    _report_with_rbi(monkeypatch, seen)
    premarket_report.build_report("the-key")
    assert seen["key"] is None  # no key handed to the reader, so it cannot make a model call


def test_the_scheduled_run_may_read_new_items_with_the_platform_key(monkeypatch):
    seen = {}
    _report_with_rbi(monkeypatch, seen)
    premarket_report.build_report("the-key", read_new_rbi=True)
    assert seen["key"] == "the-key"


def test_the_scheduled_job_asks_for_new_items_to_be_read():
    import inspect

    from app import scheduler

    assert "read_new_rbi=True" in inspect.getsource(scheduler._record_premarket_report)


# --- keeping summaries short and plain ----------------------------------------------------------------------------------


def test_markdown_and_bullets_are_stripped_from_a_summary():
    messy = "Governor spoke on stability. Key points for a trader: - **Global backdrop:** Elevated debt. - **India:** Higher prices."
    out = rbi_reader._tidy(messy, 600)
    assert "**" not in out and " - " not in out
    assert out.startswith("Governor spoke on stability.") and "Global backdrop: Elevated debt." in out


def test_a_leading_bullet_on_its_own_line_is_removed():
    assert rbi_reader._tidy("- First point.\n- Second point.", 600) == "First point. Second point."


def test_an_overlong_summary_is_cut_at_a_sentence_end():
    text = "One sentence here. " * 60
    out = rbi_reader._tidy(text, 100)
    assert len(out) <= 100 and out.endswith(".") and out.count("One sentence here.") == out.count(".")


def test_with_no_sentence_end_to_cut_at_it_cuts_at_a_word_with_an_ellipsis():
    out = rbi_reader._tidy("word " * 100, 50)
    assert len(out) <= 51 and out.endswith("\u2026") and not out.endswith(" \u2026")


def test_a_short_clean_summary_is_unchanged():
    assert rbi_reader._tidy("Banks are well capitalised.", 600) == "Banks are well capitalised."


def test_a_stored_summary_is_capped_even_when_the_model_ignores_the_limit(monkeypatch, db):
    monkeypatch.setattr(rbi_reader, "fetch_text", lambda url: "t " * 300)
    chatty = {"summary": "**Bold.** " + "A long sentence about nothing. " * 80, "stance": "neutral", "rates": "Rates note. " * 60}
    monkeypatch.setattr(rbi_reader, "summarise", lambda *a: chatty)
    s = rbi_reader.attach_summaries([_item(3)], "key")[0]["summary"]
    assert len(s["text"]) <= rbi_reader.SUMMARY_MAX_CHARS and "**" not in s["text"]
    assert len(s["rates"]) <= rbi_reader.RATES_MAX_CHARS

