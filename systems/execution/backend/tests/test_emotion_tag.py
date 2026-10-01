"""Discipline v2 step 4: the feeling tag on a closed trade, set through the existing tags route."""

import uuid
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.domain import option_position_manager as opm
from app.domain import position_manager as pm
from app.domain.models import TradeTagsUpdate

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
PID = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")


class FakeDb:
    def __init__(self, r):
        self.r = r

    def get(self, model, key):
        return self.r

    def commit(self):
        pass


def row():
    return SimpleNamespace(id=PID, user_id=ALICE, setup_tag="Breakout", confidence=3, emotion_tag=None)


def test_only_the_four_feelings_are_accepted_and_empty_clears():
    for ok in ("calm", "fearful", "greedy", "fomo", ""):
        assert TradeTagsUpdate(emotion_tag=ok).emotion_tag == ok
    with pytest.raises(ValidationError):
        TradeTagsUpdate(emotion_tag="angry")


@pytest.mark.parametrize("setter", [pm.update_position_tags, opm.update_group_tags])
def test_setting_and_clearing_the_feeling_leaves_the_other_tags_alone(setter):
    r = row()
    setter(FakeDb(r), ALICE, PID, emotion_tag="fearful", set_emotion_tag=True)
    assert (r.emotion_tag, r.setup_tag, r.confidence) == ("fearful", "Breakout", 3)
    setter(FakeDb(r), ALICE, PID, emotion_tag="", set_emotion_tag=True)
    assert r.emotion_tag is None and r.setup_tag == "Breakout"


@pytest.mark.parametrize("setter", [pm.update_position_tags, opm.update_group_tags])
def test_a_request_without_the_feeling_does_not_touch_it(setter):
    r = row()
    r.emotion_tag = "calm"
    setter(FakeDb(r), ALICE, PID, setup_tag="Reversal", set_setup_tag=True)
    assert r.emotion_tag == "calm" and r.setup_tag == "Reversal"
