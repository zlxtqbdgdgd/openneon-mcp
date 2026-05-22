# L1 sales-fixture e2e (feat-061)

GitHub Actions self-hosted CI for the L1 day-one ship gate. Runs the sales 4-step troubleshooting
chain + each L1 feature's §7 fixture against a **real Neon** (`neon_local`) cluster on the
maintainer dev server.

Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-061-L1-cross-skill-e2e-fixture-ci-matrix.html
Test stack rationale: ADR-0004 (3-layer · this is Layer 2 · 0 secret in GitHub).

## Scripts

| Script | Role |
|---|---|
| `setup.sh` | Idempotent fixture provisioning · sales (sale_date NOT indexed) + users (email) + pg_stat_statements + slow-query queryid → writes `.queryid` |
| `run-checks.sh` | Real-Neon chain checks against a running server · listing advertise + Stage B/C/D (T2/T8/T6) + Stage A (T1 expected-deferred per feat-063) |
| `teardown.sh` | Drops fixture tables · removes `.queryid` |

All scripts take env overrides (`PSQL` / `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` / `MCP_BASE_URL`) with dev-server defaults.

## Run manually (dev server · against the running server on :3344)

```sh
# server already up on :3344 with NEON_LOCAL_URL set
export PSQL=/home/z1/liqiang/src/neon/pg_install/v16/bin/psql
export MCP_BASE_URL=http://127.0.0.1:3344
bash scripts/l1-sales-fixture/setup.sh
bash scripts/l1-sales-fixture/run-checks.sh
bash scripts/l1-sales-fixture/teardown.sh   # optional
```

## CI workflow

`.github/workflows/l1-e2e-matrix.yml` · single job on `runs-on: [self-hosted, openneon-dev]`.

⚠️ **The workflow currently triggers on `workflow_dispatch` (manual) ONLY** — a self-hosted runner
labeled `openneon-dev` must be registered first. Until then, push/PR triggers would queue jobs
forever (no runner to pick them up).

### Register the self-hosted runner (one-time · maintainer · on dev server)

GitHub repo → Settings → Actions → Runners → New self-hosted runner (Linux x64). GitHub shows a
`./config.sh --url ... --token ...` command with a **runner registration token** (NOT a repo
secret · one-time · expires). On the dev server, as the `liqiang` user:

```sh
mkdir -p ~/actions-runner && cd ~/actions-runner
# download + extract the runner tarball GitHub shows, then:
./config.sh --url https://github.com/zlxtqbdgdgd/openneon-mcp \
  --token <RUNNER_TOKEN_FROM_GITHUB> \
  --labels openneon-dev \
  --name openneon-dev-runner --unattended
# run as a service (auto-restart · per detail design §11 R1):
sudo ./svc.sh install liqiang && sudo ./svc.sh start    # or: nohup ./run.sh &  (no-sudo)
```

Optionally set repo variable `NEON_PSQL_PATH` (Settings → Actions → Variables) to the dev-server
psql path `/home/z1/liqiang/src/neon/pg_install/v16/bin/psql` (the workflow reads `vars.NEON_PSQL_PATH`,
defaults to `psql` on PATH).

### Enable auto-trigger (after runner verified)

Manually dispatch the workflow once (Actions → "L1 e2e (real Neon · self-hosted)" → Run workflow)
to confirm it goes green. Then edit `.github/workflows/l1-e2e-matrix.yml` `on:` to uncomment
`push` (main) + `pull_request`.

## What it does NOT cover (deferred)

- **T1 `find_neondb_instances` dev-server e2e** — its Neon Cloud Management API path isn't bypassed
  by feat-062's local-call (empty `fakeNeonClient`). Tracked as **feat-063** (deferred · neon_local
  single-project makes T1 listing degenerate + T1 logic is unit-tested). `run-checks.sh` asserts T1
  returns the *expected* deferred TypeError rather than skipping silently.
