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

**Triggers**: every `main` push + `pull_request` (+ manual `workflow_dispatch`). The `openneon-dev`
self-hosted runner is registered + verified (run 26280281756 green · 2026-05-22). If the runner
goes offline, runs queue until it's back (see runner ops below).

**⚠️ Security (public repo + self-hosted runner)**: the job has a same-repo guard
(`github.event.pull_request.head.repo.full_name == github.repository`) so **fork PRs never run on
the dev server runner**. Untrusted fork code would otherwise execute on the maintainer's machine
(GitHub explicitly warns against self-hosted runners on public repos). Workflow: only push(main),
maintainer's own-branch PRs, and manual dispatch reach the runner. Review an external fork PR, then
merge it — the post-merge push(main) runs the gate. Defense-in-depth: also keep GitHub Settings →
Actions → "Require approval for all outside collaborators".

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
