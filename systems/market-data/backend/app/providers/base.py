from abc import ABC, abstractmethod
from datetime import date
from typing import Optional

from app.domain.models import Candle, DataAvailability, ResolvedUnderlying


class QuoteProvider(ABC):
    name: str

    @abstractmethod
    def get_ltp(self, symbol: str) -> float:
        """Last traded price for a symbol on this provider's exchange(s)."""

    @abstractmethod
    def get_ltp_batch(self, symbols: list[str]) -> dict[str, float]:
        """Last traded price for multiple symbols in as few provider calls
        as possible. Symbols that fail to resolve/quote are simply
        omitted from the result rather than failing the whole batch."""

    @abstractmethod
    def get_previous_candle(self, symbol: str, interval: str) -> Optional[Candle]:
        """The most recently *completed* candle for a symbol at the given
        interval - not a historical range (see get_candle_history for
        that). Returns None if no completed candle is available yet
        (e.g. just after market open)."""

    @abstractmethod
    def get_candle_history(self, symbol: str, interval: str, from_date: date, to_date: date) -> list[Candle]:
        """Every *completed* candle for a symbol/interval within a
        caller-supplied date range - used to warm up indicator state
        (signal-generation's engine) and for backtesting. Not cached
        (unlike get_previous_candle's single-value TTL cache)."""

    @abstractmethod
    def get_data_availability(self, symbol: str, interval: str) -> DataAvailability:
        """What date range is actually usable for a backtest against this
        symbol/interval - see DataAvailability's own docstring for why
        Dhan and Delta report genuinely different things here."""

    @abstractmethod
    def resolve_underlying(self, underlying: str) -> Optional[ResolvedUnderlying]:
        """Given a logical underlying name (e.g. "GOLDM", "NIFTY"),
        resolve what to chart indicators on (chart_symbol/chart_exchange)
        and what to actually trade (trade_symbol/trade_exchange) - equal
        for instruments with no continuous spot (commodity futures),
        different for ones with both a spot and a tradeable derivative
        (indices: chart the spot, trade the active-month future). None
        if `underlying` isn't resolvable on this provider."""

    @abstractmethod
    def get_lot_size(self, symbol: str) -> Optional[float]:
        """Lot size for an already-resolved trading symbol (1 for
        instruments with no lot concept, e.g. NSE cash equity; a real
        fractional multiplier for Delta Exchange India CRYPTO perpetuals,
        e.g. BTCUSD=0.001 - see DeltaProvider.get_lot_size) - None if the
        symbol is unknown. Used by execution to size futures/CRYPTO
        positions in whole lots."""

    @abstractmethod
    def sync_instruments(self) -> dict:
        """Refresh this provider's symbol -> instrument-id lookup from its
        instrument master. Returns a small summary dict."""

    @abstractmethod
    def status(self) -> dict:
        """Current sync status - symbol_count, last_synced_at, ..."""
