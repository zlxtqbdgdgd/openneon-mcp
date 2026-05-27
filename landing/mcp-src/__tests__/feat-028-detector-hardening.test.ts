/**
 * feat-028 fixture · PG parser AST 分类的 30 用例 (4 类绕过 + 2 长锁 + 11 类 regression)
 *
 * 详设 §7 测试 · §7.1 (用例 1-10 · 4 类绕过) / §7.2 (用例 11-14 · 长锁 #109) / §7.3 (用例 15-30 · regression)。
 *
 * Note · 用例 8 (嵌套块注释) audit (#107) 实测 libpg-query 能解析 · 跟 design 表里 expected
 * 'OTHER' fail-closed 不符 · expected 改 'DROP_TABLE_OR_INDEX' (PG 实际支持嵌套块注释)。
 * Note · 用例 4 (Unicode escape `DROP`) PG 拒 (bare identifier 不解析 escape) → OTHER fail-closed。
 */
import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import {
  classifyOp,
  classifySql,
  isDestructiveSql,
  initPgParser,
  getParserBackend,
  _resetClassifyCacheForTests,
  getClassifyCacheStats,
  setClassifyOpAuditEmitter,
  type ClassifyOpAuditEvent,
  type OpClass,
} from '../protection/destructive-detector';

// ───────── shared init: PG parser WASM loadModule (一次) ─────────
beforeAll(async () => {
  delete process.env.PARSER_BACKEND; // 默认 pg-parser
  await initPgParser();
});

beforeEach(() => {
  _resetClassifyCacheForTests();
});

// ───────── §7.1 · 4 类绕过攻击向量 (10 用例) ─────────
describe('feat-028 §7.1 · 4 类绕过攻击向量', () => {
  const cases: Array<[string, string, OpClass]> = [
    ['1. 行注释 + DROP', 'DROP --evil\nTABLE x', 'DROP_TABLE_OR_INDEX'],
    ['2. 块注释中间', 'DROP /* xxx */ TABLE x', 'DROP_TABLE_OR_INDEX'],
    ['3. 块注释 disguise', '/* SELECT */ DROP TABLE x', 'DROP_TABLE_OR_INDEX'],
    // 4. Unicode escape → PG parser 拒 → OTHER (audit #107 实测确认)
    ['4. Unicode escape', 'DR\\u004fP TABLE x', 'OTHER'],
    ['5. 大小写混合', 'DrOp TaBlE x', 'DROP_TABLE_OR_INDEX'],
    ['6. 多语句 SELECT+DROP (mostDangerous)', 'SELECT 1; DROP TABLE x', 'DROP_TABLE_OR_INDEX'],
    ['7. 多语句 DROP+SELECT', 'DROP TABLE x; SELECT 1', 'DROP_TABLE_OR_INDEX'],
    // 8. 嵌套块注释 → PG 实际支持嵌套块注释 (audit #107 实测) → DROP_TABLE_OR_INDEX (设计 §7.1
    //    用例 8 表里 expected 'OTHER' 描述 outdated · #108 实施时勘正)
    ['8. 嵌套块注释 (PG 实际支持)', 'DROP /* /* x */ */ TABLE x', 'DROP_TABLE_OR_INDEX'],
    [
      '9. CTE 内 DELETE (top-level 写 · WRITE_DML)',
      'WITH t AS (DELETE FROM x RETURNING *) SELECT * FROM t',
      'DELETE_UPDATE_BULK',
    ],
    ['10. EXECUTE prepared', 'EXECUTE drop_table_stmt', 'OTHER'],
  ];
  for (const [name, sql, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyOp('run_sql', sql)).toBe(expected);
    });
  }
});

