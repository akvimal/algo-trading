#!/usr/bin/env bash
set -euo pipefail

# Retries ONLY the symbols missing from today's row in either EOD
# screener job (see app/scheduler.py's _record_oi_eod_snapshot /
# _record_equity_screener_snapshot in systems/market-data/backend) -
# useful after a run that hit Dhan 429s partway through (both jobs are
# idempotent per (symbol, snapshot_date), so this is always safe to
# re-run: it recomputes "what's still missing" fresh each time rather
# than replaying the whole ~210/~2000-symbol batch.
#
# Runs inside the already-running market-data-backend container (needs
# `docker compose up` to have that service up already) - loads whatever
# Dhan credential is currently persisted there (load_persisted_credentials),
# same one the scheduled job itself uses.
#
# Usage: retry-eod-snapshots.sh [oi|equity|both]   (default: both)
# "both" runs oi first, then equity - they share Dhan's rate-limit
# budget, so running them one after another (not concurrently) avoids
# needlessly contending for it.

cd "$(dirname "$0")/.."

TARGET="${1:-both}"
if [[ "$TARGET" != "oi" && "$TARGET" != "equity" && "$TARGET" != "both" ]]; then
  echo "Usage: $0 [oi|equity|both]" >&2
  exit 1
fi

retry_oi() {
  echo "--- Retrying missing OI Buildup symbols ---"
  docker compose exec -T market-data-backend python3 - <<'PYEOF'
from datetime import datetime
from zoneinfo import ZoneInfo
from unittest.mock import patch

from app.config import settings
from app.adapters.db.session import SessionLocal
from app.adapters.db.models import OiEodSnapshot
from app.providers.dhan import load_persisted_credentials
from app.providers.router import get_provider
import app.scheduler as sched

load_persisted_credentials()

today = datetime.now(ZoneInfo(settings.timezone)).date()
provider = get_provider("NSE")
all_symbols = set(provider.list_fno_stock_underlyings())

db = SessionLocal()
done = {r.symbol for r in db.query(OiEodSnapshot).filter(OiEodSnapshot.snapshot_date == today).all()}
db.close()

missing = sorted(all_symbols - done)
print(f"{len(missing)} of {len(all_symbols)} OI Buildup symbols still missing for {today}")
if missing:
    print(missing)
    with patch.object(provider, "list_fno_stock_underlyings", return_value=missing):
        sched._record_oi_eod_snapshot()
print("OI_RETRY_DONE")
PYEOF
}

retry_equity() {
  echo "--- Retrying missing Equity Screener symbols ---"
  docker compose exec -T market-data-backend python3 - <<'PYEOF'
from datetime import datetime
from zoneinfo import ZoneInfo
from unittest.mock import patch

from app.config import settings
from app.adapters.db.session import SessionLocal
from app.adapters.db.models import EquityScreenerSnapshot
from app.providers.dhan import load_persisted_credentials
from app.providers.router import get_provider
import app.scheduler as sched

load_persisted_credentials()

today = datetime.now(ZoneInfo(settings.timezone)).date()
provider = get_provider("NSE")
all_symbols = set(provider.list_nse_equities())

db = SessionLocal()
done = {r.symbol for r in db.query(EquityScreenerSnapshot).filter(EquityScreenerSnapshot.snapshot_date == today).all()}
db.close()

missing = sorted(all_symbols - done)
print(f"{len(missing)} of {len(all_symbols)} Equity Screener symbols still missing for {today}")
if missing:
    print(missing)
    with patch.object(provider, "list_nse_equities", return_value=missing):
        sched._record_equity_screener_snapshot()
print("EQUITY_RETRY_DONE")
PYEOF
}

case "$TARGET" in
  oi) retry_oi ;;
  equity) retry_equity ;;
  both) retry_oi; retry_equity ;;
esac
