#!/usr/bin/env bash
# TEMP troubleshooting script - not part of the normal workflow, delete
# once the "Qty/lots not populated" VPS investigation is closed out.
#
# Checks, in order, why the Weekly Advisor decision form's Qty/lot-size
# suggestion might not be populating on a given environment (built for the
# VPS, where Caddy fronts every port with TLS - see infra/caddy/Caddyfile -
# so a bare `curl localhost:8000` from the host doesn't reach the backend
# directly; this runs everything from INSIDE the containers instead, same
# as the app itself does, no Caddy/TLS involved):
#   1. Does the recommendation's own legs carry a real security_id at all?
#   2. If so, does GET /weekly-advisor/lot-size resolve a lot size for it?
#   3. Did market-data's Dhan instrument-master sync actually succeed?
#   4. Any recent errors/exceptions in either backend's logs?
#
# Usage: bash scripts/debug-weekly-advisor-lots.sh [SYMBOL]
# Run from the compose project root (~/apps/algo-trading on the VPS).

set -euo pipefail
SYMBOL="${1:-RELIANCE}"

echo "=========================================="
echo "1. Recommendation legs + security_id for $SYMBOL"
echo "=========================================="
docker compose exec -T signal-engine-backend python3 -c "
import json, urllib.request
d = json.load(urllib.request.urlopen('http://localhost:8000/weekly-advisor/recommendations?symbols=$SYMBOL'))
if not d['recommendations']:
    print('NO RECOMMENDATION - pipeline could not build one for $SYMBOL at all')
else:
    legs = d['recommendations'][0]['strategy']['legs']
    if not legs:
        print('Recommendation has no legs (action:', d['recommendations'][0]['strategy']['action'], ')')
    for leg in legs:
        print(leg['option_type'], leg['strike'], leg['side'], '-> security_id:', leg.get('security_id'), '| premium_estimate:', leg.get('premium_estimate'))
" 2>&1

echo
echo "=========================================="
echo "2. GET /weekly-advisor/lot-size for the first real security_id found"
echo "=========================================="
docker compose exec -T signal-engine-backend python3 -c "
import json, urllib.request, urllib.error
d = json.load(urllib.request.urlopen('http://localhost:8000/weekly-advisor/recommendations?symbols=$SYMBOL'))
legs = d['recommendations'][0]['strategy']['legs'] if d['recommendations'] else []
sec_id = next((l.get('security_id') for l in legs if l.get('security_id')), None)
if not sec_id:
    print('No real security_id available to test with - see step 1 output above.')
else:
    print('Testing security_id:', sec_id)
    try:
        resp = urllib.request.urlopen(f'http://localhost:8000/weekly-advisor/lot-size?security_id={sec_id}')
        print('Status:', resp.status, '| Body:', resp.read().decode())
    except urllib.error.HTTPError as e:
        print('HTTP error:', e.code, '| Body:', e.read().decode())
    except Exception as e:
        print('Request failed entirely:', repr(e))
" 2>&1

echo
echo "=========================================="
echo "3. market-data Dhan instrument-master sync status"
echo "=========================================="
docker compose logs market-data-backend 2>&1 | grep -i "instrument master\|sync_instruments" | tail -10 || echo "(no matching log lines)"

echo
echo "=========================================="
echo "4. Recent errors in both backends' logs"
echo "=========================================="
echo "--- signal-engine-backend ---"
docker compose logs signal-engine-backend --tail=200 2>&1 | grep -i "lot-size\|error\|exception\|traceback" | tail -20 || echo "(none found)"
echo "--- market-data-backend ---"
docker compose logs market-data-backend --tail=200 2>&1 | grep -i "lot-size\|dhan\|error\|exception\|traceback" | tail -20 || echo "(none found)"

echo
echo "=========================================="
echo "5. Force a fresh NSE instrument-master sync and check for the"
echo "   security_id found in step 1 - tells us whether this is a"
echo "   broad sync failure or just one contract missing"
echo "=========================================="
docker compose exec -T signal-engine-backend python3 -c "
import json, urllib.request
d = json.load(urllib.request.urlopen('http://localhost:8000/weekly-advisor/recommendations?symbols=$SYMBOL'))
legs = d['recommendations'][0]['strategy']['legs'] if d['recommendations'] else []
sec_id = next((l.get('security_id') for l in legs if l.get('security_id')), None)
print(sec_id or '')
" > /tmp/_debug_sec_id.txt 2>&1
SEC_ID_FOUND="$(tail -n1 /tmp/_debug_sec_id.txt)"
rm -f /tmp/_debug_sec_id.txt
if [ -z "$SEC_ID_FOUND" ]; then
    echo "No security_id available from step 1 to check against a fresh sync."
else
    echo "Checking for security_id: $SEC_ID_FOUND"
    docker compose exec -T market-data-backend python3 -c "
from app.providers.router import _dhan_nse
_dhan_nse.sync_instruments()
print('symbols synced:', len(_dhan_nse._symbol_to_security_id))
print('has $SEC_ID_FOUND:', '$SEC_ID_FOUND' in _dhan_nse._security_id_to_symbol)
print('symbol for $SEC_ID_FOUND:', _dhan_nse._security_id_to_symbol.get('$SEC_ID_FOUND'))
" 2>&1
fi

echo
echo "Done - paste all of the above back to Claude."