// ───────── §7.2 · 2 长锁 op-class (4 用例 · #109) ─────────
describe('feat-028 §7.2 · 长锁 (VACUUM FULL / CLUSTER · #109)', () => {
  const cases: Array<[string, string, OpClass]> = [
    ['11. VACUUM FULL', 'VACUUM FULL sales', 'VACUUM_FULL_LOCK'],
    ['12. VACUUM 不带 FULL (普通 vacuum 不长锁)', 'VACUUM sales', 'OTHER'],
    ['13. CLUSTER USING', 'CLUSTER sales USING idx_x', 'CLUSTER_LOCK'],
    ['14. CLUSTER 无 USING (refresh existing)', 'CLUSTER sales', 'CLUSTER_LOCK'],
  ];
  for (const [name, sql, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyOp('run_sql', sql)).toBe(expected);
    });
  }
});

// ───────── §7.3 · 11 类 OpClass regression (16 用例) ─────────
describe('feat-028 §7.3 · OpClass regression (feat-056 day-one 不退化)', () => {
  // 注: design §7.3 用 'WRITE_DML' / 'CREATE_OBJECT' / 'ALTER_TABLE_SMALL_LOCK' / 'GRANT'
  // 等名称 · 实际代码沿 feat-056 命名 (DELETE_UPDATE_BULK / DDL_ADD_COLUMN / ALTER_TABLE_BIG_LOCK)。
  // GRANT 当前归 OTHER (不在 day-one 11 类内 · 后续 issue 细分)。
  const cases: Array<[string, string, OpClass]> = [
    ['15. SELECT', 'SELECT * FROM x', 'READ_ONLY'],
    [
      '16. CREATE INDEX CONCURRENTLY',
      'CREATE INDEX CONCURRENTLY idx ON t (a)',
      'CREATE_INDEX_CONCURRENTLY',
    ],
    [
      '17. ALTER TABLE big lock',
      'ALTER TABLE x ADD COLUMN y INT NOT NULL',
      'ALTER_TABLE_BIG_LOCK',
    ],
    // 18. day-one 不细分 small lock · 仍归 BIG_LOCK (保守 · 不退化)
    ['18. ALTER TABLE small lock (day-one 不细分)', 'ALTER TABLE x ADD COLUMN y INT', 'ALTER_TABLE_BIG_LOCK'],
    ['19. CREATE TABLE', 'CREATE TABLE x (id INT)', 'DDL_ADD_COLUMN'],
    ['20. DROP TABLE', 'DROP TABLE x', 'DROP_TABLE_OR_INDEX'],
    ['21. DROP DATABASE', 'DROP DATABASE x', 'DROP_DATABASE_OR_TRUNCATE'],
    ['22. TRUNCATE', 'TRUNCATE x', 'DROP_DATABASE_OR_TRUNCATE'],
    ['23. DROP USER', 'DROP USER x', 'DROP_USER_OR_REVOKE'],
    ['24. REVOKE', 'REVOKE SELECT ON x FROM y', 'DROP_USER_OR_REVOKE'],
    ['25. INSERT', 'INSERT INTO x VALUES (1)', 'DELETE_UPDATE_BULK'],
    ['26. UPDATE', 'UPDATE x SET y = 1', 'DELETE_UPDATE_BULK'],
    ['27. DELETE', 'DELETE FROM x', 'DELETE_UPDATE_BULK'],
    // 28. GRANT · day-one 11 类无 GRANT · 当前归 OTHER (后续 issue 细分)
    ['28. GRANT (day-one 11 类无 · 归 OTHER)', 'GRANT SELECT ON x TO y', 'OTHER'],
    ['29. SHOW (只读)', 'SHOW search_path', 'READ_ONLY'],
    // 30. PG parser parse 失败 (typo) → OTHER fail-closed
    ['30. parse 失败 → OTHER fail-closed', 'DROP TABL', 'OTHER'],
  ];
  for (const [name, sql, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyOp('run_sql', sql)).toBe(expected);
    });
  }
});

