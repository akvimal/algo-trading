from app.providers.base import QuoteProvider
from app.providers.dhan import (
    MCX_FUTCOM,
    MCX_OPTFUT,
    NSE_EQ,
    NSE_FUTIDX,
    NSE_INDEX,
    NSE_OPTIDX,
    NSE_OPTSTK,
    DhanProvider,
)

# One DhanProvider instance per exchange, each holding every Dhan segment
# that exchange covers - see dhan.py's SegmentConfig docstring for why
# it's per-exchange, not per-segment. Distinct `name`s matter here:
# all_providers() below dedupes by name, so these must not collide.
_dhan_nse = DhanProvider([NSE_EQ, NSE_INDEX, NSE_FUTIDX, NSE_OPTIDX, NSE_OPTSTK], name="dhan-nse")
_dhan_mcx = DhanProvider([MCX_FUTCOM, MCX_OPTFUT], name="dhan-mcx")

_PROVIDERS: dict[str, QuoteProvider] = {
    "NSE": _dhan_nse,
    "MCX": _dhan_mcx,
    # "CRYPTO": ...,  Delta Exchange, not wired up yet
}


def get_provider(exchange: str) -> QuoteProvider:
    provider = _PROVIDERS.get(exchange)
    if provider is None:
        raise ValueError(f"no quote provider configured for exchange={exchange!r}")
    return provider


def all_providers() -> list[QuoteProvider]:
    seen: dict[str, QuoteProvider] = {}
    for provider in _PROVIDERS.values():
        seen[provider.name] = provider
    return list(seen.values())
