// Local state in SQLite (node:sqlite, built in; no native modules).
// GitHub stays the source of truth for issues/PRs; this holds the queue,
// token ledger, stacks, and an event log for the status page.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { HOME } from "./config.ts";

export type JobKind = "build" | "review" | "revise" | "ci" | "merge" | "teardown" | "restart";
export type JobState = "queued" | "running" | "paused" | "done" | "failed" | "cancelled" | "ignored";

export interface Job {
  id: number;
  repo: string;
  kind: JobKind;
  number: number;          // issue number (build/teardown/restart) or PR number (review/revise/ci/merge)
  trigger_key: string;     // dedupe key: label event id, comment id, failing CI head sha, …
  state: JobState;
  reason: string;          // why it's waiting / failed / ignored
  branch: string;
  pr: number | null;
  session_id: string;      // Claude session to resume after a pause
  payload: string;         // JSON: { feedback?, fromReview?, sha?, failing? }
  tokens: number;
  cost: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  resume_after: number | null;
}

export interface Stack {
  repo: string;
  branch: string;
  issue: number;
  worktree: string;
  url: string;
  pr: number | null;
  builder_session: string;
  healthy: number;         // the stack answers on its own address: 1 / 0 / -1 unknown
  error: string;           // why `up` last failed, or what's wrong with the preview URL; "" when it's fine
  networks: string;        // docker network ids this stack's `up` created, space separated
  routes: string;          // JSON {service: local URL} from `up`'s PR_DAEMON_ROUTE lines; each gets <branch>--<service>.<domain>
  /** The public preview URL serves the app: 1 / 0 / -1 (no domain, or not probed yet). */
  public_ok: number;
  local_code: number | null;   // last HTTP status from the stack's own address (0 = no answer)
  public_code: number | null;  // last HTTP status from the public preview URL
  checked_at: number | null;
  /** The project's own CI for the PR's head commit: see gh.checks(). */
  checks_state: string;    // "" | none | pending | failure | success
  checks_detail: string;   // one line: what is failing or running
  checks_sha: string;      // the commit those checks are about
  checks_at: number | null;
  /** GitHub's view of whether the PR merges into its base: see gh.mergeability(). "" until read. */
  mergeable: string;       // "" | ok | behind | conflicts | unknown
  /** What pr-daemon last did about it, and how worried to be: ok (routine), warn (look before merging), bad (yours to do). */
  merge_note: string;
  merge_level: string;     // "" | ok | warn | bad
  merge_at: number | null;
  created_at: number;
}

// Higher-priority work first: finish and clean up before starting new builds.
// A red PR comes before a new build: it's work already in a human's hands.
// Conflicts come before red CI: CI doesn't run on a PR that can't merge.
export const PRIORITY: Record<JobKind, number> = { teardown: 0, restart: 1, merge: 2, ci: 3, revise: 4, review: 5, build: 6 };
export const AGENT_KINDS: JobKind[] = ["build", "review", "revise", "ci", "merge"];

