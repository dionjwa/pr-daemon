// The work itself: build, review, revise, teardown, restart.
// Each function runs one job end to end and is safe to re-run after a pause
// or crash: worktrees, stacks and PRs are found and reused, and the agent's
// Claude session is resumed rather than restarted.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startAgent, type AgentRun } from "./agent.ts";
import { count, gate } from "./budget.ts";
import type { Config, RepoConfig } from "./config.ts";
import type { Job, Store } from "./db.ts";
import * as gh from "./gh.ts";
import * as git from "./git.ts";
import { publicEnv, publicUrl, serviceUrl } from "./proxy.ts";
import * as stack from "./stack.ts";

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export class PauseError extends Error {
  retryAt: number | null;
  needsHuman: boolean;
  constructor(reason: string, retryAt: number | null, needsHuman: boolean) {
    super(reason); this.retryAt = retryAt; this.needsHuman = needsHuman;
  }
}
export class CancelError extends Error {}
export class FailError extends Error {}   // a clean "gave up", already reported on GitHub

export interface Ctx {
  store: Store;
  cfg: () => Config;            // always the latest saved config
  repo: RepoConfig;
  job: Job;
  /** The agent run in flight, so the scheduler can cancel it. */
  current: AgentRun | null;
  cancelled: boolean;
  activity: (line: string) => void;
  statusUrl: string;
  /** The worktree the agent runs in (set by each job once it has one). */
  current_wt?: string;
}

/** Fill {{NAME}} from vars in one left-to-right pass (substituted text is never re-scanned). */
export function render(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, k) => String(vars[k] ?? ""));
}
const prompt = (name: string, vars: Record<string, string | number | undefined>) =>
  render(readFileSync(join(PROMPTS, `${name}.md`), "utf8"), vars);

function payload(job: Job): { feedback?: string; fromReview?: boolean } {
  try { return JSON.parse(job.payload || "{}"); } catch { return {}; }
}

const issueOf = (branch: string) => Number(branch.split("-")[0]);
/** Docker networks this stack has created so far, as one space-separated field. */
/** The routes column for a successful `up`. */
const routesOf = (r: stack.UpResult): { routes?: string } => (r.ok ? { routes: JSON.stringify(r.routes) } : {});

/**
 * Where the agent should reach the running stack. With a preview domain the
 * stack is wired for its public origin, so the public URLs are the only ones
 * that work in a browser: its local URL is just what the proxy forwards to.
 */
export function stackWhere(cfg: Config, branch: string, r: stack.UpResult): string {
  const pub = publicUrl(cfg, branch);
  const url = r.ok ? r.url : "";
  if (!pub) return url || "(no URL printed)";
  const services = r.ok ? Object.keys(r.routes) : [];
  return `${pub} — use ONLY this address (and the service addresses below) in a browser, Playwright, curl and screenshots. ` +
    `The app is configured for this public origin; its local address (${url || "none printed"}) is only what pr-daemon's proxy forwards to, ` +
    `and the app breaks there because browsers block a public page from calling local addresses.` +
    (services.length ? ` Its services: ${services.map((n) => `${n} → ${serviceUrl(cfg, branch, n)}`).join(", ")}.` : "");
}

export const withNetworks = (existing: string | undefined, created: string[]): string =>
  [...new Set([...(existing ?? "").split(" ").filter(Boolean), ...created])].join(" ");

/** The last line that says something, for one-line event messages. */
const lastLine = (s: string) => s.trim().split("\n").filter((l) => l.trim()).pop()?.slice(0, 200) ?? "";

// ---------------------------------------------------------------- the agent step
/**
 * Run the agent once, under the budget. Usage is written to the ledger as it
 * streams; the moment a budget is exceeded the run is stopped and the job
 * pauses (its session resumes later). One automatic retry if it stalls.
 */
