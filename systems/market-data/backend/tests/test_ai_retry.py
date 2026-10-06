import json

import pytest
import requests

from app.domain.ai_retry import CEILING_TOKENS, post_json


def _parse(text):
    return json.loads(text)


class _Resp:
    def __init__(self, content, finish="stop", status=200):
        self._c, self._f, self._s = content, finish, status

    def raise_for_status(self):
        if self._s >= 400:
            err = requests.exceptions.HTTPError("boom")
            err.response = type("R", (), {"status_code": self._s})()
            raise err

    def json(self):
        return {"choices": [{"message": {"content": self._c}, "finish_reason": self._f}]}


def _poster(*responses):
    sent = []
    queue = list(responses)

    def post(url, headers, json, timeout):
        sent.append(json["max_tokens"])
        return queue.pop(0)

    return post, sent


BODY = {"model": "m", "max_tokens": 1200}


def test_a_complete_reply_is_one_call_at_the_base_cap():
    post, sent = _poster(_Resp('{"a": 1}'))
    assert post_json(post, "u", {}, dict(BODY), 5, _parse) == {"a": 1}
    assert sent == [1200]


def test_a_reply_cut_off_mid_json_is_retried_once_with_more_room():
    post, sent = _poster(_Resp('{"a": "unterminat', finish="length"), _Resp('{"a": 1}'))
    assert post_json(post, "u", {}, dict(BODY), 5, _parse) == {"a": 1}
    assert sent == [1200, 4800]


def test_truncation_without_a_length_finish_reason_is_also_retried():
    post, sent = _poster(_Resp('{"a": "unterminat'), _Resp('{"a": 1}'))
    assert post_json(post, "u", {}, dict(BODY), 5, _parse) == {"a": 1}
    assert sent == [1200, 4800]


def test_a_second_failure_raises_the_real_parse_error_and_does_not_loop():
    post, sent = _poster(_Resp("{bad", finish="length"), _Resp("{still bad", finish="length"))
    with pytest.raises(ValueError):
        post_json(post, "u", {}, dict(BODY), 5, _parse)
    assert len(sent) == 2


def test_the_retry_cap_never_exceeds_the_ceiling():
    post, sent = _poster(_Resp("{bad", finish="length"), _Resp('{"a": 1}'))
    post_json(post, "u", {}, {"model": "m", "max_tokens": 5000}, 5, _parse)
    assert sent == [5000, CEILING_TOKENS]


def test_no_retry_when_already_at_the_ceiling():
    post, sent = _poster(_Resp("{bad", finish="length"))
    with pytest.raises(ValueError):
        post_json(post, "u", {}, {"model": "m", "max_tokens": CEILING_TOKENS}, 5, _parse)
    assert sent == [CEILING_TOKENS]


def test_http_errors_propagate_untouched_for_the_caller_to_explain():
    post, sent = _poster(_Resp("", status=402))
    with pytest.raises(requests.exceptions.HTTPError):
        post_json(post, "u", {}, dict(BODY), 5, _parse)
    assert sent == [1200]


def test_the_original_body_is_not_mutated():
    body = dict(BODY)
    post, _ = _poster(_Resp("{bad", finish="length"), _Resp('{"a": 1}'))
    post_json(post, "u", {}, body, 5, _parse)
    assert body["max_tokens"] == 1200
