FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
# No --workers flag - deliberate, not an oversight. app/providers/dhan_feed.py
# holds the live-feed WebSocket connection to Dhan in module-level state (one
# connection for the whole process, not one per worker - Dhan's own account-
# wide connection budget is shared, see that module's docstring), and
# app/api/routes/quotes_ws.py's in-process _subscribers fan-out registry is
# equally single-process. Multiple workers would each open a DUPLICATE Dhan
# connection and silently drop ticks for any browser connected to a
# "different" worker than the one that received them. This same
# constraint blocks naive multi-replica scaling too, not just --workers -
# a second replica would open its own duplicate Dhan connection. If this
# service ever needs to scale beyond one process, split the feed
# connection into its own dedicated singleton ingester first (considered
# and deliberately deferred during the 2026-09-16 design - see
# docs/architecture.md); don't just add workers or replicas.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