async function agentStep(ctx: Ctx, o: { prompt: string; log: string; resume?: string; issue: number; keepSession?: boolean }): Promise<string> {
  const { store, job } = ctx;
  const cfg = ctx.cfg();
  const g0 = gate(store, cfg, job.repo, o.issue);
  if (!g0.ok) throw new PauseError(g0.reason, g0.retryAt, g0.needsHuman);

  let resume = o.resume, promptText = o.prompt;
  type Stop = { reason: string; retryAt: number | null; needsHuman: boolean };
  for (let attempt = 1; ; attempt++) {
    let stop: Stop | null = null;
    const run = startAgent({
      cwd: ctx.current_wt ?? ".", prompt: promptText, logFile: o.log, resume,
      model: cfg.agent.model || undefined, maxTurns: cfg.agent.maxTurns, stallMs: cfg.agent.stallMs,
      onActivity: ctx.activity,
      onUsage: (d) => {
        store.addUsage(job, o.issue, d);
        const fresh = store.job(job.id)!;
        store.update(job.id, { tokens: fresh.tokens + count(d, ctx.cfg()) });
        const g = gate(store, ctx.cfg(), job.repo, o.issue);
        if (!g.ok && !stop) { stop = g; run.kill("budget"); }
      },
    });
    ctx.current = run;
    if (o.keepSession !== false) store.update(job.id, { session_id: run.sessionId });
    const { end, cost } = await run.done;
    ctx.current = null;
    store.update(job.id, { cost: (store.job(job.id)!.cost ?? 0) + cost });

    switch (end.kind) {
      case "ok": return end.result;
      case "killed":
        if (ctx.cancelled) throw new CancelError("cancelled");
        if (stop) { const p: Stop = stop; throw new PauseError(p.reason, p.retryAt, p.needsHuman); }
        throw new Error(`agent killed: ${end.why}`);
      case "rate_limited":
        throw new PauseError("Claude usage limit reached", end.resetAt ?? Date.now() + 30 * 60e3, false);
      case "stalled":
        if (attempt >= 2) throw new Error(`agent stalled twice (no output for ${Math.round(cfg.agent.stallMs / 60e3)}m)`);
        store.event("agent stalled; resuming its session once", job.id, "warn");
        resume = run.sessionId; promptText = "You stopped producing output. Continue the task from where you left off.";
        continue;
      case "error":
        throw new Error(`agent failed: ${end.result.slice(0, 1500)}`);
    }
  }
}

