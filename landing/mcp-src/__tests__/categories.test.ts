import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_TOOL_CATEGORIES,
  DEFAULT_TOOL_CATEGORY,
  CORE_TOOL_NAMES,
  getToolCategory,
  isValidToolCategory,
  parseCategoryInclude,
  DEFAULT_CATEGORY_INCLUDE,
  type ToolCategory,
} from '../config/categories';

describe('categories constants', () => {
  it('exports SUPPORTED_TOOL_CATEGORIES = [core, optional]', () => {
    expect(SUPPORTED_TOOL_CATEGORIES).toEqual(['core', 'optional']);
  });

  it('DEFAULT_TOOL_CATEGORY is optional (safe default · upstream tools default optional · feat-005 §3)', () => {
    expect(DEFAULT_TOOL_CATEGORY).toBe('optional');
  });

  it('CORE_TOOL_NAMES contains exactly 4 L1 day-one core tools', () => {
    expect(CORE_TOOL_NAMES.size).toBe(4);
  });

  it('CORE_TOOL_NAMES contains find_neondb_instances (T1 · sales step 1)', () => {
    expect(CORE_TOOL_NAMES.has('find_neondb_instances')).toBe(true);
  });

  it('CORE_TOOL_NAMES contains get_neondb_calling_services (T2 · application attribution)', () => {
    expect(CORE_TOOL_NAMES.has('get_neondb_calling_services')).toBe(true);
  });

  it('CORE_TOOL_NAMES contains get_neondb_query_statement (T6 · 防 LLM SQL 幻觉 · narrative #3 主卖点)', () => {
    expect(CORE_TOOL_NAMES.has('get_neondb_query_statement')).toBe(true);
  });

  it('CORE_TOOL_NAMES contains get_neondb_schemas (T8 · 防表名字段幻觉 · narrative #3 主卖点)', () => {
    expect(CORE_TOOL_NAMES.has('get_neondb_schemas')).toBe(true);
  });
});

describe('getToolCategory', () => {
  it('returns "core" for day-one core tools', () => {
    expect(getToolCategory('find_neondb_instances')).toBe('core');
    expect(getToolCategory('get_neondb_calling_services')).toBe('core');
    expect(getToolCategory('get_neondb_query_statement')).toBe('core');
    expect(getToolCategory('get_neondb_schemas')).toBe('core');
  });

  it('returns "optional" for upstream Neon tools (default optional · not挤兑 listing)', () => {
    expect(getToolCategory('list_projects')).toBe('optional');
    expect(getToolCategory('run_sql')).toBe('optional');
    expect(getToolCategory('delete_branch')).toBe('optional');
    expect(getToolCategory('create_project')).toBe('optional');
    expect(getToolCategory('describe_table_schema')).toBe('optional');
  });

  it('returns "optional" for unknown tool names (safe default)', () => {
    expect(getToolCategory('totally_made_up_tool_xyz')).toBe('optional');
    expect(getToolCategory('')).toBe('optional');
  });
});

describe('isValidToolCategory', () => {
  it('accepts "core" and "optional"', () => {
    expect(isValidToolCategory('core')).toBe(true);
    expect(isValidToolCategory('optional')).toBe(true);
  });

  it('rejects invalid strings', () => {
    expect(isValidToolCategory('default')).toBe(false);
    expect(isValidToolCategory('extra')).toBe(false);
    expect(isValidToolCategory('CORE')).toBe(false); // case-sensitive
    expect(isValidToolCategory('')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isValidToolCategory(null)).toBe(false);
    expect(isValidToolCategory(undefined)).toBe(false);
    expect(isValidToolCategory(42)).toBe(false);
    expect(isValidToolCategory({ category: 'core' })).toBe(false);
    expect(isValidToolCategory(['core'])).toBe(false);
  });

  it('narrows type for valid values (TypeScript type guard)', () => {
    const value: unknown = 'core';
    if (isValidToolCategory(value)) {
      const _typeCheck: ToolCategory = value; // compile-time check · ToolCategory union
      expect(_typeCheck).toBe('core');
    }
  });
});

describe('day-one ship budget check (feat-005 §5 non-functional requirement)', () => {
  it('core tool count ≤ 4 (keeps 26 listing budget for ecosystem · ~30 tools client cap · 13%)', () => {
    expect(CORE_TOOL_NAMES.size).toBeLessThanOrEqual(4);
  });
});

describe('parseCategoryInclude (feat-005 #3 · ?include= HTTP query param parser)', () => {
  it('DEFAULT_CATEGORY_INCLUDE is "core" (4 day-one tools · keeps ~26 listing budget for ecosystem MCPs)', () => {
    expect(DEFAULT_CATEGORY_INCLUDE).toBe('core');
  });

  it('accepts "core" as-is', () => {
    expect(parseCategoryInclude('core')).toBe('core');
  });

  it('accepts "all" as-is (client opt-in to 33-tool listing)', () => {
    expect(parseCategoryInclude('all')).toBe('all');
  });

  it('null (param missing) falls back to "core" default', () => {
    expect(parseCategoryInclude(null)).toBe('core');
  });

  it('empty string falls back to "core" default', () => {
    expect(parseCategoryInclude('')).toBe('core');
  });

  it('invalid values fall back to "core" default (strict whitelist · defense against typos/stale clients)', () => {
    expect(parseCategoryInclude('optional')).toBe('core');
    expect(parseCategoryInclude('Core')).toBe('core'); // case-sensitive
    expect(parseCategoryInclude('ALL')).toBe('core');
    expect(parseCategoryInclude('foo')).toBe('core');
    expect(parseCategoryInclude('core,all')).toBe('core');
  });
});
