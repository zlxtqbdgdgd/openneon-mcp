import { describe, it, expect } from 'vitest';
import {
  formatToolResponse,
  SUPPORTED_OUTPUT_FORMATS,
  DEFAULT_OUTPUT_FORMAT,
  type OutputFormat,
} from '../server/response-formatter';

describe('response-formatter constants', () => {
  it('exports SUPPORTED_OUTPUT_FORMATS = [csv, json, tsv]', () => {
    expect(SUPPORTED_OUTPUT_FORMATS).toEqual(['csv', 'json', 'tsv']);
  });

  it('default format is csv (token economy default per feat-006 §4)', () => {
    expect(DEFAULT_OUTPUT_FORMAT).toBe('csv');
  });
});

describe('formatToolResponse · default format (csv)', () => {
  it('formats array of objects as CSV with header', () => {
    const data = [
      { project_id: 'abc', name: 'production', region: 'us-east-1' },
      { project_id: 'def', name: 'staging', region: 'us-east-1' },
    ];
    const out = formatToolResponse(data);
    const lines = out.trim().split('\n');
    expect(lines[0]).toBe('project_id,name,region');
    expect(lines[1]).toBe('abc,production,us-east-1');
    expect(lines[2]).toBe('def,staging,us-east-1');
  });

  it('default (no options) uses csv format', () => {
    const data = [{ a: 1, b: 2 }];
    const csv = formatToolResponse(data);
    expect(csv).toContain('a,b');
    expect(csv).toContain('1,2');
  });

  it('handles single object (auto-wraps to array)', () => {
    const data = { project_id: 'abc', name: 'production' };
    const csv = formatToolResponse(data);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('project_id,name');
    expect(lines[1]).toBe('abc,production');
  });

  it('handles empty array (returns empty string for csv)', () => {
    expect(formatToolResponse([])).toBe('');
  });

  it('quotes special chars per RFC 4180 (comma in value)', () => {
    const data = [{ name: 'sales, inc.', count: 5 }];
    const csv = formatToolResponse(data);
    expect(csv).toContain('"sales, inc."');
  });

  it('quotes special chars per RFC 4180 (double-quote in value)', () => {
    const data = [{ desc: 'has "quotes" inside', count: 1 }];
    const csv = formatToolResponse(data);
    expect(csv).toMatch(/"has ""quotes"" inside"/);
  });

  it('quotes special chars per RFC 4180 (newline in value)', () => {
    const data = [{ note: 'line1\nline2', count: 1 }];
    const csv = formatToolResponse(data);
    // CSV with embedded newline should be wrapped in double quotes
    expect(csv).toContain('"line1\nline2"');
  });
});

describe('formatToolResponse · json format', () => {
  it('formats array as JSON array (indented 2 spaces)', () => {
    const data = [{ a: 1 }, { a: 2 }];
    const out = formatToolResponse(data, { format: 'json' });
    expect(JSON.parse(out)).toEqual(data);
    expect(out).toContain('  '); // indented
  });

  it('handles empty array (returns "[]")', () => {
    const out = formatToolResponse([], { format: 'json' });
    expect(out).toBe('[]');
  });

  it('handles single object (still wraps to array)', () => {
    const out = formatToolResponse({ a: 1 }, { format: 'json' });
    expect(JSON.parse(out)).toEqual([{ a: 1 }]);
  });
});

describe('formatToolResponse · tsv format', () => {
  it('formats with tab delimiter', () => {
    const data = [
      { project_id: 'abc', name: 'production' },
      { project_id: 'def', name: 'staging' },
    ];
    const out = formatToolResponse(data, { format: 'tsv' });
    const lines = out.trim().split('\n');
    expect(lines[0]).toBe('project_id\tname');
    expect(lines[1]).toBe('abc\tproduction');
  });

  it('handles empty array (returns empty string for tsv)', () => {
    expect(formatToolResponse([], { format: 'tsv' })).toBe('');
  });
});

describe('formatToolResponse · token economy (feat-006 §5 ROI)', () => {
  it('CSV is shorter than JSON for same data (≥ 2× reduction · loose lower bound for small data)', () => {
    // larger data sample · approximates 30-row use case
    const data = Array.from({ length: 30 }, (_, i) => ({
      project_id: `proj-${i}`,
      name: `project-${i}`,
      region: 'us-east-1',
      status: 'running',
      branch_count: 3,
      active_endpoint_count: 2,
    }));
    const csv = formatToolResponse(data, { format: 'csv' });
    const json = formatToolResponse(data, { format: 'json' });
    // CSV should be ≥ 2× shorter than JSON (feat-006 ROI target ≥ 8× · loose unit-test bound 2×)
    expect(csv.length).toBeLessThan(json.length / 2);
  });
});

describe('formatToolResponse · errors', () => {
  it('throws on unsupported format', () => {
    expect(() =>
      formatToolResponse([{ a: 1 }], { format: 'xml' as OutputFormat }),
    ).toThrow(/unsupported format/i);
  });
});