// ---------------------------------------------------------------- build
export async function build(ctx: Ctx): Promise<void> {
  const { store, job, repo } = ctx;
  const cfg = ctx.cfg();
  const n = job.number;
  const issue = await gh.issue(repo.name, n);
  if (issue.state !== "open") throw new FailError(`issue #${n} is closed`);
  const base = repo.base || (await gh.defaultBranch(repo.name));
  const resuming = !!job.session_id;

  await git.ensureClone(repo.name);
  await gh.ensureLabels(repo.name, cfg.label);
  const { branch, wt } = await git.ensureWorktree(repo.name, n, base, issue.title);
  ctx.current_wt = wt;
  store.update(job.id, { branch });
  const out = git.outDir(repo.name, branch);
  if (!resuming) rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "screenshots"), { recursive: true });

  await gh.setStatus(repo.name, n, cfg.label, "working");
  if (!resuming) await gh.comment(repo.name, n, `🛠️ **pr-daemon** is on it.\n- branch: \`${branch}\`\n- status: ${ctx.statusUrl} (on the pr-daemon machine)`);

  // Stack first. If it won't start, the agent's first job is to fix that.
  const pub = publicUrl(cfg, branch);
  const env = publicEnv(cfg, branch);
  const s = await stack.up(repo.up, wt, env);
  let url = s.ok ? s.url : "";
  store.upsertStack({ repo: repo.name, branch, issue: n, worktree: wt, url, healthy: s.ok ? 1 : 0, error: s.ok ? "" : s.error, ...routesOf(s),
    networks: withNetworks(store.stack(repo.name, branch)?.networks, s.networks), checked_at: Date.now() });
  if (!s.ok) store.event(`\`${repo.up}\` failed; the agent has been told to fix it first`, job.id, "warn");
  const stackNote = s.ok
    ? `The stack for this branch is already running at ${stackWhere(cfg, branch, s)} Restart it with \`${repo.up}\` (idempotent) if you change something it depends on.`
    : `WARNING: \`${repo.up}\` FAILED before you started. Fix that first, then continue. Output:\n\`\`\`\n${s.error}\n\`\`\``;

  const vars = {
    REPO: repo.name, BRANCH: branch, BASE: base, ISSUE_NUMBER: n, ISSUE_TITLE: issue.title, ISSUE_URL: issue.html_url,
    ISSUE_BODY: issue.body ?? "", OUT: out, PREVIEW_URL: stackWhere(cfg, branch, s), UP_CMD: repo.up, CHECK_CMD: repo.check || "(none)", STACK_NOTE: stackNote,
  };
  writeFileSync(join(out, "prompt-build.md"), prompt("build", vars));

  // Build → check → fix, until the project's own check passes. Fix rounds
  // resume the same session: the agent keeps its context (and the cache).
  let summary = await agentStep(ctx, resuming
    ? { prompt: "pr-daemon paused you (token budget or a restart). Continue the task from where you left off.", log: join(out, "agent-build.jsonl"), resume: job.session_id, issue: n }
    : { prompt: readFileSync(join(out, "prompt-build.md"), "utf8"), log: join(out, "agent-build.jsonl"), issue: n });

  // The agent may have changed what the stack needs — or fixed an `up` that
  // was broken when we started, which is exactly what it was asked to do.
  // `up` is idempotent by contract, so re-run it and keep the stack row, the
  // preview link and the screenshots honest.
  let down = !s.ok;
  const restartStack = async (): Promise<void> => {
    const r = await stack.up(repo.up, wt, env);
    url = r.ok ? r.url || url : "";
    vars.PREVIEW_URL = stackWhere(cfg, branch, r);
    store.upsertStack({ repo: repo.name, branch, issue: n, worktree: wt, url, healthy: r.ok ? 1 : 0, error: r.ok ? "" : r.error, ...routesOf(r),
      networks: withNetworks(store.stack(repo.name, branch)?.networks, r.networks), checked_at: Date.now() });
    if (r.ok && down) store.event(`the stack is up now${pub || url ? ` at ${pub || url}` : ""}`, job.id);
    if (!r.ok) store.event(`\`${repo.up}\` still fails: ${lastLine(r.error)}`, job.id, "warn");
    down = !r.ok;
  };
  await restartStack();

  let result = await stack.check(repo.check, wt);
  for (let attempt = 2; !result.ok && attempt <= cfg.agent.maxAttempts; attempt++) {
    store.event(`check failed; fix round ${attempt}`, job.id, "warn");
    summary = await agentStep(ctx, {
      prompt: prompt("fix", { ...vars, CHECK_OUT: result.output }),
      log: join(out, "agent-build.jsonl"), resume: store.job(job.id)!.session_id, issue: n,
    });
    await restartStack();
    result = await stack.check(repo.check, wt);
  }

  const untracked = await git.commitLeftovers(wt);
  if (untracked.length) store.event(`left untracked (not committed): ${untracked.join(" ")}`, job.id, "warn");
  if ((await git.commitsAhead(wt, base)) === 0) {
    await gh.setStatus(repo.name, n, cfg.label, "failed");
    await gh.comment(repo.name, n, `😶 **pr-daemon** finished without making any commits.\n\n<details><summary>agent summary</summary>\n\n${summary}\n</details>`);
    throw new FailError("no commits");
  }
  await git.push(wt, branch);
  if (!result.ok) {
    await gh.setStatus(repo.name, n, cfg.label, "failed");
    await gh.comment(repo.name, n, `❌ **pr-daemon** pushed \`${branch}\` but \`${repo.check}\` still fails after ${cfg.agent.maxAttempts} round(s). No PR opened.\n\`\`\`\n${result.output}\n\`\`\``);
    throw new FailError("check still failing");
  }

  const prNumber = await publishPr(ctx, { n, branch, base, url, pub, out, issueTitle: issue.title });
  store.update(job.id, { pr: prNumber });
  store.upsertStack({ repo: repo.name, branch, issue: n, worktree: wt, pr: prNumber, builder_session: store.job(job.id)!.session_id });
  await gh.setStatus(repo.name, n, cfg.label, "in-review");
  await gh.comment(repo.name, n, `✅ **pr-daemon** opened #${prNumber}. Preview: ${pub || url || "n/a"}`);
  store.enqueue({ repo: repo.name, kind: "review", number: prNumber, branch, trigger_key: `review:${repo.name}#${prNumber}:job${job.id}` });
}

