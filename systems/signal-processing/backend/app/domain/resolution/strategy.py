from typing import Optional

from app.domain.models import SignalIngest


def choose_strategy(signal: SignalIngest, horizon: str, instrument_type: str) -> Optional[dict]:
    """Pick an option strategy (spread, straddle, naked leg, ...) - NOT to
    be confused with signal-generation's Strategy entity (signal.strategy_id),
    which is a different concept (which signal source/config produced this
    signal). This function decides option *legs*, given horizon/instrument_type
    already resolved from that Strategy.

    Only relevant once instrument_type == "option" - see
    docs/architecture.md open questions. Not implemented yet; rule configs
    will live in ./rules/ once this is built out.
    """
    if instrument_type != "option":
        return None
    return None
