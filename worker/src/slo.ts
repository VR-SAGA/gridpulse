// Pure SLO math, kept free of I/O so it is easy to unit test.
import type { Rule, Slo, Window } from "./config";

/** Event counts over a window. "good" depends on the SLI type. */
export interface Counts {
  total: number;
  good: number;
}

/** Raw rollup row: total probes, non-5xx probes, and fast-and-ok probes. */
export interface Rollup {
  total: number;
  ok: number;
  fast: number;
}

/**
 * Map a rollup onto an SLI.
 * Availability: good = non-5xx. Latency: good = completed successfully
 * under the threshold, over all requests (matches a Cloud Monitoring
 * distribution-cut SLI, where errors also count against latency).
 */
export function toCounts(slo: Pick<Slo, "type">, r: Rollup): Counts {
  return { total: r.total, good: slo.type === "availability" ? r.ok : r.fast };
}

/** Observed error ratio divided by the error ratio the SLO allows. */
export function burnRate(c: Counts, objective: number): number {
  if (c.total === 0) return 0;
  const errorRatio = (c.total - c.good) / c.total;
  return errorRatio / (1 - objective);
}

/** Share of the error budget still unspent over the SLO window. Negative = overspent. */
export function budgetRemaining(c: Counts, objective: number): number {
  if (c.total === 0) return 1;
  return 1 - burnRate(c, objective);
}

export function sli(c: Counts): number | null {
  return c.total === 0 ? null : c.good / c.total;
}

export interface Evaluation {
  burnRates: Record<Window, number>;
  firing: Rule | null;
}

/**
 * Multi-window, multi-burn-rate alerting (SRE Workbook, ch. 5).
 * A rule fires only when BOTH its long and short window burn faster than the
 * threshold: the long window proves the problem is significant, the short one
 * proves it is still happening (so alerts reset quickly after recovery).
 * Rules are checked in config order, so put the most severe first.
 */
export function evaluate(
  windows: Record<Window, Counts>,
  objective: number,
  rules: Rule[],
  minEventsLong: number,
): Evaluation {
  const burnRates = Object.fromEntries(
    Object.entries(windows).map(([w, c]) => [w, burnRate(c, objective)]),
  ) as Record<Window, number>;

  for (const rule of rules) {
    const long = windows[rule.long];
    const short = windows[rule.short];
    if (long.total < minEventsLong || short.total === 0) continue;
    if (burnRates[rule.long] > rule.burn_rate && burnRates[rule.short] > rule.burn_rate) {
      return { burnRates, firing: rule };
    }
  }
  return { burnRates, firing: null };
}

/** Align a unix timestamp (seconds) down to the start of its bucket. */
export function bucketStart(ts: number, resolution: number): number {
  return ts - (ts % resolution);
}

/**
 * Find the greenest contiguous window in a carbon-intensity forecast.
 * Used to suggest when to run batch jobs (carbon-aware scheduling).
 */
export function greenestWindow<T extends { intensity: number }>(
  slots: T[],
  length: number,
): { start: number; avg: number } | null {
  if (slots.length < length || length <= 0) return null;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += slots[i]!.intensity;
  let best = { start: 0, avg: sum / length };
  for (let i = length; i < slots.length; i++) {
    sum += slots[i]!.intensity - slots[i - length]!.intensity;
    const avg = sum / length;
    if (avg < best.avg) best = { start: i - length + 1, avg };
  }
  return best;
}