async function publishPr(ctx: Ctx, o: { n: number; branch: string; base: string; url: string; pub: string; out: string; issueTitle: string }): Promise<number> {
  const { repo, store, job } = ctx;
  const read = (f: string) => (existsSync(join(o.out, f)) ? readFileSync(join(o.out, f), "utf8").trim() : "");
  const title = read("pr-title.txt").split("\n")[0] || o.issueTitle;
  const shots = await uploadShots(ctx, o.branch, o.out);
  const tokens = store.job(job.id)!.tokens;
  const body = `${read("pr-body.md") || "_The agent wrote no description._"}

## Try it

${o.pub ? `- **Preview:** ${o.pub}` : `- **Preview:** ${o.url || "_not running_"} (on the pr-daemon machine)`}
- Branch: \`${o.branch}\` · ask for changes with a PR comment starting with \`/pr-daemon\`
${shots ? `\n## Screenshots\n\n${shots}` : ""}
Closes #${o.n}

---
<sub>🤖 Built by [pr-daemon](https://github.com/dionjwa/pr-daemon) · ${(tokens / 1e6).toFixed(2)}M tokens. A human must approve before merge.</sub>`;
  writeFileSync(join(o.out, "pr-final.md"), body);
  const existing = await gh.openPrForBranch(repo.name, o.branch);
  if (existing) { await gh.editPr(repo.name, existing, { title, bodyFile: join(o.out, "pr-final.md") }); return existing; }
  return gh.createPr(repo.name, { base: o.base, head: o.branch, title, bodyFile: join(o.out, "pr-final.md") });
}

async function uploadShots(ctx: Ctx, branch: string, out: string): Promise<string> {
  const dir = join(out, "screenshots");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => join(dir, f)) : [];
  try { return await git.uploadScreenshots(ctx.repo.name, branch, files); }
  catch (e) { ctx.store.event(`screenshot upload failed: ${(e as Error).message}`, ctx.job.id, "warn"); return ""; }
}

// ---------------------------------------------------------------- review
// A fresh agent with no build context: it sees only the PR and the code.
export async function review(ctx: Ctx): Promise<void> {
  const { store, job, repo } = ctx;
  const cfg = ctx.cfg();
  const p = await gh.pr(repo.name, job.number);
  if (p.state !== "open") return;
  const n = issueOf(p.head.ref);
  await git.ensureClone(repo.name);
  const { branch, wt } = await git.ensureWorktree(repo.name, n, p.base.ref);
  ctx.current_wt = wt;
  const out = join(git.outDir(repo.name, branch), `review-${job.id}`);
  mkdirSync(out, { recursive: true });
  const text = job.session_id
    ? "pr-daemon paused you. Continue the review from where you left off."
    : prompt("review", { PR_NUMBER: job.number, REPO: repo.name, OUT: out, CHECK_CMD: repo.check || "(none)" });
  await agentStep(ctx, { prompt: text, log: join(out, "agent.jsonl"), resume: job.session_id || undefined, issue: n });
  const file = join(out, "review.md");
  if (!existsSync(file)) { store.event("reviewer wrote no review.md", job.id, "warn"); return; }
  await gh.review(repo.name, job.number, file);
  const reviewText = readFileSync(file, "utf8");
  if (cfg.agent.autoRevise && !payload(job).fromReview && /^VERDICT:\s*changes/im.test(reviewText)) {
    store.event("reviewer asked for changes: one automatic revise round", job.id);
    store.enqueue({ repo: repo.name, kind: "revise", number: job.number, branch, trigger_key: `revise-from-review:job${job.id}`, payload: { feedback: reviewText, fromReview: true } });
  }
}

