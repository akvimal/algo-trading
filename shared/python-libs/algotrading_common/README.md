# algotrading_common (not yet used)

Placeholder for Python code genuinely shared across systems - e.g. the
Pydantic models generated from `docs/contracts/*.schema.json`, common
logging setup, a shared DB-session helper pattern.

Nothing lives here yet: `signal-processing/backend` currently hand-rolls
its own copies (see `app/domain/models.py`, which docstring-links back to
the contracts). Only extract into this package once a second system
(`execution`) actually needs the same code - don't build the abstraction
speculatively.
