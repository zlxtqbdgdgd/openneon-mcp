/**
 * Response formatter for openneon-mcp tool responses.
 *
 * Token economy 地基 per feat-006 (L1 day-one ship · F8 CSV 默认输出).
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-006-L1-mcp-server-csv-default-output.html
 *
 * Default format is CSV (~10× token reduction vs JSON for tabular data ·
 * matches feat-006 §5 non-functional requirement).
 *
 * Used by:
 * - feat-001/002/003/004 tool handlers (day-one L1) · output via formatToolResponse(data)
 * - feat-007 progressive disclosure (depth shallow/full) · shares this formatter
 * - L2+ tool handlers
 *
 * Related sub-issues:
 * - feat-006 #1 (this file) · csv-stringify integration
 * - feat-006 #2 (next PR) · 改 8 个 day-one tool handler 调 formatter
 * - feat-006 #3 (next PR) · tools/list response 加 outputFormat field
 * - feat-006 #4 (next PR) · feat-061 fixture step 2 token compression check
 */

import { stringify as csvStringify } from 'csv-stringify/sync';

/**
 * Supported output formats for MCP tool responses.
 *
 * - 'csv' (default · token economy地基) · ~10× shorter than JSON for tabular data
 * - 'json' · backwards-compatible · opt-in via ?format=json query param
 * - 'tsv' · tab-separated · less commonly requested but symmetric
 */
export type OutputFormat = 'csv' | 'json' | 'tsv';

export const SUPPORTED_OUTPUT_FORMATS: readonly OutputFormat[] = [
  'csv',
  'json',
  'tsv',
] as const;

/**
 * Default format. CSV chosen as token-economy default per feat-006 §4 schema decision.
 * Detail design: features/feat-006-L1-mcp-server-csv-default-output.html
 */
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = 'csv';

export type FormatToolResponseOptions = {
  /** Output format. Defaults to DEFAULT_OUTPUT_FORMAT ('csv'). */
  format?: OutputFormat;
};

/**
 * Format a tool response in the requested format.
 *
 * Accepts an array of row objects (tabular data) or a single object (auto-wraps to array).
 * Returns a string ready for embedding in MCP tool response `content[].text`.
 *
 * @param data - Array of objects (or single object · auto-wraps to single-row array)
 * @param options - Format options
 * @returns Formatted string · CSV / JSON / TSV per options.format
 *
 * @example
 * formatToolResponse([{ project_id: 'abc', name: 'production' }])
 * // 'project_id,name\nabc,production\n'
 *
 * formatToolResponse({ project_id: 'abc' }, { format: 'json' })
 * // '[\n  {\n    "project_id": "abc"\n  }\n]'
 */
export function formatToolResponse(
  data: Record<string, unknown>[] | Record<string, unknown>,
  options: FormatToolResponseOptions = {},
): string {
  const format = options.format ?? DEFAULT_OUTPUT_FORMAT;
  const rows = Array.isArray(data) ? data : [data];

  if (!SUPPORTED_OUTPUT_FORMATS.includes(format)) {
    throw new Error(
      `Unsupported format: '${format}'. Supported formats: ${SUPPORTED_OUTPUT_FORMATS.join(', ')}.`,
    );
  }

  if (rows.length === 0) {
    return format === 'json' ? '[]' : '';
  }

  // Use first row's keys as column order (deterministic · matches detail design §4 schema)
  const columns = Object.keys(rows[0]);

  switch (format) {
    case 'csv':
      return csvStringify(rows, { header: true, columns });
    case 'tsv':
      return csvStringify(rows, {
        header: true,
        columns,
        delimiter: '\t',
      });
    case 'json':
      return JSON.stringify(rows, null, 2);
    default: {
      // Unreachable due to SUPPORTED_OUTPUT_FORMATS check above · TypeScript exhaustiveness
      const _exhaustive: never = format;
      throw new Error(`Unsupported format: '${String(_exhaustive)}'`);
    }
  }
}
