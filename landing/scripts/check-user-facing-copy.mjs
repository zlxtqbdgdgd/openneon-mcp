// feat-073 (ADR-0020): lint guard — user-facing MCP copy must be free of internal
// design vocabulary.
//
// MCP tool / prompt `description` and `title` are read by the agent at RUNTIME and
// echoed to the end user. They must read as plain functional copy (what it does /
// when to use / caveats) and must NOT leak internal design vocabulary: feature
// numbers (feat-NNN), internal tool codes (Tn), autonomy-level codes (L0-L5),
// design-doc section numbers (§N), ADR references, or server-side internal enum
// names. Those belong in code comments + the detailed-design HTML, never in a
// runtime string that surfaces to users.
//
// This check uses the TypeScript compiler API to inspect ONLY the string values of
// `description:` / `title:` property assignments — so it never flags code comments
// or the GitHub design-doc link URLs (which legitimately contain feat-NNN), which
// is exactly where the design vocabulary is supposed to live.
//
// Run: `node scripts/check-user-facing-copy.mjs` (wired into `pnpm lint`).

import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// User-facing MCP surface: the files whose `description`/`title` reach the user.
// Extend this list when a new file defines runtime user-facing tool/prompt copy.
const SCAN_FILES = ['mcp-src/tools/definitions.ts', 'mcp-src/prompts.ts'];

// Property names whose string value is user-facing runtime copy.
const FIELDS = new Set(['description', 'title']);

// Banned internal-design vocabulary. Keep the set small + precise to avoid
// false positives; add an exception below if a legitimate use is ever flagged.
const BANNED = [
  { re: /\bfeat-\d+/i, label: 'feature number (feat-NNN)' },
  { re: /§\s*\d/, label: 'design-doc section (§N)' },
  { re: /\bADR-\d+/i, label: 'ADR reference (ADR-NNNN)' },
  { re: /\bT\d{1,2}\b/, label: 'internal tool code (Tn)' },
  { re: /\bL[0-5][ab]?\b/, label: 'autonomy-level code (L0-L5)' },
  { re: /\b(?:ODD|MRC|USR)\b/, label: 'internal enum / feature codename' },
];

// Substrings that are legitimate even though a banned pattern matches them.
// Format: { file: <relative path>, allow: <substring of the matched value> }.
const EXCEPTIONS = [];

function literalText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    // template with ${...}: concatenate the static literal parts only.
    let out = node.head.text;
    for (const span of node.templateSpans) out += ' ' + span.literal.text;
    return out;
  }
  return null;
}

const violations = [];

for (const rel of SCAN_FILES) {
  const abs = join(repoRoot, rel);
  const source = ts.createSourceFile(
    abs,
    readFileSync(abs, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  const walk = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      FIELDS.has(node.name.text)
    ) {
      const text = literalText(node.initializer);
      if (text != null) {
        for (const { re, label } of BANNED) {
          const m = text.match(re);
          if (!m) continue;
          const excepted = EXCEPTIONS.some(
            (e) => e.file === rel && text.includes(e.allow),
          );
          if (excepted) continue;
          const { line } = source.getLineAndCharacterOfPosition(
            node.initializer.getStart(source),
          );
          violations.push({
            file: rel,
            line: line + 1,
            field: node.name.text,
            hit: m[0],
            label,
          });
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
}

if (violations.length === 0) {
  console.log(
    `✓ user-facing-copy: no internal design vocabulary in ${SCAN_FILES.length} scanned file(s)`,
  );
  process.exit(0);
}

console.error(
  `✗ user-facing-copy: ${violations.length} internal-design-vocabulary leak(s) in runtime user-facing copy.\n` +
    `  Rewrite the description/title as plain functional copy; move the design reference to a\n` +
    `  code comment or the detailed-design HTML (see ADR-0020).\n`,
);
for (const v of violations) {
  console.error(
    `  ${relative(process.cwd(), join(repoRoot, v.file))}:${v.line}  ${v.field} contains "${v.hit}"  — ${v.label}`,
  );
}
process.exit(1);
