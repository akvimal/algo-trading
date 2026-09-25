"""The server-side gate on turning real-money order placement ON.

Before this existed, `PUT /accounts/{segment}` simply assigned
live_trading_enabled, and the only guard was a `window.confirm` in the
browser - so one API call (or a UI bug) could point real orders at a broker
account with no caps, no broker credentials and no recorded consent. This
module is the single place that decides whether an enable is allowed; the
three routes that can enable live (a user's own account, the admin platform
account, a dedicated strategy account) all call it.

It is deliberately a pure function over already-resolved facts (no DB, no
HTTP), so every rule is unit-testable. It returns the list of UNMET
requirements (empty = allowed) rather than raising, so a caller can show the
user everything that is missing at once instead of one error per attempt.

What it does NOT do yet (planned, see docs/redesign-rollout-plan.md Phase 1):
require a paper track record or a discipline score. Those need server-side
performance figures that do not exist yet.
"""

from typing import Optional

# NSE/MCX spot/future only - see app/domain/live_broker.py's own docstring.
# Options and CRYPTO (a different broker) have no real-order path at all.
LIVE_SEGMENTS = ("NSE", "MCX")

# Bump when the risk disclosure the UI shows changes materially, so a stored
# consent can later be told apart from one given against older wording.
CONSENT_VERSION = "2026-09-25"


def unmet_requirements(
    *,
    segment: str,
    max_order_value: Optional[float],
    max_daily_loss: Optional[float],
    kill_switch_on: bool,
    is_transition_to_live: bool,
    consent_given: bool,
    has_broker_credentials: Optional[bool],
    check_credentials: bool,
) -> list[str]:
    """`has_broker_credentials` is None when it could not be determined
    (accounts service unreachable) - treated as unmet, never as "fine"
    (fail closed). `check_credentials` is False for accounts that use no
    per-user broker credential of their own.

    Consent and credentials are only demanded on the transition from off to
    on; the caps are demanded whenever the account is live, so a caller
    cannot turn live on and then quietly blank the caps in a later edit."""
    problems: list[str] = []

    if segment not in LIVE_SEGMENTS:
        problems.append(f"live trading is only available for {' and '.join(LIVE_SEGMENTS)} (not {segment})")
        # Nothing else is worth asking for on a segment that can never go live.
        return problems

    if max_order_value is None or max_order_value <= 0:
        problems.append("set a max order value (a cap on any single real order)")
    if max_daily_loss is None or max_daily_loss <= 0:
        problems.append("set a max daily loss (real orders stop once losses reach it)")

    if is_transition_to_live:
        # The kill switch only blocks TURNING ON: an account that is already
        # live can still be edited (and switched off) while it is engaged.
        if kill_switch_on:
            problems.append("the platform-wide live-trading kill switch is on")
        if not consent_given:
            problems.append("acknowledge the live-trading risk disclosure (live_trading_consent=true)")
        if check_credentials:
            if has_broker_credentials is None:
                problems.append("could not verify your broker credentials (accounts service unreachable) - try again")
            elif not has_broker_credentials:
                problems.append("save your Dhan broker credentials first (Market Data > Data provider keys)")

    return problems


def format_problems(problems: list[str]) -> str:
    return "Live trading cannot be enabled: " + "; ".join(problems) + "."