// ───────── 额外: pg_drop_replication_slot · 非 statement 形态 (function call) ─────────
describe('feat-028 · DROP_REPLICATION_SLOT (函数调用形态 · 不退化 feat-056 day-one)', () => {
  it('SELECT pg_drop_replication_slot(\'s1\') → DROP_REPLICATION_SLOT (FuncCall scan)', () => {
    expect(classifyOp('run_sql', "SELECT pg_drop_replication_slot('s1')")).toBe(
      'DROP_REPLICATION_SLOT',
    );
  });
});

// ───────── tool 入口语义 · 不走 SQL 分类的 tool 视为 READ_ONLY ─────────
describe('feat-028 · classifyOp tool 入口', () => {
  it('非 SQL tool 视为 READ_ONLY (T1-T12 专用只读)', () => {
    expect(classifyOp('list_projects')).toBe('READ_ONLY');
    expect(classifyOp('get_metrics_history', 'irrelevant')).toBe('READ_ONLY');
  });
  it('run_sql 空 SQL → READ_ONLY (没东西执行)', () => {
    expect(classifyOp('run_sql', '')).toBe('READ_ONLY');
    expect(classifyOp('run_sql', '   ')).toBe('READ_ONLY');
  });
  it('run_sql_transaction 拼接也走 SQL 分类', () => {
    expect(classifyOp('run_sql_transaction', 'SELECT 1; DROP TABLE x')).toBe(
      'DROP_TABLE_OR_INDEX',
    );
  });

  it('VACUUM FULL 在 run_sql_transaction · classifyOp 仍返 VACUUM_FULL_LOCK (§11 OQ8 双层防御)', () => {
    // PG 自带拒 VACUUM 在 transaction block 内 · classifyOp 不依赖那层 · 仍返长锁分类
    // 走 matrix → require_plan 路径 (双层防御 · classify 在 PG 执行前先拦)
    expect(classifyOp('run_sql_transaction', 'VACUUM FULL sales')).toBe(
      'VACUUM_FULL_LOCK',
    );
  });
});

// ───────── feat-058 联动: isDestructiveSql 在 commented DROP 上仍标 destructive (#109 验证) ─────────
describe('feat-028/#109 · feat-058 dynamic annotation 联动 (isDestructiveSql)', () => {
  it('isDestructiveSql("VACUUM FULL x") → true (regression · day-one regex 也 catch)', () => {
    expect(isDestructiveSql('VACUUM FULL sales')).toBe(true);
  });
  it('isDestructiveSql("DROP --evil\\nTABLE x") → true (4 类绕过同步防护)', () => {
    expect(isDestructiveSql('DROP --evil\nTABLE x')).toBe(true);
  });
  it('isDestructiveSql("SELECT * FROM x") → false', () => {
    expect(isDestructiveSql('SELECT * FROM x')).toBe(false);
  });
  it('isDestructiveSql("CLUSTER x USING idx") → true (#109 长锁也算 destructive)', () => {
    expect(isDestructiveSql('CLUSTER x USING idx')).toBe(true);
  });
  it('isDestructiveSql parse-failed SQL → true (OTHER fail-closed · 防漏标 destructive)', () => {
    expect(isDestructiveSql('DROP TABL')).toBe(true);
  });
});

