# Pinned to Debian 12 (bookworm), not the floating python:3.12-slim tag
# (now Debian 13/trixie) - Playwright's `install --with-deps` ships an
# explicit apt package list per OS release, and trixie isn't one of the
# ones it recognizes yet (confirmed live: it falls back to ubuntu20.04's
# package names, which 404 on trixie - ttf-unifont/ttf-ubuntu-font-family
# were renamed/removed there). bookworm is one of Playwright 1.47's
# actually-supported targets.
FROM python:3.12-slim-bookworm

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Weekly Advisor fundamentals (app/domain/weekly_advisor/screener_fetch.py)
# needs a real headless browser to render screener.in's client-side ratios/
# results tables before screenshotting - --with-deps pulls in the OS libs
# Chromium needs (this is the one thing that meaningfully bloats this
# otherwise-lean image, ~400MB+ and a slower build).
RUN playwright install --with-deps chromium

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
