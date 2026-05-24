#!/usr/bin/env bash
# feat-061 · L1 e2e chain checks against a running openneon-mcp server + real Neon fixture.
#
# Covers the real-Neon chain steps that unit tests (mocked) cannot:
#   - listing: /api/list-tools default core (4) + all (36) + supportsDepth + outputFormat advertise
#   - Stage B (T2): get_neondb_calling_services → application_name aggregation
#   - Stage C (T8): get_neondb_schemas → sale_date NOT indexed + no created_at + wildcard + depth=full 9 fields
#   - Stage D (T6): get_neondb_query_statement → parameterized $1/$2 (no raw date) + invalid → NotFoundError
#   - Stage A (T1): find_neondb_instances → EXPECTED deferred failure (feat-063 · management API not bypassed)
#
# Prereq: server running on $MCP_BASE_URL with NEON_LOCAL_URL set · fixture provisioned by setup.sh.
# Unit (vitest) + Playwright e2e are run separately by the workflow via npm scripts.
#
# Env:
#   MCP_BASE_URL   server base URL (default http://127.0.0.1:3344)
#
# Reports per-check PASS/FAIL · exits non-zero if any required check fails.
set -uo pipefail

MCP="${MCP_BASE_URL:-http://127.0.0.1:3344}"
QUERYID_FILE="$(dirname "$0")/.queryid"
QUERYID="$(cat "$QUERYID_FILE" 2>/dev/null || echo '')"

PASS=0
FAIL=0

# assert <name> <condition-cmd...> · runs the condition, prints PASS/FAIL, counts.
pass() { echo "  ✅ PASS · $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ FAIL · $1"; FAIL=$((FAIL + 1)); }

# json_get <url> · GET, returns body
get() { curl -sS --max-time 10 "$1"; }
# post <tool> <json-body> · POST to /api/local-call/<tool>
post() { curl -sS --max-time 15 -X POST "${MCP}/api/local-call/$1" -H 'Content-Type: application/json' -d "$2"; }
# pycheck <python-expr-on-stdin> · reads stdin JSON as `d`, prints 'OK' if expr truthy
pyck() { python3 -c "import json,sys; d=json.load(sys.stdin); print('OK' if ($1) else 'NO')" 2>/dev/null || echo 'ERR'; }
# inner <envelope-json> · extract the MCP text content (inner JSON string) → parsed
inner_py() { python3 -c "import json,sys; d=json.load(sys.stdin); t=d.get('content',[{}])[0].get('text'); print(t if t else json.dumps(d))" 2>/dev/null; }

echo "== feat-061 L1 e2e chain checks · ${MCP} =="

# ---- listing (feat-005/006/007 advertise) ----
echo "[listing] /api/list-tools default core + all + advertise"
BODY=$(get "${MCP}/api/list-tools")
[ "$(echo "$BODY" | pyck "len(d['tools'])==4 and d['categoryInclude']=='core'")" = "OK" ] \
  && pass "default core listing = 4 (T1/T2/T6/T8)" || fail "default core listing != 4"
BODY_ALL=$(get "${MCP}/api/list-tools?include=all")
[ "$(echo "$BODY_ALL" | pyck "len(d['tools'])==36")" = "OK" ] \
  && pass "include=all = 36 tools" || fail "include=all != 36"
[ "$(echo "$BODY_ALL" | pyck "[t for t in d['tools'] if t['name']=='get_neondb_query_statement'][0]['supportsDepth'] is True")" = "OK" ] \
  && pass "T6 supportsDepth advertised" || fail "T6 supportsDepth missing"
[ "$(echo "$BODY_ALL" | pyck "[t for t in d['tools'] if t['name']=='get_neondb_schemas'][0]['outputFormat']==['csv','json','tsv']")" = "OK" ] \
  && pass "T8 outputFormat advertised" || fail "T8 outputFormat missing"

# ---- Stage A · T1 (EXPECTED deferred failure · feat-063) ----
echo "[Stage A · T1] find_neondb_instances (expected deferred · feat-063)"
T1=$(post find_neondb_instances '{}')
[ "$(echo "$T1" | pyck "'error' in d and 'function' in d.get('error','')")" = "OK" ] \
  && pass "T1 returns expected management-API TypeError (deferred · feat-063)" \
  || fail "T1 unexpected response (feat-063 assumption changed?): $T1"

# ---- Stage B · T2 ----
echo "[Stage B · T2] get_neondb_calling_services"
T2=$(post get_neondb_calling_services '{"projectId":"local","format":"json"}' | inner_py)
[ "$(echo "$T2" | pyck "isinstance(d,list) and all('application_name' in r and r.get('endpoint_id')=='' for r in d)")" = "OK" ] \
  && pass "T2 application_name aggregation + endpoint_id empty (day-one)" || fail "T2 unexpected: $T2"
