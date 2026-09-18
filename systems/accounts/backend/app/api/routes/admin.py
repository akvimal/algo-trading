"""Admin-only user management - added 2026-09-18 so execution's own
"Danger zone" reset-all action (POST /admin/users/{user_id}/reset-all
there) has something better than a raw UUID to target - see
docs/architecture.md for the cross-system reasoning. This is the only
service that actually owns user identity (systems/* stay self-contained,
no cross-schema FK), so it's the only place a user list can come from."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.adapters.db import models
from app.adapters.db.session import get_db
from app.auth import require_admin
from app.domain.models import UserOut

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/users", response_model=list[UserOut])
def list_users(admin: models.User = Depends(require_admin), db: Session = Depends(get_db)):
    """Every signed-up user (id/email/name/is_admin/created_at, never the
    password hash - see UserOut) - lets an admin pick a real user instead
    of typing a raw UUID blind when using execution's reset-all action.
    Oldest first (signup order), same as no ORDER BY would give on a
    small table but explicit rather than implied."""
    return db.query(models.User).order_by(models.User.created_at).all()
