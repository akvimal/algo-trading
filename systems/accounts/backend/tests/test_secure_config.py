"""The production-config guard (app/secure_config.py): with
REQUIRE_SECURE_CONFIG=true the service must refuse to start on placeholder
or short secrets and on wildcard CORS; otherwise it only warns."""

import pytest

from app import secure_config
from app.config import settings

STRONG = "x" * 8 + "Qw3rTy-9zK2mB7vN"  # 24 chars, no placeholder marker
SECRET_ATTRS = ["jwt_secret", "credentials_encryption_key", "internal_service_secret"]


@pytest.fixture
def good(monkeypatch):
    """A fully secure configuration to mutate one thing at a time."""
    for attr in SECRET_ATTRS:
        monkeypatch.setattr(settings, attr, STRONG)
    monkeypatch.setattr(settings, "cors_allow_origins", "https://app.example.com:8090,https://app.example.com:8081")
    monkeypatch.setattr(settings, "require_secure_config", False)


def test_a_secure_config_has_no_problems(good):
    assert secure_config.insecure_settings() == []


@pytest.mark.parametrize("bad", ["", "   ", "change-me-in-production", "change-me-to-a-random-string", "short"])
def test_weak_secrets_are_flagged(good, monkeypatch, bad):
    for attr in SECRET_ATTRS:
        monkeypatch.setattr(settings, attr, bad)
        problems = secure_config.insecure_settings()
        assert len(problems) == 1, (attr, bad, problems)
        monkeypatch.setattr(settings, attr, STRONG)


def test_wildcard_cors_is_flagged(good, monkeypatch):
    monkeypatch.setattr(settings, "cors_allow_origins", "*")
    assert any("CORS_ALLOW_ORIGINS" in p for p in secure_config.insecure_settings())
    monkeypatch.setattr(settings, "cors_allow_origins", "https://a.example.com, *")
    assert any("CORS_ALLOW_ORIGINS" in p for p in secure_config.insecure_settings())


def test_cors_origins_are_parsed_and_trimmed(good, monkeypatch):
    monkeypatch.setattr(settings, "cors_allow_origins", " https://a.example.com , ,https://b.example.com ")
    assert secure_config.cors_origins() == ["https://a.example.com", "https://b.example.com"]


def test_enforcement_refuses_to_start_when_required(good, monkeypatch):
    monkeypatch.setattr(settings, "require_secure_config", True)
    monkeypatch.setattr(settings, SECRET_ATTRS[0], "change-me-in-production")
    with pytest.raises(RuntimeError) as exc:
        secure_config.enforce_secure_config()
    assert "refusing to start" in str(exc.value)


def test_enforcement_refuses_wildcard_cors_when_required(good, monkeypatch):
    monkeypatch.setattr(settings, "require_secure_config", True)
    monkeypatch.setattr(settings, "cors_allow_origins", "*")
    with pytest.raises(RuntimeError):
        secure_config.enforce_secure_config()


def test_enforcement_only_warns_when_not_required(good, monkeypatch, caplog):
    monkeypatch.setattr(settings, "require_secure_config", False)
    monkeypatch.setattr(settings, "cors_allow_origins", "*")
    monkeypatch.setattr(settings, SECRET_ATTRS[0], "change-me-in-production")
    with caplog.at_level("WARNING"):
        secure_config.enforce_secure_config()  # must not raise
    assert "insecure configuration" in caplog.text


def test_a_secure_config_starts_fine_even_when_required(good, monkeypatch):
    monkeypatch.setattr(settings, "require_secure_config", True)
    secure_config.enforce_secure_config()