# feat-002 #5 · threshold filter: min_connections way above any real count → empty (HAVING)
T2H=$(post get_neondb_calling_services '{"projectId":"local","threshold":{"min_connections":9999},"format":"json"}' | inner_py)
[ "$(echo "$T2H" | pyck "isinstance(d,list) and len(d)==0")" = "OK" ] \
  && pass "T2 threshold min_connections=9999 → empty (HAVING filter)" || fail "T2 threshold unexpected: $T2H"
# feat-002 #5 · database 不存在 → empty (datname filter matches nothing · graceful · no throw)
T2DB=$(post get_neondb_calling_services '{"projectId":"local","databaseName":"nonexistent_db_xyz","format":"json"}' | inner_py)
[ "$(echo "$T2DB" | pyck "isinstance(d,list) and len(d)==0")" = "OK" ] \
  && pass "T2 database 不存在 → empty (graceful · agent recovers via db-name hint)" || fail "T2 db-not-exist unexpected: $T2DB"

# ---- Stage C · T8 ----
echo "[Stage C · T8] get_neondb_schemas (exact + wildcard + depth=full)"
T8=$(post get_neondb_schemas '{"filter":"sales","format":"json"}' | inner_py)
[ "$(echo "$T8" | pyck "any(r['column_name']=='sale_date' and r['is_indexed'] is False for r in d) and not any(r['column_name']=='created_at' for r in d)")" = "OK" ] \
  && pass "T8 sale_date NOT indexed + no created_at (anti-hallucination ground truth)" || fail "T8 unexpected: $T8"
T8W=$(post get_neondb_schemas '{"filter":"sales*","format":"json"}' | inner_py)
[ "$(echo "$T8W" | pyck "any(r['table_name']=='sales' for r in d)")" = "OK" ] \
  && pass "T8 wildcard sales* matches sales (feat-004 #2)" || fail "T8 wildcard unexpected: $T8W"
T8F=$(post get_neondb_schemas '{"filter":"sales","depth":"full","format":"json"}' | inner_py)
[ "$(echo "$T8F" | pyck "all('index_name' in r and 'default_value' in r for r in d) and any(r.get('index_name') for r in d)")" = "OK" ] \
  && pass "T8 depth=full 9-field index detail (feat-004 #4)" || fail "T8 depth=full unexpected: $T8F"

# ---- Stage D · T6 ----
echo "[Stage D · T6] get_neondb_query_statement (queryid ${QUERYID:-<none>})"
if [ -n "$QUERYID" ]; then
  T6=$(post get_neondb_query_statement "{\"query_signature\":\"${QUERYID}\",\"format\":\"json\"}" | inner_py)
  [ "$(echo "$T6" | pyck "isinstance(d,list) and '\$1' in d[0]['query'] and '2026-05' not in d[0]['query']")" = "OK" ] \
    && pass "T6 parameterized \$1/\$2 SQL · no raw date leak (OWASP LLM02)" || fail "T6 unexpected: $T6"
else
  fail "T6 skipped · no queryid (setup.sh ran?)"
fi
T6BAD=$(post get_neondb_query_statement '{"query_signature":"999999999999999999","format":"json"}')
[ "$(echo "$T6BAD" | pyck "d.get('name')=='NotFoundError'")" = "OK" ] \
  && pass "T6 invalid queryid → NotFoundError (no fabrication)" || fail "T6 invalid unexpected: $T6BAD"

# ---- Depth · feat-007 #5 progressive disclosure · 4 case ----
# shallow rows have NO index_name field (5 fields) · full rows DO (9 fields).
echo "[Depth · feat-007 #5 · 4 case] T8 default / shallow / full / invalid→fallback"
D1=$(post get_neondb_schemas '{"filter":"sales","format":"json"}' | inner_py)
[ "$(echo "$D1" | pyck "isinstance(d,list) and all('index_name' not in r for r in d)")" = "OK" ] \
  && pass "depth default (omitted) → shallow · 5 fields" || fail "depth default unexpected: $D1"
D2=$(post get_neondb_schemas '{"filter":"sales","depth":"shallow","format":"json"}' | inner_py)
[ "$(echo "$D2" | pyck "isinstance(d,list) and all('index_name' not in r for r in d)")" = "OK" ] \
  && pass "depth=shallow explicit → 5 fields" || fail "depth=shallow unexpected: $D2"
D3=$(post get_neondb_schemas '{"filter":"sales","depth":"full","format":"json"}' | inner_py)
[ "$(echo "$D3" | pyck "isinstance(d,list) and all('index_name' in r for r in d)")" = "OK" ] \
  && pass "depth=full explicit → 9 fields (index_name present)" || fail "depth=full unexpected: $D3"
# invalid depth via OAuth-free local-call (skips zod) → isValidDepth normalizes to shallow · NOT error
D4=$(post get_neondb_schemas '{"filter":"sales","depth":"deep","format":"json"}' | inner_py)
[ "$(echo "$D4" | pyck "isinstance(d,list) and all('index_name' not in r for r in d)")" = "OK" ] \
  && pass "depth=invalid ('deep') → fallback shallow (no error)" || fail "depth=invalid unexpected: $D4"

echo "== result: ${PASS} passed · ${FAIL} failed =="
[ "$FAIL" -eq 0 ]
