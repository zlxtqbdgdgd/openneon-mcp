import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_DEPTHS,
  DEFAULT_DEPTH,
  DEPTH_SUPPORTING_TOOLS,
  isToolSupportingDepth,
  isValidDepth,
  type DepthLevel,
} from '../config/depth';

describe('depth constants', () => {
  it('exports SUPPORTED_DEPTHS = [shallow, full]', () => {
    expect(SUPPORTED_DEPTHS).toEqual(['shallow', 'full']);
  });

  it('DEFAULT_DEPTH is shallow (token economy default · feat-007 §3)', () => {
    expect(DEFAULT_DEPTH).toBe('shallow');
  });

  it('DEPTH_SUPPORTING_TOOLS contains 3 tools (T6/T8 L1 day-one + feat-019 explain_plans L2a)', () => {
    expect(DEPTH_SUPPORTING_TOOLS.size).toBe(3);
  });

  it('DEPTH_SUPPORTING_TOOLS contains get_neondb_query_statement (T6 · narrative #3 主卖点)', () => {
    expect(DEPTH_SUPPORTING_TOOLS.has('get_neondb_query_statement')).toBe(true);
  });

  it('DEPTH_SUPPORTING_TOOLS contains get_neondb_schemas (T8 · narrative #3 配对)', () => {
    expect(DEPTH_SUPPORTING_TOOLS.has('get_neondb_schemas')).toBe(true);
  });

  it('DEPTH_SUPPORTING_TOOLS contains get_neondb_explain_plans (feat-019/#2 · signals 摘要 / raw plan)', () => {
    expect(DEPTH_SUPPORTING_TOOLS.has('get_neondb_explain_plans')).toBe(true);
  });
});

describe('isToolSupportingDepth', () => {
  it('returns true for L1 day-one depth-supporting tools (T6/T8)', () => {
    expect(isToolSupportingDepth('get_neondb_query_statement')).toBe(true);
    expect(isToolSupportingDepth('get_neondb_schemas')).toBe(true);
  });

  it('returns false for upstream Neon tools without depth support', () => {
    expect(isToolSupportingDepth('list_projects')).toBe(false);
    expect(isToolSupportingDepth('run_sql')).toBe(false);
    expect(isToolSupportingDepth('delete_branch')).toBe(false);
    expect(isToolSupportingDepth('describe_table_schema')).toBe(false); // upstream variant · feat-004 is our extension
  });

  it('returns false for other L1 day-one tools without depth (T1/T2)', () => {
    expect(isToolSupportingDepth('find_neondb_instances')).toBe(false); // simple list · no depth
    expect(isToolSupportingDepth('get_neondb_calling_services')).toBe(false);
  });

  it('returns false for unknown tool names (safe default)', () => {
    expect(isToolSupportingDepth('totally_made_up_tool_xyz')).toBe(false);
    expect(isToolSupportingDepth('')).toBe(false);
  });
});

describe('isValidDepth', () => {
  it('accepts "shallow" and "full"', () => {
    expect(isValidDepth('shallow')).toBe(true);
    expect(isValidDepth('full')).toBe(true);
  });

  it('rejects invalid strings', () => {
    expect(isValidDepth('brief')).toBe(false);
    expect(isValidDepth('detailed')).toBe(false);
    expect(isValidDepth('SHALLOW')).toBe(false); // case-sensitive
    expect(isValidDepth('medium')).toBe(false);
    expect(isValidDepth('')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isValidDepth(null)).toBe(false);
    expect(isValidDepth(undefined)).toBe(false);
    expect(isValidDepth(1)).toBe(false);
    expect(isValidDepth({ depth: 'shallow' })).toBe(false);
    expect(isValidDepth(['shallow'])).toBe(false);
  });

  it('narrows type for valid values (TypeScript type guard)', () => {
    const value: unknown = 'shallow';
    if (isValidDepth(value)) {
      const _typeCheck: DepthLevel = value; // compile-time check · DepthLevel union
      expect(_typeCheck).toBe('shallow');
    }
  });
});

describe('day-one ship scope check (feat-007 §3)', () => {
  it('depth-supporting tools = 3 (T6/T8 L1 day-one + feat-019 explain_plans L2a) · not over-spec', () => {
    expect(DEPTH_SUPPORTING_TOOLS.size).toBe(3);
  });

  it('T1/T2 do not support depth (simple list/lookup · no shallow/full distinction)', () => {
    expect(isToolSupportingDepth('find_neondb_instances')).toBe(false);
    expect(isToolSupportingDepth('get_neondb_calling_services')).toBe(false);
  });
});
