from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.adapters.db import models
from app.adapters.db.session import get_db
from app.auth import get_current_user
from app.rate_limit import check_and_record_signup, check_login_allowed, client_ip, record_login_failure, record_login_success
from app.domain.models import LoginRequest, SignupRequest, TokenResponse, UserOut
from app.domain.risk_ack import RISK_ACK_VERSION
from app.domain.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


def _normalize_email(email: str) -> str:
    return email.strip().lower()


@router.post("/signup", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def signup(payload: SignupRequest, request: Request, db: Session = Depends(get_db)):
    # Before the rate limiter, so a forgotten checkbox does not use up an
    # honest person's signup attempts.
    if not payload.accept_risk_disclosure:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="you must confirm the risk disclosure to create an account",
        )
    check_and_record_signup(client_ip(request))
    email = _normalize_email(payload.email)
    # Bootstraps the platform's first admin - the very first account ever
    # created (across the whole table, not per-request) gets is_admin=True
    # so there's always at least one admin login without a manual SQL
    # UPDATE ... SET is_admin=true right after standing up a fresh stack.
    # Every signup after that stays a regular (non-admin) account, same as
    # before this existed. A theoretical concurrent-first-signup race
    # (two requests both seeing count()==0) isn't guarded against - this
    # is a one-time bootstrap step on a fresh, single-operator stack, not
    # an ongoing security boundary.
    is_first_user = db.query(models.User).count() == 0
    user = models.User(
        email=email,
        name=payload.name.strip(),
        password_hash=hash_password(payload.password),
        is_admin=is_first_user,
        risk_acknowledged_at=datetime.now(timezone.utc),
        risk_acknowledged_version=RISK_ACK_VERSION,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="an account with this email already exists")
    db.refresh(user)
    return TokenResponse(access_token=create_access_token(str(user.id), user.email, user.is_admin))


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    email = _normalize_email(payload.email)
    ip = client_ip(request)
    # Refuse before touching the password check once an email or IP has too
    # many recent failures (app/rate_limit.py).
    check_login_allowed(email, ip)
    user = db.query(models.User).filter(models.User.email == email).first()
    if user is None or not verify_password(payload.password, user.password_hash):
        record_login_failure(email, ip)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid email or password")
    record_login_success(email)
    return TokenResponse(access_token=create_access_token(str(user.id), user.email, user.is_admin))


@router.get("/me", response_model=UserOut)
def me(user: models.User = Depends(get_current_user)):
    return user
