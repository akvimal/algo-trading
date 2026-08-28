"""A Watchlist is a named, reusable, user-managed group of symbols -
referenced by name from a Rule's own `underlying` when
underlying_type='watchlist' (app/domain/rule.py), exactly how 'universe'
references a fixed NSE index key, except this group is created/edited by the
user via app/api/routes/watchlists.py rather than fixed to whatever
market-data's index API exposes. See infra/postgres/init/03-signal-generation.sql
for the full design rationale (immutable name, no FK from rules, etc.)."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, model_validator

from app.domain.generation.rule import parse_symbol_list


def validate_watchlist_symbols_field(symbols: Optional[str]) -> None:
    """At least one real symbol must parse out of `symbols` once comma-split
    - same "catch it at create/update time, not silently at scan time"
    reasoning as validate_rule_symbol_list_fields (app/domain/rule.py),
    which this mirrors exactly."""
    if not parse_symbol_list(symbols):
        raise ValueError("symbols requires at least one comma-separated symbol")


class WatchlistCreate(BaseModel):
    name: str = Field(min_length=1)
    # Comma-separated, same raw-string shape as RuleCreate.underlying for
    # underlying_type='symbol_list' - parsed with parse_symbol_list.
    symbols: str = Field(min_length=1)

    @model_validator(mode="after")
    def _check_symbols(self) -> "WatchlistCreate":
        validate_watchlist_symbols_field(self.symbols)
        return self


class WatchlistUpdate(BaseModel):
    """PUT /watchlists/{id} - symbols only. `name` is deliberately not
    editable here: a rename would silently orphan every Rule already
    referencing the old name (Rule.underlying stores the name directly, no
    FK) - see the table's own comment in
    infra/postgres/init/03-signal-generation.sql. Delete and recreate under
    a new name if the name itself needs to change."""

    symbols: str = Field(min_length=1)

    @model_validator(mode="after")
    def _check_symbols(self) -> "WatchlistUpdate":
        validate_watchlist_symbols_field(self.symbols)
        return self


class WatchlistOut(BaseModel):
    id: str
    name: str
    symbols: str
    # len(parse_symbol_list(symbols)) - computed by the route layer's
    # _to_out, not a stored column, purely for the management UI's table.
    symbol_count: int
    created_at: datetime
    updated_at: datetime
