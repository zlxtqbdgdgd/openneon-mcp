/**
 * Default SLO specs per signal · feat-018 (L2a · OQ3 · OQ5).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-018-L2-mcp-server-enrich-sli-burn-rate.html §4
 *
 * Conservative defaults · OVERRIDABLE (a too-loose SLO never alerts · a too-strict one fatigues).
 * The exact targets/thresholds need calibration via feat-054 eval (OQ3) and the config home may move
 * to the feat-056 policy engine (OQ5) — for L2a these are documented starting points, not final.
 *
 * Only signals present here get an SLO block from T4. feat-020/#5 adds entries (e.g. cache_hit_ratio
 * native_ratio) as it grows the signal set.
 */

import type { SloSpec } from './slo-burn-rate';

export const SLO_SPECS: Record<string, SloSpec> = {
  // connections · gauge_threshold · "≥99% of the time, active connections stay at/under 80".
  // 80 is a conservative starting threshold (OQ3 · overridable · ideally derived from the compute's
  // max_connections once that is wired). good_when 'below' because high connections is the bad direction.
  connections: {
    signal: 'connections',
    sli_kind: 'gauge_threshold',
    threshold: 80,
    good_when: 'below',
    slo_target: 0.99,
    budget_window: '30d',
  },
  // cache_hit_ratio · native_ratio · the canonical SLO example (feat-018 §12): the signal IS already
  // a ratio, used directly as the SLI. 99% / 30d is the conservative default (OQ3 · overridable).
  cache_hit_ratio: {
    signal: 'cache_hit_ratio',
    sli_kind: 'native_ratio',
    slo_target: 0.99,
    budget_window: '30d',
  },
};

export function getSloSpec(signal: string): SloSpec | undefined {
  return SLO_SPECS[signal];
}
