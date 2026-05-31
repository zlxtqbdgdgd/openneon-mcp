// feat-068 #212 · mcp attach_neondb_dynamic_probe 端到端验收 fixture (7-case)
//
// 取代旧 bpftrace watchdog fixture (mcp#143·重设计后作废)。验 SQL 驱动 pg_uprobe 路径:
//   schema(probe_type/denylist floor/duration cap/target 前向兼容) + sql-driver runProbe(真 compute)。
//
// 跑法 (dev server · node20 + tsx · 从 landing/ 跑以解析 pg/node_modules):
//   source ~/neon-env.sh && source ~/node20-env.sh
//   cd landing && node_modules/.bin/tsx mcp-src/tools/handlers/dynamic-probe/__fixtures__/e2e-fixture.mjs
//
// 前置: compute shared_preload_libraries 带 pg_uprobe + CREATE EXTENSION (openneon#90)
//       neon_local 集群 running · compute 在 127.0.0.1:55432
//
// ⚠️ self-hosted CI runner 火热期停 (l1-e2e 永远 queued) · 本 fixture 是 ground-truth 验收门 · 手动跑。
import pg from 'pg';
import { runProbe } from '../sql-driver.ts';
import { validateAttachInput } from '../schema.ts';
import { loadDenylist } from '../denylist.ts';

let fail = 0;
const ok = (m) => console.log('  PASS:', m);
const bad = (m) => { console.log('  FAIL:', m); fail++; };
const base = { probe_type: 'TIME', target: 'pg', duration_seconds: 30, max_overhead_pct: 2.0, endpoint_id: 'ep-x' };
const dl = loadDenylist();

console.log('========== feat-068 #212 · mcp pg_uprobe 7-case e2e ==========');

console.log('[case 2] denylist floor 拦截 scram_sha256');
{ const r = validateAttachInput({ ...base, function: 'scram_sha256' }, dl);
  (!r.ok && /denylist/i.test(r.reason)) ? ok('scram_sha256 被 floor 拒') : bad(JSON.stringify(r)); }

console.log('[case 2b] SQL 注入字符 function → schema regex 拒');
{ const r = validateAttachInput({ ...base, function: "x'); DROP TABLE" }, dl);
  (!r.ok) ? ok('注入字符被 schema 拒') : bad('注入字符通过: ' + JSON.stringify(r)); }

console.log('[case 5] duration cap 超 300s → schema 拒');
{ const r = validateAttachInput({ ...base, function: 'ExecutorRun', duration_seconds: 301 }, dl);
  (!r.ok && /duration|300/.test(r.reason)) ? ok('duration 301 被拒') : bad(JSON.stringify(r)); }

console.log('[case 7] target=rust schema 解析不报崩 (feat-069 L4 前向兼容)');
{ const r = validateAttachInput({ ...base, function: 'pageserver_get_page', target: 'rust' }, dl);
  (r.ok || (!r.ok && !/crash|undefined|throw/i.test(r.reason))) ? ok('target=rust 解析正常') : bad(JSON.stringify(r)); }

console.log('[case 0] 正常 function 过 floor (不误伤)');
{ const r = validateAttachInput({ ...base, function: 'ExecutorRun' }, dl);
  (r.ok) ? ok('ExecutorRun 通过') : bad('误拒: ' + JSON.stringify(r)); }

const client = new pg.Client('postgresql://cloud_admin@127.0.0.1:55432/postgres');
await client.connect();
const probeClient = { query: (sql, params) => client.query(sql, params) };
try {
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_uprobe');
  console.log('[case 1] TIME 探针正路径 (runProbe 真 compute)');
  const t = await runProbe(probeClient, { function: 'ExecutorRun', probe_type: 'TIME', duration_seconds: 0,
    sleep: async () => { await client.query('SELECT count(*) FROM pg_class'); await client.query('SELECT count(*) FROM pg_proc'); } });
  (t.probe_type === 'TIME' && typeof t.calls === 'number' && t.calls >= 1) ? ok(`TIME e2e: calls=${t.calls} avg_time_ns=${t.avg_time_ns}`) : bad(JSON.stringify(t));
  console.log('[case 6] detach 后探针清空');
  const lst = await client.query('SELECT list_uprobes()');
  (!JSON.stringify(lst.rows).includes('ExecutorRun')) ? ok('detach 后无残留') : bad('残留: ' + JSON.stringify(lst.rows));
} catch (e) { bad('e2e 抛: ' + (e && e.message)); }
finally { await client.query('SELECT delete_uprobe($1,false)', ['ExecutorRun']).catch(()=>{}); await client.end(); }

console.log(fail === 0 ? '\nRESULT=PASS' : '\nRESULT=FAIL');
process.exit(fail === 0 ? 0 : 1);
