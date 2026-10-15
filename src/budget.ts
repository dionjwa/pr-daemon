// Token budget: a rolling window (e.g. one 5h Claude subscription window)
// and an optional cap per issue. Counted from live usage in the ledger.
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { Usage } from "./agent.ts";

export function count(u: Usage, cfg: Config): number {
  return u.input + u.output + u.cache_create + (cfg.budget.countCacheReads ? u.cache_read : 0);
}

export interface BudgetState {
  used: number;              // tokens in the current window
  limit: number | null;
  windowMs: number;
  /** When enough usage ages out of the window to get back under the limit. */
  freesAt: number | null;
  breakdown: Usage;
}

export function windowState(store: Store, cfg: Config, now = Date.now()): BudgetState {
  const rows = store.usageRows(now - cfg.budget.windowMs);
  const breakdown: Usage = { input: 0, output: 0, cache_create: 0, cache_read: 0 };
  for (const r of rows) {
    breakdown.input += r.input; breakdown.output += r.output;
    breakdown.cache_create += r.cache_create; breakdown.cache_read += r.cache_read;
  }
  const used = count(breakdown, cfg);
  const limit = cfg.budget.tokens;
  let freesAt: number | null = null;
  if (limit !== null && used >= limit) {
    // Walk the oldest usage forward until what remains is under the limit.
    let remaining = used;
    for (const r of rows) {
      remaining -= count(r, cfg);
      if (remaining < limit) { freesAt = r.at + cfg.budget.windowMs; break; }
    }
  }
  return { used, limit, windowMs: cfg.budget.windowMs, freesAt, breakdown };
}

export function issueUsed(store: Store, cfg: Config, repo: string, issue: number): number {
  return count(store.issueUsage(repo, issue), cfg);
}

export type Gate = { ok: true } | { ok: false; reason: string; retryAt: number | null; needsHuman: boolean };

/** May an agent job for this issue start (or keep running) right now? */
export function gate(store: Store, cfg: Config, repo: string, issue: number, now = Date.now()): Gate {
  const w = windowState(store, cfg, now);
  if (w.limit !== null && w.used >= w.limit) {
    return { ok: false, reason: `token budget for this ${fmtWindow(cfg)} window is used up`, retryAt: w.freesAt, needsHuman: false };
  }
  const cap = cfg.budget.perIssue;
  if (cap !== null && issueUsed(store, cfg, repo, issue) >= cap) {
    return { ok: false, reason: "this issue reached its per-issue token cap (raise budget.per_issue, then Resume)", retryAt: null, needsHuman: true };
  }
  return { ok: true };
}

function fmtWindow(cfg: Config): string {
  const h = cfg.budget.windowMs / 3600e3;
  return Number.isInteger(h) ? `${h}h` : `${Math.round(cfg.budget.windowMs / 60e3)}m`;
}