export function openDb(path = join(HOME, "pr-daemon.db")): DatabaseSync {
  mkdirSync(HOME, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL, kind TEXT NOT NULL, number INTEGER NOT NULL,
      trigger_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'queued', reason TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '', pr INTEGER,
      session_id TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}',
      tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, resume_after INTEGER
    );
    CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL, repo TEXT NOT NULL, issue INTEGER NOT NULL, at INTEGER NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL, cache_create INTEGER NOT NULL, cache_read INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
    CREATE TABLE IF NOT EXISTS stacks (
      repo TEXT NOT NULL, branch TEXT NOT NULL, issue INTEGER NOT NULL,
      worktree TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', pr INTEGER,
      builder_session TEXT NOT NULL DEFAULT '',
      healthy INTEGER NOT NULL DEFAULT -1, error TEXT NOT NULL DEFAULT '',
      networks TEXT NOT NULL DEFAULT '', checked_at INTEGER, created_at INTEGER NOT NULL,
      public_ok INTEGER NOT NULL DEFAULT -1, local_code INTEGER, public_code INTEGER,
      checks_state TEXT NOT NULL DEFAULT '', checks_detail TEXT NOT NULL DEFAULT '',
      checks_sha TEXT NOT NULL DEFAULT '', checks_at INTEGER,
      PRIMARY KEY (repo, branch)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL, job_id INTEGER, level TEXT NOT NULL, message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // Columns added after the first release: ALTER is the whole migration story.
  for (const [table, col, def] of [["stacks", "error", "TEXT NOT NULL DEFAULT ''"], ["stacks", "networks", "TEXT NOT NULL DEFAULT ''"],
    ["stacks", "routes", "TEXT NOT NULL DEFAULT ''"], ["stacks", "public_ok", "INTEGER NOT NULL DEFAULT -1"],
    ["stacks", "local_code", "INTEGER"], ["stacks", "public_code", "INTEGER"],
    ["stacks", "checks_state", "TEXT NOT NULL DEFAULT ''"], ["stacks", "checks_detail", "TEXT NOT NULL DEFAULT ''"],
    ["stacks", "checks_sha", "TEXT NOT NULL DEFAULT ''"], ["stacks", "checks_at", "INTEGER"],
    ["stacks", "mergeable", "TEXT NOT NULL DEFAULT ''"], ["stacks", "merge_note", "TEXT NOT NULL DEFAULT ''"],
    ["stacks", "merge_level", "TEXT NOT NULL DEFAULT ''"], ["stacks", "merge_at", "INTEGER"]]) {
    const has = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  return db;
}

/** A stack worth telling someone about: it answers, and its public URL (if it has one) serves the app. */
const ready = (s?: Stack): boolean => !!s && s.healthy === 1 && s.public_ok !== 0;

export class Store {
  db: DatabaseSync;
  /** Called when a stack becomes reachable: new, or after being down or unknown. */
  onStackReady: ((s: Stack) => void) | null = null;
  constructor(db: DatabaseSync) { this.db = db; }

  // ---------- kv ----------
  get(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  set(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---------- events ----------
  event(message: string, jobId: number | null = null, level: "info" | "warn" | "error" = "info"): void {
    this.db.prepare("INSERT INTO events(at, job_id, level, message) VALUES(?, ?, ?, ?)").run(Date.now(), jobId, level, message);
    process.stderr.write(`[pr-daemon] ${jobId ? `#job${jobId} ` : ""}${message}\n`);
  }
  events(limit = 100): unknown[] {
    return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
  }

  // ---------- jobs ----------
  /** Insert a job unless its trigger_key was seen before. Returns the new id or null. */
  enqueue(j: { repo: string; kind: JobKind; number: number; trigger_key: string; state?: JobState; reason?: string; branch?: string; pr?: number | null; payload?: object }): number | null {
    const r = this.db.prepare(`INSERT OR IGNORE INTO jobs(repo, kind, number, trigger_key, state, reason, branch, pr, payload, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      j.repo, j.kind, j.number, j.trigger_key, j.state ?? "queued", j.reason ?? "", j.branch ?? "", j.pr ?? null,
      JSON.stringify(j.payload ?? {}), Date.now());
    return r.changes ? Number(r.lastInsertRowid) : null;
  }
  job(id: number): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
  }
  hasTrigger(key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM jobs WHERE trigger_key = ?").get(key);
  }
  update(id: number, fields: Partial<Job>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k] as SQLInputValue), id);
  }
  jobs(limit = 60): Job[] {
    return this.db.prepare(`SELECT * FROM jobs WHERE state != 'ignored' OR created_at > ? ORDER BY
      CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, id DESC LIMIT ?`)
      .all(Date.now() - 86400e3, limit) as unknown as Job[];
  }
  /** Runnable jobs, best first (PRIORITY, as SQL). */
  runnable(now = Date.now()): Job[] {
    const order = (Object.entries(PRIORITY) as [JobKind, number][]).map(([k, n]) => `WHEN '${k}' THEN ${n}`).join(" ");
    return this.db.prepare(`SELECT * FROM jobs WHERE state = 'queued' OR (state = 'paused' AND resume_after IS NOT NULL AND resume_after <= ?)
      ORDER BY CASE kind ${order} ELSE 99 END, id`)
      .all(now) as unknown as Job[];
  }
  /** Open (not finished) jobs for one issue/PR of a repo. */
  activeFor(repo: string, kind: JobKind, number: number): Job | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE repo = ? AND kind = ? AND number = ? AND state IN ('queued','running','paused') LIMIT 1`)
      .get(repo, kind, number) as Job | undefined;
  }
  /** How many of a kind of job this issue/PR has had (ignored ones don't count: they never ran). */
  countJobs(repo: string, kind: JobKind, number: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM jobs WHERE repo = ? AND kind = ? AND number = ? AND state != 'ignored'")
      .get(repo, kind, number) as { n: number }).n);
  }
  /** Jobs of a kind on this PR that ran an agent (spent tokens), not counting `except`: the rounds a cap is about. */
  countAgentRuns(repo: string, kind: JobKind, number: number, except = 0): number {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM jobs WHERE repo = ? AND kind = ? AND number = ? AND tokens > 0 AND id != ?")
      .get(repo, kind, number, except) as { n: number }).n);
  }
  /** After a crash, running jobs go back to the queue (their Claude session resumes). */
  recoverRunning(): number {
    return Number(this.db.prepare("UPDATE jobs SET state = 'queued', reason = 'resumed after restart' WHERE state = 'running'").run().changes);
  }

  // ---------- usage ledger ----------
  addUsage(job: Job, issue: number, u: { input: number; output: number; cache_create: number; cache_read: number }): void {
    this.db.prepare("INSERT INTO usage(job_id, repo, issue, at, input, output, cache_create, cache_read) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
      .run(job.id, job.repo, issue, Date.now(), u.input, u.output, u.cache_create, u.cache_read);
  }
  usageRows(since: number): { at: number; input: number; output: number; cache_create: number; cache_read: number }[] {
    return this.db.prepare("SELECT at, input, output, cache_create, cache_read FROM usage WHERE at > ? ORDER BY at").all(since) as never;
  }
  issueUsage(repo: string, issue: number): { input: number; output: number; cache_create: number; cache_read: number } {
    return this.db.prepare(`SELECT COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
      COALESCE(SUM(cache_create),0) cache_create, COALESCE(SUM(cache_read),0) cache_read FROM usage WHERE repo = ? AND issue = ?`)
      .get(repo, issue) as never;
  }

  // ---------- stacks ----------
  stacks(): Stack[] {
    return this.db.prepare("SELECT * FROM stacks ORDER BY created_at DESC").all() as unknown as Stack[];
  }
  stack(repo: string, branch: string): Stack | undefined {
    return this.db.prepare("SELECT * FROM stacks WHERE repo = ? AND branch = ?").get(repo, branch) as Stack | undefined;
  }
  stackForIssue(repo: string, issue: number): Stack | undefined {
    return this.db.prepare("SELECT * FROM stacks WHERE repo = ? AND issue = ?").get(repo, issue) as Stack | undefined;
  }
  upsertStack(s: Partial<Stack> & { repo: string; branch: string; issue: number; worktree: string }): void {
    const existing = this.stack(s.repo, s.branch);
    if (!existing) {
      this.db.prepare("INSERT INTO stacks(repo, branch, issue, worktree, created_at) VALUES(?, ?, ?, ?, ?)")
        .run(s.repo, s.branch, s.issue, s.worktree, Date.now());
    }
    const { repo, branch, ...rest } = s;
    const keys = Object.keys(rest);
    if (keys.length) {
      this.db.prepare(`UPDATE stacks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE repo = ? AND branch = ?`)
        .run(...keys.map((k) => (rest as Record<string, unknown>)[k] as SQLInputValue), repo, branch);
    }
    // "Ready" means the address a person will click actually serves the app,
    // so a stack that answers locally while its public URL doesn't is not news.
    if (!ready(existing) && ready(this.stack(repo, branch))) this.onStackReady?.(this.stack(repo, branch)!);
  }
  deleteStack(repo: string, branch: string): void {
    this.db.prepare("DELETE FROM stacks WHERE repo = ? AND branch = ?").run(repo, branch);
  }
}
