"""The risk acknowledgement a person confirms when creating an account.

The wording itself lives in the signup UI (systems/execution/frontend/src/
auth.ts, RISK_DISCLOSURE_TEXT); this is only the version stored next to the
timestamp. Bump it whenever that wording changes materially, so a stored
acknowledgement can later be told apart from one given against older text
(same idea as execution's live_gate.CONSENT_VERSION). The wording is a
plain-language placeholder pending the legal review listed in
docs/redesign-rollout-plan.md."""

RISK_ACK_VERSION = "2026-09-25"
