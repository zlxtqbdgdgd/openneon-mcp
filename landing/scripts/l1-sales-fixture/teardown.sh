#!/usr/bin/env bash
# feat-061 · L1 sales-fixture teardown · drops the fixture tables.
#
# Leaves pg_stat_statements extension + shared_preload_libraries alone (cheap to keep ·
# reused next run · per narrative-3 manual bridge doc Step 5 note).
#
# Env: same as setup.sh (PSQL / PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE).
set -euo pipefail

PSQL="${PSQL:-psql}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-cloud_admin}"
PGPASSWORD="${PGPASSWORD:-cloud_admin}"
PGDATABASE="${PGDATABASE:-neondb}"
export PGPASSWORD

echo "[teardown] dropping sales/users fixture on ${PGHOST}:${PGPORT}/${PGDATABASE}"
"$PSQL" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 \
  -c "DROP TABLE IF EXISTS sales; DROP TABLE IF EXISTS users;"

rm -f "$(dirname "$0")/.queryid"
echo "[teardown] OK"
