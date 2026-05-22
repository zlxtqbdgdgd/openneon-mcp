#!/usr/bin/env bash
# feat-061 · L1 sales-fixture provisioning (idempotent).
#
# Creates the known-good fixture state the L1 e2e checks assert against:
#   - sales table · sale_date NOT indexed (the slow-query root-cause signal) · product_id indexed
#   - users table · column is `email` (not `email_address`) · created_at
#   - pg_stat_statements extension + a registered slow query → deterministic queryid
#
# Idempotent: DROP IF EXISTS + CREATE every run (per detail design §11 OQ4).
#
# Env (all have defaults · CI runner / manual both work):
#   PSQL          psql binary           (default: psql · dev server: /home/z1/liqiang/src/neon/pg_install/v16/bin/psql)
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE  pg connection (defaults: 127.0.0.1 / 55432 / cloud_admin / cloud_admin / neondb)
#
# Exit non-zero on any failure (set -e + ON_ERROR_STOP).
set -euo pipefail

PSQL="${PSQL:-psql}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-cloud_admin}"
PGPASSWORD="${PGPASSWORD:-cloud_admin}"
PGDATABASE="${PGDATABASE:-neondb}"
export PGPASSWORD

psql_run() {
  "$PSQL" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 "$@"
}

echo "[setup] provisioning sales/users fixture on ${PGHOST}:${PGPORT}/${PGDATABASE}"
psql_run <<'SQL'
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS users;

-- sales · KEY: sale_date column (NOT created_at) · sale_date has NO index (slow-query signal)
CREATE TABLE sales (
  id integer PRIMARY KEY,
  product_id integer,
  sale_date timestamp,
  amount numeric
);
CREATE INDEX ON sales (product_id);
-- intentionally NO index on sale_date

-- users · KEY: column is `email` (NOT email_address)
CREATE TABLE users (
  id integer PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamp NOT NULL DEFAULT now()
);

INSERT INTO sales (id, product_id, sale_date, amount)
SELECT generate_series(1, 1000) AS id,
       (random() * 100)::integer AS product_id,
       now() - (random() * interval '30 days') AS sale_date,
       (random() * 1000)::numeric(10,2) AS amount;

INSERT INTO users (id, email)
SELECT generate_series(1, 100), 'user' || generate_series(1, 100) || '@example.com';
SQL

echo "[setup] registering pg_stat_statements + slow query → queryid"
psql_run <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT pg_stat_statements_reset();
SELECT AVG(amount) FROM sales WHERE sale_date BETWEEN '2026-05-01' AND '2026-05-20';
SQL

QUERYID=$(psql_run -t -A -c "SELECT queryid::text FROM pg_stat_statements WHERE query LIKE '%sale_date BETWEEN%' ORDER BY mean_exec_time DESC LIMIT 1;")
echo "[setup] captured queryid: ${QUERYID}"

# Persist queryid for run-checks.sh (same workspace · sibling file)
echo "${QUERYID}" > "$(dirname "$0")/.queryid"

# Sanity: sale_date must be present + the slow queryid must be non-empty
if [ -z "${QUERYID}" ]; then
  echo "[setup] FAIL: no queryid captured (pg_stat_statements not recording?)" >&2
  exit 1
fi
echo "[setup] OK · fixture ready (1000 sales · 100 users · queryid ${QUERYID})"
