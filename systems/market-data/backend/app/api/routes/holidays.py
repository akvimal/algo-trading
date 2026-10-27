"""GET/PUT/DELETE /holidays - the exchange-holiday list an admin maintains from the web app.

The built-in list is app/data/india_calendar.json; rows saved here are laid over it (app/domain/market_calendar.py). Admin only:
it decides which days the nightly OI snapshot skips and what the Calendar tab shows."""

from datetime import date, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.adapters.db.models import MarketHoliday
from app.adapters.db.session import get_db
from app.auth import require_admin
from app.domain import market_calendar as mc

router = APIRouter()

# Warn this long before the list stops covering the calendar.
WARN_DAYS = 30


class HolidayIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    nse: Literal["closed", "special", "open"] = "closed"
    mcx: Literal["closed", "morning_closed", "special", "open"] = "closed"
    detail: Optional[str] = Field(default=None, max_length=300)


class HolidayOut(BaseModel):
    date: date
    name: str
    nse: str
    mcx: str
    detail: Optional[str] = None
    source: Literal["built_in", "admin"]


class HolidaysOut(BaseModel):
    holidays: list[HolidayOut]
    covered_through: date
    stale: bool  # the list has run out, or runs out within WARN_DAYS
    warning: Optional[str] = None


def _admin_dates(db: Session) -> set[date]:
    return {r.holiday_date for r in db.query(MarketHoliday.holiday_date)}


def build(db: Session, today: Optional[date] = None) -> HolidaysOut:
    today = today or date.today()
    admin = _admin_dates(db)
    covered = mc.coverage_through()
    stale = covered < today + timedelta(days=WARN_DAYS)
    warning = None
    if stale:
        warning = (
            f"The holiday list ran out on {covered:%d %b %Y}: add the next holidays here, or the nightly OI snapshot will record closed days."
            if covered < today
            else f"The holiday list runs out on {covered:%d %b %Y}: add the next year's holidays soon."
        )
    rows = [
        HolidayOut(date=date.fromisoformat(h["date"]), name=h["name"], nse=h["nse"], mcx=h["mcx"], detail=h.get("detail"),
                   source="admin" if date.fromisoformat(h["date"]) in admin else "built_in")
        for h in mc._holidays()
    ]
    return HolidaysOut(holidays=rows, covered_through=covered, stale=stale, warning=warning)


@router.get("/holidays", response_model=HolidaysOut)
def list_holidays(db: Session = Depends(get_db), _admin=Depends(require_admin)):
    mc.invalidate_holidays()
    return build(db)


@router.put("/holidays/{holiday_date}", response_model=HolidaysOut)
def save_holiday(holiday_date: date, body: HolidayIn, db: Session = Depends(get_db), _admin=Depends(require_admin)):
    """Adds a holiday, or replaces the built-in or earlier entry for that date. nse='open' removes a holiday the built-in list has."""
    row = db.get(MarketHoliday, holiday_date)
    if row is None:
        row = MarketHoliday(holiday_date=holiday_date)
        db.add(row)
    row.name, row.nse, row.mcx, row.detail = body.name.strip(), body.nse, body.mcx, body.detail
    db.commit()
    mc.invalidate_holidays()
    return build(db)


@router.delete("/holidays/{holiday_date}", response_model=HolidaysOut)
def delete_holiday(holiday_date: date, db: Session = Depends(get_db), _admin=Depends(require_admin)):
    """Removes an admin entry (a built-in holiday of the same date comes back). Built-in entries cannot be deleted, only overridden."""
    row = db.get(MarketHoliday, holiday_date)
    if row is None:
        raise HTTPException(status_code=404, detail="no admin-saved holiday on that date")
    db.delete(row)
    db.commit()
    mc.invalidate_holidays()
    return build(db)
