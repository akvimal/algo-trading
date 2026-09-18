"""One-off diagnostic for the 2026-09-18 VPS "live feed never connects"
investigation - not part of the app, never imported by it. Run inside the
market-data-backend container (needs app.config/app.providers.dhan on the
path, and the `websocket-client`/`redis` packages already in
requirements.txt):

    docker exec -i algo-trading-market-data-backend-1 python - < systems/market-data/backend/scripts/diagnose_dhan_feed.py

Checks, in order, each printed as PASS/FAIL/HANG so a single run pinpoints
exactly where this breaks: credentials visible to the running process,
raw TCP+TLS reachability to Dhan's feed host, then a real WebSocket
handshake against the actual feed URL with the actual current token -
the same connection dhan_feed.py's own background thread attempts, just
run synchronously here with a hard timeout so a silent hang (the
symptom observed - feed-status never showing an error, never showing
connected, forever) becomes a visible, bounded failure."""

import socket
import ssl
import sys
import threading
import time

sys.path.insert(0, "/app")

from app.config import settings  # noqa: E402
from app.providers.dhan import current_access_token, load_persisted_credentials  # noqa: E402

# This script runs as a brand-new process (docker exec spawns a fresh
# interpreter, sharing no memory with the real uvicorn process) - it never
# goes through app.main's startup event, so without this call it would see
# whatever's in the raw DHAN_CLIENT_ID/DHAN_ACCESS_TOKEN env vars only
# (blank on any deployment that relies on a UI-submitted/renewed token
# persisted to disk instead - see dhan.py's own comment on
# settings.dhan_access_token vs the _renewed_token slot). Mirrors exactly
# what app.main does at boot so this script sees the same credentials the
# real process does.
load_persisted_credentials()

FEED_HOST = "api-feed.dhan.co"
FEED_PORT = 443
TIMEOUT_SECONDS = 10


def check_credentials() -> str:
    client_id = settings.dhan_client_id
    token = current_access_token()
    if not client_id or not token:
        return f"FAIL - client_id={client_id!r} token_present={bool(token)}"
    return f"PASS - client_id={client_id!r} token_present=True token_len={len(token)}"


def check_tcp_tls() -> str:
    try:
        started = time.monotonic()
        ctx = ssl.create_default_context()
        with socket.create_connection((FEED_HOST, FEED_PORT), timeout=TIMEOUT_SECONDS) as raw:
            with ctx.wrap_socket(raw, server_hostname=FEED_HOST) as tls:
                elapsed = time.monotonic() - started
                return f"PASS - {tls.version()} in {elapsed:.2f}s"
    except Exception as exc:
        return f"FAIL - {exc!r}"


def check_websocket() -> str:
    try:
        import websocket
    except ImportError as exc:
        return f"FAIL - websocket-client not importable: {exc!r}"

    token = current_access_token()
    client_id = settings.dhan_client_id
    url = f"wss://{FEED_HOST}?version=2&token={token}&clientId={client_id}&authType=2"

    result: dict = {}
    done = threading.Event()

    def on_open(ws):
        result["outcome"] = "PASS - WebSocket opened"
        done.set()
        ws.close()

    def on_error(ws, error):
        result["outcome"] = f"FAIL - on_error: {error!r}"
        done.set()

    def on_close(ws, code, msg):
        result.setdefault("outcome", f"FAIL - closed before opening (code={code}, msg={msg!r})")
        done.set()

    app = websocket.WebSocketApp(url, on_open=on_open, on_error=on_error, on_close=on_close)
    thread = threading.Thread(target=app.run_forever, kwargs={"ping_interval": 0}, daemon=True)
    started = time.monotonic()
    thread.start()
    finished = done.wait(TIMEOUT_SECONDS)
    elapsed = time.monotonic() - started
    if not finished:
        return f"HANG - no on_open/on_error/on_close within {TIMEOUT_SECONDS}s (elapsed {elapsed:.1f}s) - this is the same silent hang dhan_feed.py's own background thread would experience"
    return f"{result.get('outcome', 'FAIL - unknown')} (in {elapsed:.2f}s)"


def main() -> None:
    print("1. Credentials visible to this process:")
    print("  ", check_credentials())
    print()
    print(f"2. Raw TCP+TLS to {FEED_HOST}:{FEED_PORT}:")
    print("  ", check_tcp_tls())
    print()
    print(f"3. Real WebSocket handshake to the live feed (timeout {TIMEOUT_SECONDS}s):")
    print("  ", check_websocket())


if __name__ == "__main__":
    main()
