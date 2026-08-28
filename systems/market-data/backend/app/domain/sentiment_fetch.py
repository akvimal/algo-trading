"""Fetches option-chain data for one SENTIMENT_UNDERLYINGS symbol and
scores it via app/domain/sentiment.py's pure functions - the network/
provider-facing half that module's own docstring says stays out of it.
Shared by GET /options/sentiment (app/api/routes/options.py) and the
scheduled sentiment-history recorder (app/scheduler.py) so there's exactly
one place that knows how to turn a symbol into an UnderlyingSentiment plus
its spot price, not two copies that could drift.
"""

from typing import Optional

from app.domain.models import UnderlyingSentiment
from app.domain.oi_summary import build_oi_summary
from app.domain.sentiment import score_underlying
from app.providers.dhan import DhanCredentials
from app.providers.router import get_provider


def fetch_underlying_sentiment(
    exchange: str, symbol: str, credentials: Optional[DhanCredentials] = None
) -> tuple[UnderlyingSentiment, Optional[float]]:
    """Returns the scored sentiment plus the underlying's spot price at
    this snapshot (OptionChain.underlying_last_price - None if the fetch
    never got as far as a chain). credentials is whatever
    get_user_dhan_credentials(user_id) returned (None = platform default,
    always the case for the scheduled recorder, which has no caller to
    attribute a BYO credential to)."""
    provider = get_provider(exchange)
    resolver = getattr(provider, "resolve_underlying", None)
    expiry_lister = getattr(provider, "get_expiry_list", None)
    chain_fetcher = getattr(provider, "get_option_chain", None)
    changer = getattr(provider, "get_oi_changes", None)
    if resolver is None or expiry_lister is None or chain_fetcher is None or changer is None:
        return score_underlying(symbol, None, f"exchange '{exchange}' has no option-chain support"), None

    summary = None
    spot_price = None
    error = None
    try:
        # An MCX commodity's option chain is keyed by its active-month
        # FUTURES CONTRACT symbol, not the bare commodity name (e.g.
        # "GOLDM-04Sep2026-FUT", not "GOLDM") - same resolve-then-query
        # flow OiSummaryPage.tsx uses (resolveUnderlying -> chart_symbol).
        # A no-op for NSE indices, whose chart_symbol equals the bare name.
        resolved = resolver(symbol)
        if resolved is None:
            error = f"'{symbol}' did not resolve"
        else:
            chart_symbol = resolved.chart_symbol
            expiries = expiry_lister(chart_symbol, credentials=credentials)
            if not expiries:
                error = f"no expiries for '{chart_symbol}'"
            else:
                expiry = sorted(expiries)[0]  # nearest - same convention as execution's open_manual_option_group
                chain = chain_fetcher(chart_symbol, expiry, credentials=credentials)
                if chain is None:
                    error = f"'{chart_symbol}' did not resolve"
                else:
                    spot_price = chain.underlying_last_price
                    summary = build_oi_summary(
                        chain,
                        lambda strike, option_type, oi, s=chart_symbol, e=expiry: changer(s, e, strike, option_type, oi),
                    )
    except RuntimeError as exc:
        error = str(exc)
    return score_underlying(symbol, summary, error), spot_price
