class ResolutionError(Exception):
    """Raised when a signal can't be resolved - unknown/non-live strategy,
    or signal-generation unreachable. The caller persists the signal as a
    rejected resolved_order and does not publish to the Redis stream.

    `retryable`: True only for a transient/infrastructure failure (a
    market-data request itself failing - timeout, connection error, a
    5xx) where the SAME signal would plausibly succeed on a later
    attempt - as opposed to a structural rejection (unknown/non-live
    strategy, outside its active window, no valid option expiry today,
    contract_day_filter mismatch) that will keep failing identically no
    matter how many times it's retried. Persisted onto the resulting
    resolved_orders row (see resolve_and_finalize_signal) so a caller that
    posted the original signal - engine.py's in-house engine tick, the
    only caller that currently re-checks this - can tell "worth
    re-attempting" apart from "this bar is done, move on" without trying
    to re-parse the rendered reason string. Defaults False: every
    existing raise site is structural unless explicitly marked otherwise."""

    def __init__(self, reason: str, retryable: bool = False):
        self.reason = reason
        self.retryable = retryable
        super().__init__(reason)
