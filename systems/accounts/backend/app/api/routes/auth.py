from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.adapters.db import models
from app.adapters.db.session import get_db
from app.auth import get_current_user
from app.domain.models import LoginRequest, SignupRequest, TokenResponse, UserOut
from app.domain.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


def _normalize_email(email: str) -> str:
    return email.strip().lower()


@router.post("/signup", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def signup(payload: SignupRequest, db: Session = Depends(get_db)):
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
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    email = _normalize_email(payload.email)
    user = db.query(models.User).filter(models.User.email == email).first()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid email or password")
    return TokenResponse(access_token=create_access_token(str(user.id), user.email, user.is_admin))


@router.get("/me", response_model=UserOut)
def me(user: models.User = Depends(get_current_user)):
    return user
