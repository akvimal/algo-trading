"""A per-article memory for the news digest: which articles the AI has already looked at for an instrument, and what it made of
each, so an article is judged ONCE.

Before this, the digest's only guard against repeat work was a fingerprint of the whole set of matched article urls, held in
memory: any change to the set (one new headline) re-sent every old article to the model, which re-scored them (costing tokens
and letting an old article's score drift), and a restart forgot the fingerprint and re-analysed everything once.

Now each (instrument, url) is stored with whether the model judged it relevant and, if so, its score and reason. The model is
asked to score only articles it has not seen (the already-scored relevant ones go along as compact context so the overall bias
still reflects them), and when no article is new it is not called at all - the last digest is reused.

Scores are per instrument because relevance depends on it (the same headline can matter for crude and not for Bitcoin).
Everything here is best effort: a database problem returns "nothing known", which just means the old behaviour (send everything).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.adapters.db.models import NewsArticleScore, NewsHistory
from app.adapters.db.session import SessionLocal

logger = logging.getLogger(__name__)

# Feeds only keep recent items, so a score older than this can never come up again; pruning keeps the table small.
RETENTION_DAYS = 14


def load(underlying: str, urls: list[str]) -> dict[str, dict]:
    """url -> {"relevant": bool, "score": int|None, "why": str|None} for the urls already judged."""
    if not urls:
        return {}
    db = SessionLocal()
    try:
        rows = db.query(NewsArticleScore).filter(NewsArticleScore.underlying == underlying, NewsArticleScore.url.in_(urls)).all()
        return {r.url: {"relevant": bool(r.relevant), "score": r.relevance_score, "why": r.why} for r in rows}
    except Exception:
        logger.warning("news_scores: could not read scores for %s", underlying, exc_info=True)
        return {}
    finally:
        db.close()


def save(underlying: str, judged: dict[str, Optional[dict]]) -> None:
    """Remember the model's verdict on each article: `judged[url]` is {"score", "why"} when it was found relevant, or None when
    the model dropped it as irrelevant (remembered too, so it is not shown to the model again). Also prunes old rows."""
    if not judged:
        return
    db = SessionLocal()
    try:
        for url, verdict in judged.items():
            db.merge(
                NewsArticleScore(
                    underlying=underlying,
                    url=url,
                    relevant=verdict is not None,
                    relevance_score=verdict["score"] if verdict else None,
                    why=verdict["why"] if verdict else None,
                    scored_at=datetime.now(timezone.utc),
                )
            )
        db.query(NewsArticleScore).filter(NewsArticleScore.scored_at < datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).delete(synchronize_session=False)
        db.commit()
    except Exception:
        logger.warning("news_scores: could not save scores for %s", underlying, exc_info=True)
        db.rollback()
    finally:
        db.close()


def latest_digest(underlying: str) -> Optional[dict]:
    """The bias / reason / digest text of the most recent digest logged for this instrument (survives a restart, unlike the
    in-memory cache), or None."""
    db = SessionLocal()
    try:
        row = db.query(NewsHistory).filter(NewsHistory.underlying == underlying).order_by(NewsHistory.recorded_at.desc()).first()
        return {"bias": row.bias, "bias_reason": row.bias_reason, "digest": row.digest} if row else None
    except Exception:
        logger.warning("news_scores: could not read the last digest for %s", underlying, exc_info=True)
        return None
    finally:
        db.close()