// ───────── LRU 缓存 + audit event ─────────
describe('feat-028 · LRU 缓存 cap 10000 + audit event', () => {
  it('缓存命中: 同 SQL 再调 cache_hit=true · 总 hit 计数 ++', () => {
    classifyOp('run_sql', 'SELECT 1');
    classifyOp('run_sql', 'SELECT 1');
    const stats = getClassifyCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.cap).toBe(10000);
  });

  it('audit event 含 parser_backend + cache_hit 字段', () => {
    const events: ClassifyOpAuditEvent[] = [];
    setClassifyOpAuditEmitter((e) => events.push(e));
    classifyOp('run_sql', 'DROP TABLE x');
    classifyOp('run_sql', 'DROP TABLE x'); // cache hit
    setClassifyOpAuditEmitter(() => {}); // reset
    expect(events).toHaveLength(2);
    expect(events[0].parser_backend).toBe('pg-parser');
    expect(events[0].cache_hit).toBe(false);
    expect(events[0].op_class).toBe('DROP_TABLE_OR_INDEX');
    expect(events[1].cache_hit).toBe(true);
    expect(events[1].op_class).toBe('DROP_TABLE_OR_INDEX');
  });

  it('audit event 在专用只读 tool 上也 emit (has_sql=false)', () => {
    const events: ClassifyOpAuditEvent[] = [];
    setClassifyOpAuditEmitter((e) => events.push(e));
    classifyOp('list_projects');
    setClassifyOpAuditEmitter(() => {});
    expect(events[0]).toMatchObject({
      event: 'classify_op',
      tool_name: 'list_projects',
      has_sql: false,
      op_class: 'READ_ONLY',
    });
  });

  it('VACUUM_FULL_LOCK / CLUSTER_LOCK 出现在 audit event (#109)', () => {
    const events: ClassifyOpAuditEvent[] = [];
    setClassifyOpAuditEmitter((e) => events.push(e));
    classifyOp('run_sql', 'VACUUM FULL sales');
    classifyOp('run_sql', 'CLUSTER sales USING idx');
    setClassifyOpAuditEmitter(() => {});
    expect(events[0].op_class).toBe('VACUUM_FULL_LOCK');
    expect(events[1].op_class).toBe('CLUSTER_LOCK');
  });
});

// ───────── backend 默认 + classifySql 直接入口 (feat-019 / feat-058 复用) ─────────
describe('feat-028 · backend 默认 + classifySql 入口', () => {
  it('getParserBackend 默认 pg-parser', () => {
    expect(getParserBackend()).toBe('pg-parser');
  });

  it('classifySql 不走 cache · 直接给 SQL 内容分类 (feat-019/feat-058 复用)', () => {
    expect(classifySql('SELECT * FROM x')).toBe('READ_ONLY');
    expect(classifySql('DROP /* xxx */ TABLE x')).toBe('DROP_TABLE_OR_INDEX');
    expect(classifySql('VACUUM FULL sales')).toBe('VACUUM_FULL_LOCK');
  });
});

// ───────── regex backend (回滚通路 · 失 4 类绕过 + 长锁仍 catch) ─────────
describe('feat-028 · regex backend 回滚通路 (PARSER_BACKEND=regex)', () => {
  beforeEach(() => {
    process.env.PARSER_BACKEND = 'regex';
    _resetClassifyCacheForTests();
  });
  afterEach(() => {
    delete process.env.PARSER_BACKEND;
  });

  it('regex backend 也 catch VACUUM FULL / CLUSTER (#109 不退化 · 关掉 feat-028 仍有长锁识别)', () => {
    expect(classifyOp('run_sql', 'VACUUM FULL sales')).toBe('VACUUM_FULL_LOCK');
    expect(classifyOp('run_sql', 'CLUSTER sales USING idx')).toBe('CLUSTER_LOCK');
  });

  it('regex backend 会被块注释绕过 (已知局限 · 故默认 pg-parser)', () => {
    // 这条 case 是反向验证 · 证明 pg-parser 才能闭防 4 类绕过
    expect(classifyOp('run_sql', '/* SELECT */ DROP TABLE x')).toBe(
      'DROP_TABLE_OR_INDEX',
    );
    // 注: regex 会匹配 DROP TABLE 因为 .toUpperCase() 仍能见到 · 此例其实通过
    // 真正绕过例: DR/**/OP TABLE x (在 keyword 中间插注释)
    expect(classifyOp('run_sql', 'DR/* x */OP TABLE x')).toBe('READ_ONLY');
    //                                                 ^^^^^^^^ regex 看不见 DROP · 这是 day-one 局限
  });
});
