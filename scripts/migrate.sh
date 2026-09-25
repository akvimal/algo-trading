#!/usr/bin/env bash
set -euo pipefail

# Migration runner for infra/postgres/migrations/*.sql (no Alembic here, and
# init scripts only run on a fresh volume, so a populated database needs these
# applied by hand - this tracks which ones each database has had).
#
#   scripts/migrate.sh status              which migrations are applied / pending
#   scripts/migrate.sh detect              read-only: probe an (untracked) database for what
#                                          each migration creates, suggest a baseline number
#   scripts/migrate.sh apply               apply the pending ones, in order (asks first)
#   scripts/migrate.sh baseline <N|all>    RECORD migrations up to number N (e.g. 017) as
#                                          applied WITHOUT running them - for a database
#                                          that already has them, or a fresh install
#                                          (init/*.sql already contains the final schema)
#
# Which database: whatever `docker compose` targets by default (dev). Point it
# elsewhere with MIGRATE_COMPOSE, e.g. the test stack:
#   MIGRATE_COMPOSE="docker compose -p algo-trading-test --env-file .env.test" scripts/migrate.sh status
# or the VPS (run it ON the VPS, in the repo):
#   MIGRATE_COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml" scripts/migrate.sh status
#
# Safety rules, learned the hard way:
#  * A database with no tracking table is NEVER auto-applied: 001 is not
#    re-runnable (no IF NOT EXISTS, hardcoded seed-user UPDATEs), so `apply`
#    refuses until you `baseline` to the migration the database is really at.
#    Run `detect` first: it probes the schema and suggests the number.
#  * A file edited after it was applied is reported as MODIFIED, never re-run.
#  * A failing migration stops the run and is not recorded.

cd "$(dirname "$0")/.."
DIR=infra/postgres/migrations
COMPOSE=${MIGRATE_COMPOSE:-docker compose}
CMD=${1:-status}

# psql inside the postgres container, using the container's own credentials.
# </dev/null: `exec -T` would otherwise swallow the stdin of any `while read` loop calling this.
psql_q() { $COMPOSE exec -T postgres sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA "$@"' sh "$@" </dev/null; }
psql_stdin() { $COMPOSE exec -T postgres sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; }

sha() { sha256sum "$1" | cut -d' ' -f1; }
files() { ls "$DIR"/*.sql | sort; }
num_of() { basename "$1" | cut -d- -f1; }

TRACKING=$(psql_q -c "SELECT to_regclass('public.schema_migrations') IS NOT NULL")

ensure_table() {
  psql_stdin <<'SQL'
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename   TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    how        TEXT NOT NULL DEFAULT 'applied'   -- 'applied' (ran here) or 'baseline' (recorded only)
);
SQL
}

record() { # file how
  local f name
  f=$1; name=$(basename "$f")
  psql_q -c "INSERT INTO public.schema_migrations (filename, checksum, how) VALUES ('$name', '$(sha "$f")', '$2') ON CONFLICT (filename) DO NOTHING"
}

applied_checksum() { psql_q -c "SELECT checksum FROM public.schema_migrations WHERE filename = '$(basename "$1")'"; }

print_status() {
  local pending=0 f name state
  echo "database: $($COMPOSE exec -T postgres sh -c 'echo "$POSTGRES_DB@$(hostname)"')"
  if [ "$TRACKING" != "t" ]; then
    echo "NOT TRACKED: no schema_migrations table yet. Run 'baseline <N>' first (see header)."
    for f in $(files); do echo "  ?  $(basename "$f")"; done
    return
  fi
  for f in $(files); do
    name=$(basename "$f"); state=$(applied_checksum "$f")
    if [ -z "$state" ]; then echo "  PENDING   $name"; pending=$((pending+1))
    elif [ "$state" != "$(sha "$f")" ]; then echo "  MODIFIED  $name (edited after it was applied; not re-run)"
    else echo "  ok        $name"; fi
  done
  echo "$pending pending"
}

case "$CMD" in
  status) print_status ;;

  detect)
    # infra/postgres/migrations/markers.txt: one object per migration.
    highest=""; gap=0
    while IFS='|' read -r file tbl col; do
      case "$file" in ''|'#'*) continue ;; esac
      sch=${tbl%%.*}; t=${tbl#*.}
      if [ -n "$col" ]; then
        q="SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='$sch' AND table_name='$t' AND column_name='$col')"
        what="$tbl.$col"
      else
        q="SELECT to_regclass('$tbl') IS NOT NULL"; what="$tbl"
      fi
      if [ "$(psql_q -c "$q")" = "t" ]; then
        printf '  present  %-42s %s\n' "$file" "$what"
        [ $gap -eq 0 ] && highest=$(num_of "$file")
      else
        printf '  MISSING  %-42s %s\n' "$file" "$what"; gap=1
      fi
    done < "$DIR/markers.txt"
    echo
    if [ -z "$highest" ]; then echo "none of the marked migrations are present"
    elif [ $gap -eq 0 ]; then echo "everything present -> baseline $highest (or 'all'); nothing to apply"
    else echo "contiguous up to $highest; the MISSING ones must be applied. 'baseline $highest' then 'apply'."
         echo "(if a MISSING line sits BELOW a present one, the database skipped a migration - check before baselining)"; fi ;;

  baseline)
    UPTO=${2:-}
    [ -n "$UPTO" ] || { echo "usage: $0 baseline <N|all>   e.g. baseline 013" >&2; exit 2; }
    echo "This RECORDS migrations up to '$UPTO' as already applied, WITHOUT running them."
    echo "Only do this if that database really has them (compare against the schema)."
    read -r -p "Type 'yes' to record: " ans; [ "$ans" = "yes" ] || { echo aborted; exit 1; }
    ensure_table
    for f in $(files); do
      if [ "$UPTO" = "all" ] || [ "$(num_of "$f")" -le "$((10#$UPTO))" ]; then record "$f" baseline; echo "  recorded  $(basename "$f")"; fi
    done ;;

  apply)
    if [ "$TRACKING" != "t" ]; then
      echo "REFUSING: this database has no schema_migrations table, so I cannot tell what it already has." >&2
      echo "001 is not re-runnable. Work out which migration it is at, then: $0 baseline <N>" >&2
      exit 1
    fi
    todo=()
    for f in $(files); do [ -z "$(applied_checksum "$f")" ] && todo+=("$f"); done
    [ ${#todo[@]} -gt 0 ] || { echo "nothing pending"; exit 0; }
    echo "will apply, in order:"; for f in "${todo[@]}"; do echo "  $(basename "$f")"; done
    read -r -p "Type 'yes' to apply to this database: " ans; [ "$ans" = "yes" ] || { echo aborted; exit 1; }
    for f in "${todo[@]}"; do
      echo "applying $(basename "$f") ..."
      psql_stdin < "$f"
      record "$f" applied
    done
    echo done ;;

  *) echo "usage: $0 status | detect | apply | baseline <N|all>" >&2; exit 2 ;;
esac