// ---------------------------------------------------------------- revise
// The builder (same Claude session, when we have it) addresses feedback.
export async function revise(ctx: Ctx): Promise<void> {
  const { store, job, repo } = ctx;
  const p = await gh.pr(repo.name, job.number);
  if (p.state !== "open") return;
  const n = issueOf(p.head.ref);
  await git.ensureClone(repo.name);
  const { branch, wt } = await git.ensureWorktree(repo.name, n, p.base.ref);
  ctx.current_wt = wt;
  const out = git.outDir(repo.name, branch);
  const shotsDir = join(out, "screenshots");
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const s = await stack.up(repo.up, wt, publicEnv(ctx.cfg(), branch));
  const url = s.ok ? s.url : "";
  store.upsertStack({ repo: repo.name, branch, issue: n, worktree: wt, url, pr: job.number, healthy: s.ok ? 1 : 0, error: s.ok ? "" : s.error, ...routesOf(s),
    networks: withNetworks(store.stack(repo.name, branch)?.networks, s.networks), checked_at: Date.now() });
  const builder = store.stack(repo.name, branch)?.builder_session || "";

  const text = prompt("revise", {
    PR_NUMBER: job.number, ISSUE_NUMBER: n, REPO: repo.name, BRANCH: branch, OUT: out, PREVIEW_URL: stackWhere(ctx.cfg(), branch, s),
    FEEDBACK: payload(job).feedback ?? "", UP_CMD: repo.up, CHECK_CMD: repo.check || "(none)",
  });
  const summary = await agentStep(ctx, job.session_id
    ? { prompt: "pr-daemon paused you. Continue addressing the feedback from where you left off.", log: join(out, `agent-revise-${job.id}.jsonl`), resume: job.session_id, issue: n }
    : { prompt: text, log: join(out, `agent-revise-${job.id}.jsonl`), resume: builder || undefined, issue: n });

  await git.commitLeftovers(wt);
  const result = await stack.check(repo.check, wt);
  await git.push(wt, branch);
  const shots = await uploadShots(ctx, branch, out);
  await gh.comment(repo.name, job.number, `🔁 **pr-daemon** revised this PR. ${result.ok ? "✅ checks pass" : `❌ \`${repo.check}\` fails:\n\`\`\`\n${result.output}\n\`\`\``}

${summary}
${shots ? `\n### Updated screenshots\n\n${shots}` : ""}`);
}

// ---------------------------------------------------------------- teardown / restart
export async function teardown(ctx: Ctx): Promise<void> {
  const { store, job, repo } = ctx;
  const s = store.stackForIssue(repo.name, job.number);
  const wt = s?.worktree ?? git.findWorktree(repo.name, job.number);
  if (!wt) { store.event(`no stack for #${job.number}`, job.id); return; }
  const branch = s?.branch ?? wt.split("/").pop()!;
  if (existsSync(wt)) {
    const d = await stack.down(repo.down, wt);
    if (!d.ok) store.event(`down failed (continuing): ${d.output}`, job.id, "warn");
    await git.removeWorktree(repo.name, wt, branch);
  }
  // Whatever `down` left behind: the networks this stack's `up` created, but
  // only the ones nothing is attached to. Docker's address pool is small, and
  // a route that skips `down` (no worktree, no down command) would otherwise
  // leak two networks per preview until every later `up` fails.
  const left = await stack.removeNetworks((s?.networks ?? "").split(" ").filter(Boolean));
  if (left.length) store.event(`removed ${left.length} docker network(s) this stack created: ${left.join(", ")}`, job.id);
  rmSync(git.outDir(repo.name, branch), { recursive: true, force: true });
  store.deleteStack(repo.name, branch);
  await gh.setStatus(repo.name, job.number, ctx.cfg().label, null);
}

export async function restart(ctx: Ctx): Promise<void> {
  const { store, job, repo } = ctx;
  const s = store.stackForIssue(repo.name, job.number);
  if (!s) return;
  // A row whose worktree is gone can never come back: say so on the row
  // instead of finishing instantly and looking like nothing happened.
  if (!existsSync(s.worktree)) {
    store.upsertStack({ repo: repo.name, branch: s.branch, issue: s.issue, worktree: s.worktree, healthy: 0,
      error: `the worktree is gone (${s.worktree}); tear this down`, checked_at: Date.now() });
    throw new FailError(`the worktree ${s.worktree} no longer exists`);
  }
  const r = await stack.up(repo.up, s.worktree, publicEnv(ctx.cfg(), s.branch));
  store.upsertStack({ repo: repo.name, branch: s.branch, issue: s.issue, worktree: s.worktree, url: r.ok ? r.url || s.url : s.url, ...routesOf(r),
    healthy: r.ok ? 1 : 0, error: r.ok ? "" : r.error, networks: withNetworks(s.networks, r.networks), checked_at: Date.now() });
  if (!r.ok) throw new Error(`restart failed: ${r.error}`);
}

export const JOBS = { build, review, revise, teardown, restart } as const;
