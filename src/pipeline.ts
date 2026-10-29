// The work itself: build, review, revise, ci, merge, teardown, restart.
// Each function runs one job end to end and is safe to re-run after a pause
// or crash: worktrees, stacks and PRs are found and reused, and the agent's
// Claude session is resumed rather than restarted.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startAgent, type AgentRun } from "./agent.ts";
import { count, gate } from "./budget.ts";
import type { Config, NoticeKind, RepoConfig } from "./config.ts";
import type { Job, Store } from "./db.ts";
import * as gh from "./gh.ts";
import * as git from "./git.ts";
import { assessConflicts, hasConflictMarkers, parseMergeReport, reviewReasons } from "./merge.ts";
import { publicEnv, publicUrl, serviceUrl } from "./proxy.ts";
import * as stack from "./stack.ts";
import { tail, unnotify } from "./util.ts";

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
  /** pr-daemon is shutting down: start no more agent runs (the job resumes on the next start). */
  halted?: boolean;
  activity: (line: string) => void;
  statusUrl: string;
  /** The worktree the agent runs in (set by each job once it has one). */
  current_wt?: string;
  /**
   * What to tell the person if this job is the last in its chain: set by a
   * job that finished something worth looking at. The daemon sends it only
   * when no other work is coming on the branch (build → review → revise is
   * one notice), and always when the job fails, using this if it was set.
   */
  notice?: { kind: NoticeKind; level: "ok" | "warn" | "bad"; title: string; body: string; url: string };
}

/** Fill {{NAME}} from vars in one left-to-right pass (substituted text is never re-scanned). */
export function render(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, k) => String(vars[k] ?? ""));
}
const prompt = (name: string, vars: Record<string, string | number | undefined>) =>
  render(readFileSync(join(PROMPTS, `${name}.md`), "utf8"), vars);

interface Payload {
  feedback?: string; fromReview?: boolean; commentId?: number; deleteBranch?: boolean; closePr?: boolean; why?: string; sha?: string; failing?: string;
  /** merge: what the merge started from, saved so a paused job resumes the same merge. */
  merge?: { before: string; baseSha: string; mergeBase: string; conflicts: git.Conflict[]; cautions: string[] };
}
function payload(job: Job): Payload {
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

/**
 * A PR comment reporting finished work, with the preview on its first line
 * (and again at the end of a long one), so the reviewer can go straight to it.
 * The public address when there is one, else the stack's local one.
 */
function withPreview(ctx: Ctx, branch: string, body: string): string {
  const url = publicUrl(ctx.cfg(), branch) || ctx.store.stack(ctx.repo.name, branch)?.url;
  if (!url) return body;
  const line = `🔗 Preview: ${url}`;
  const text = `${line}\n\n${body.trim()}`;
  return text.split("\n").length > 25 ? `${text}\n\n${line}` : text;
}

/**
 * Tells the agent `up` failed. The full output can be huge (container log
 * dumps), so it goes in a file and the prompt gets only its end.
 */
function upFailedNote(cmd: string, output: string, out: string): string {
  const file = join(out, "up-failed.log");
  writeFileSync(file, output);
  return `WARNING: \`${cmd}\` FAILED before you started. Fix that first, then continue. The full output is in ${file}; it ends:\n\`\`\`\n${tail(output, 80)}\n\`\`\``;
}

/** Where an agent job's stream-json log is written (null for jobs without an agent). */
export function agentLog(job: Pick<Job, "id" | "kind" | "repo" | "branch">): string | null {
  if (!job.branch) return null;
  const out = git.outDir(job.repo, job.branch);
  if (job.kind === "build") return join(out, "agent-build.jsonl");
  if (job.kind === "review") return join(out, `review-${job.id}`, "agent.jsonl");
  if (job.kind === "revise") return join(out, `agent-revise-${job.id}.jsonl`);
  if (job.kind === "ci") return join(out, `agent-ci-${job.id}.jsonl`);
  if (job.kind === "merge") return join(out, `agent-merge-${job.id}.jsonl`);
  return null;
}

// ---------------------------------------------------------------- the agent step
/**
 * Run the agent once, under the budget. Usage is written to the ledger as it
 * streams; the moment a budget is exceeded the run is stopped and the job
 * pauses (its session resumes later). One automatic retry if it stalls.
 * `fresh` is the full prompt to start a new session with when the one to
 * resume no longer exists: resuming only saves context and cache, so a lost
 * transcript must never be what fails the job.
 */
export async function agentStep(ctx: Ctx, o: { prompt: string; log: string; resume?: string; fresh?: string; issue: number; keepSession?: boolean }): Promise<string> {
  const { store, job } = ctx;
  const cfg = ctx.cfg();
  const g0 = gate(store, cfg, job.repo, o.issue);
  if (!g0.ok) throw new PauseError(g0.reason, g0.retryAt, g0.needsHuman);

  let resume = o.resume, promptText = o.prompt;
  type Stop = { reason: string; retryAt: number | null; needsHuman: boolean };
  for (let attempt = 1; ; attempt++) {
    if (ctx.halted) throw new Error("pr-daemon is shutting down");
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
        if (resume && o.fresh && /No conversation found with session ID/i.test(end.result)) {
          store.event(`Claude session ${resume} no longer exists; starting a fresh one`, job.id, "warn");
          resume = undefined; promptText = o.fresh;
          continue;
        }
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
  // Checked when the label was added, and again now: the text may have been edited since.
  const strangers = gh.untrustedWriters(await gh.provenance(repo.name, n), await gh.trustedAuthors(cfg.allowedUsers));
  if (strangers.length) {
    const why = gh.untrustedIssue(strangers);
    await gh.comment(repo.name, n, `🚫 **pr-daemon** stopped: ${why}. ${gh.UNTRUSTED_HELP}`);
    throw new FailError(why);
  }
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
    : upFailedNote(repo.up, s.error, out);

  const vars = {
    REPO: repo.name, BRANCH: branch, BASE: base, ISSUE_NUMBER: n, ISSUE_TITLE: issue.title, ISSUE_URL: issue.html_url,
    ISSUE_BODY: issue.body ?? "", OUT: out, PREVIEW_URL: stackWhere(cfg, branch, s), UP_CMD: repo.up, CHECK_CMD: repo.check || "(none)", STACK_NOTE: stackNote,
  };
  writeFileSync(join(out, "prompt-build.md"), prompt("build", vars));

  // Build → check → fix, until the project's own check passes. Fix rounds
  // resume the same session: the agent keeps its context (and the cache).
  let summary = await agentStep(ctx, resuming
    ? { prompt: "pr-daemon paused you (token budget or a restart). Continue the task from where you left off.", log: agentLog({ ...job, branch })!, resume: job.session_id, fresh: prompt("build", vars), issue: n }
    : { prompt: prompt("build", vars), log: agentLog({ ...job, branch })!, issue: n });

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
      log: agentLog({ ...job, branch })!, resume: store.job(job.id)!.session_id, issue: n,
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
  ctx.notice = { kind: "ready", level: "ok", title: `✅ PR ready: ${repo.name} #${prNumber}`, body: issue.title, url: `https://github.com/${repo.name}/pull/${prNumber}` };
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
- Branch: \`${o.branch}\` · ask for changes with a PR comment starting with \`/pr-daemon\` or 😈
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
  // The repo's own CI, as it stands right now: usually still running this
  // soon after the push, which is itself worth telling the reviewer.
  const c = cfg.checks.watch ? await gh.checks(repo.name, p.head.sha).catch(() => null) : null;
  const full = prompt("review", { PR_NUMBER: job.number, REPO: repo.name, OUT: out, CHECK_CMD: repo.check || "(none)",
    CHECKS: c ? `${c.state} (${c.summary})` : "not known" });
  const text = job.session_id ? "pr-daemon paused you. Continue the review from where you left off." : full;
  await agentStep(ctx, { prompt: text, log: agentLog({ ...job, branch })!, resume: job.session_id || undefined, fresh: full, issue: n });
  const file = join(out, "review.md");
  if (!existsSync(file)) { store.event("reviewer wrote no review.md", job.id, "warn"); return; }
  await gh.review(repo.name, job.number, file);
  const reviewText = readFileSync(file, "utf8");
  const verdict = /^VERDICT:\s*(\w+)/im.exec(reviewText)?.[1].toLowerCase() || "commented";
  ctx.notice = { kind: "ready", level: verdict === "changes" ? "warn" : "ok", title: `✅ PR ready: ${repo.name} #${job.number}`,
    body: `${p.title} · review: ${verdict}`, url: p.html_url };
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
  // 😈 on the /pr-daemon comment: seen, and being worked on. Cosmetic, so a
  // failure (the comment was deleted, no rights to edit it) is only logged.
  const commentId = payload(job).commentId;
  if (commentId) await gh.markComment(repo.name, commentId, "😈")
    .catch((e) => store.event(`couldn't mark comment ${commentId}: ${(e as Error).message}`, job.id, "warn"));
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

  // Only words from trusted users reach the agent, never the whole thread.
  const talk = await gh.trustedDiscussion(repo.name, job.number, await gh.trustedAuthors(ctx.cfg().allowedUsers), payload(job).commentId);
  if (talk.dropped) store.event(`left ${talk.dropped} PR comment(s) from people not in allowed_users out of the prompt`, job.id);
  const text = prompt("revise", {
    PR_NUMBER: job.number, ISSUE_NUMBER: n, REPO: repo.name, BRANCH: branch, OUT: out, PREVIEW_URL: stackWhere(ctx.cfg(), branch, s),
    FEEDBACK: payload(job).feedback ?? "", DISCUSSION: talk.text || "(none)", UP_CMD: repo.up, CHECK_CMD: repo.check || "(none)",
  });
  const summary = await agentStep(ctx, job.session_id
    ? { prompt: "pr-daemon paused you. Continue addressing the feedback from where you left off.", log: agentLog({ ...job, branch })!, resume: job.session_id, fresh: text, issue: n }
    : { prompt: text, log: agentLog({ ...job, branch })!, resume: builder || undefined, fresh: text, issue: n });
  // The session that now holds this branch's context: the builder's, or a fresh one if that was lost.
  store.upsertStack({ repo: repo.name, branch, issue: n, worktree: wt, builder_session: store.job(job.id)!.session_id });

  await git.commitLeftovers(wt);
  const result = await stack.check(repo.check, wt);
  await git.push(wt, branch);
  const shots = await uploadShots(ctx, branch, out);
  const checked = result.skipped ? "" : result.ok ? " · check passes" : ` · \`${repo.check}\` fails`;
  ctx.notice = payload(job).fromReview
    ? { kind: "ready", level: result.ok ? "ok" : "warn", title: `✅ PR ready: ${repo.name} #${job.number}`, body: `${p.title} · revised after review${checked}`, url: p.html_url }
    : { kind: "revised", level: result.ok ? "ok" : "warn", title: `🔁 Revised: ${repo.name} #${job.number}`, body: `${p.title}${checked}`, url: p.html_url };
  await gh.comment(repo.name, job.number, withPreview(ctx, branch, `🔁 **pr-daemon** revised this PR. ${result.ok ? "✅ checks pass" : `❌ \`${repo.check}\` fails:\n\`\`\`\n${result.output}\n\`\`\``}

${summary}
${shots ? `\n### Updated screenshots\n\n${shots}` : ""}`));
}

// ---------------------------------------------------------------- ci
/**
 * The project's own CI went red on a commit pr-daemon pushed. Same shape as a
 * revise, with GitHub's failure as the feedback: the builder's session (when
 * we still have it) gets the failing check names and the tail of their logs,
 * fixes the cause, and the push makes CI run again on the new commit.
 *
 * The daemon queues at most one of these per head commit, and `checks.max_rounds`
 * per PR, so a fix that doesn't fix it can't loop.
 */
export async function ci(ctx: Ctx): Promise<void> {
  const { store, job, repo } = ctx;
  const cfg = ctx.cfg();
  const p = await gh.pr(repo.name, job.number);
  if (p.state !== "open") { store.event(`PR #${job.number} is closed; nothing to fix`, job.id); return; }
  const n = issueOf(p.head.ref);
  await git.ensureClone(repo.name);
  const { branch, wt } = await git.ensureWorktree(repo.name, n, p.base.ref);
  ctx.current_wt = wt;
  store.update(job.id, { branch, pr: job.number });
  const out = git.outDir(repo.name, branch);
  mkdirSync(out, { recursive: true });

  // Ask GitHub again: the run may have been re-run, or a later push may have
  // fixed it while this job sat in the queue.
  const sha = payload(job).sha || p.head.sha;
  const c = await gh.checks(repo.name, sha);
  if (c.state !== "failure") { store.event(`checks for ${sha.slice(0, 7)} are "${c.state}" now (${c.summary}); nothing to fix`, job.id); return; }
  const logs = await gh.failureLogs(repo.name, sha);

  const s = await stack.up(repo.up, wt, publicEnv(cfg, branch));
  store.upsertStack({ repo: repo.name, branch, issue: n, worktree: wt, url: s.ok ? s.url : "", pr: job.number,
    healthy: s.ok ? 1 : 0, error: s.ok ? "" : s.error, ...routesOf(s),
    networks: withNetworks(store.stack(repo.name, branch)?.networks, s.networks), checked_at: Date.now() });

  const text = prompt("ci", {
    PR_NUMBER: job.number, ISSUE_NUMBER: n, REPO: repo.name, BRANCH: branch, OUT: out, SHA: sha,
    PREVIEW_URL: stackWhere(cfg, branch, s), UP_CMD: repo.up, CHECK_CMD: repo.check || "(none)",
    FAILING: c.failing.map((f) => `- **${f.name}**${f.note ? `: ${f.note}` : ""}${f.url ? ` (${f.url})` : ""}`).join("\n"),
    LOGS: logs || "(no logs available: these checks aren't GitHub Actions, so use their names, notes and links above)",
  });
  writeFileSync(join(out, `prompt-ci-${job.id}.md`), text);

  const before = await git.head(wt);
  const builder = store.stack(repo.name, branch)?.builder_session || "";
  const summary = await agentStep(ctx, job.session_id
    ? { prompt: "pr-daemon paused you. Continue fixing the failing checks from where you left off.", log: agentLog({ ...job, branch })!, resume: job.session_id, fresh: text, issue: n }
    : { prompt: text, log: agentLog({ ...job, branch })!, resume: builder || undefined, fresh: text, issue: n });
  store.upsertStack({ repo: repo.name, branch, issue: n, worktree: wt, builder_session: store.job(job.id)!.session_id });

  await git.commitLeftovers(wt);
  if ((await git.head(wt)) === before) {
    // Nothing changed, so pushing would not make CI run again. Say so on the
    // PR instead of pretending a fix went out.
    await gh.comment(repo.name, job.number, withPreview(ctx, branch, `🧪 **pr-daemon** looked at the failing checks (${c.summary}) and made no change:\n\n${summary}`));
    store.event("the agent changed nothing; not pushing", job.id, "warn");
    ctx.notice = { kind: "ci", level: "warn", title: `🧪 CI still red: ${repo.name} #${job.number}`, body: `${c.summary} · the agent made no change`, url: p.html_url };
    return;
  }
  const local = await stack.check(repo.check, wt);
  await git.push(wt, branch);
  const shots = await uploadShots(ctx, branch, out);
  ctx.notice = { kind: "ci", level: local.ok || local.skipped ? "ok" : "warn", title: `🧪 CI fix pushed: ${repo.name} #${job.number}`,
    body: `${p.title} · was failing: ${c.summary}`, url: p.html_url };
  await gh.comment(repo.name, job.number, withPreview(ctx, branch, `🧪 **pr-daemon** pushed a fix for the failing checks (${c.summary}). GitHub will re-run them.
${repo.check && !local.skipped ? `\nLocally, \`${repo.check}\` ${local.ok ? "passes ✅" : `still FAILS ❌:\n\`\`\`\n${local.output}\n\`\`\``}\n` : ""}
${summary}
${shots ? `\n### Updated screenshots\n\n${shots}` : ""}`));
}

// ---------------------------------------------------------------- merge
/**
 * The PR stopped merging into its base (or, with `merge.behind`, the base
 * merely moved on, or, with `merge.catch_up`, it moved on under a PR that's
 * idle and not red). Merge the base in: never a rebase, never a force-push.
 *
 * Automate the routine, hand the risky to a human:
 * - a clean merge is committed, checked and pushed with no agent;
 * - conflicts go to an agent only when assessConflicts() finds nothing that
 *   should be a person's call (binary files, workflow files, too many files,
 *   `merge.human_paths`, the round cap);
 * - pr-daemon, not the agent, verifies and commits the merge: still the merge
 *   it started, no markers left, nothing unmerged;
 * - the check must pass (with `agent.max_attempts` fix rounds) before
 *   anything is pushed. Otherwise the attempt is kept on a local branch, the
 *   PR is left as it was, and the human is told;
 * - a resolution that is pushed but uncertain (low confidence, flags, a
 *   deleted-vs-changed file, edits outside the conflicts) is marked "needs
 *   your review" on the PR, the status page and the desktop.
 */
export async function merge(ctx: Ctx): Promise<void> {
  const { store, job, repo } = ctx;
  const cfg = ctx.cfg();
  const p = await gh.pr(repo.name, job.number);
  if (p.state !== "open") { store.event(`PR #${job.number} is closed; nothing to merge`, job.id); return; }
  const n = issueOf(p.head.ref);
  const base = p.base.ref;
  await git.ensureClone(repo.name);
  const { branch, wt } = await git.ensureWorktree(repo.name, n, base);
  ctx.current_wt = wt;
  store.update(job.id, { branch, pr: job.number });
  const out = git.outDir(repo.name, branch);
  mkdirSync(out, { recursive: true });
  const reportFile = join(out, "merge-report.md");

  const note = (level: "ok" | "warn" | "bad", text: string) => store.upsertStack({ repo: repo.name, branch, issue: n, worktree: wt,
    merge_note: text.slice(0, 500), merge_level: level, merge_at: Date.now() });
  /** Leave the PR exactly as it was and give it to a person, saying why and how. */
  const handOver = async (headline: string, reasons: string[], o: { before?: string; keep?: boolean; conflicts?: git.Conflict[] } = {}): Promise<never> => {
    let kept = "";
    if (o.before) {
      if (o.keep) { kept = `${branch}-merge-attempt-${job.id}`; await git.keepAttempt(wt, kept).catch(() => { kept = ""; }); }
      await git.abortMerge(wt, o.before);
    }
    if (kept) store.event(`kept the attempt as local branch ${kept} (git -C ${wt} log ${kept})`, job.id, "warn");
    note("bad", `${headline}: ${reasons.join("; ")}`);
    await gh.setStatus(repo.name, n, cfg.label, "failed").catch(() => {});
    await gh.comment(repo.name, job.number, `🔀 **pr-daemon** didn't merge \`${base}\` into this branch: ${headline}. **This one is yours.**

${reasons.map((r) => `- ${r}`).join("\n")}
${o.conflicts?.length ? `\nConflicted files:\n${conflictTable(o.conflicts)}\n` : ""}${kept ? `\nIts attempt is kept on the pr-daemon machine as the local branch \`${kept}\`; the PR is unchanged.\n` : ""}
To do it yourself: \`git fetch origin && git checkout ${branch} && git merge origin/${base}\`, resolve, commit and push. Or comment \`/pr-daemon <how to resolve it>\` to have the agent try with your guidance.`);
    ctx.notice = { kind: "merge", level: "bad", title: `🔀 Merge needs you: ${repo.name} #${job.number}`, body: headline, url: p.html_url };
    throw new FailError(`${headline}: ${reasons.join("; ")}`.slice(0, 1500));
  };

  // 1. Start the merge, or pick it up again after a pause.
  const saved = payload(job).merge;
  const resuming = !!job.session_id && !!saved && (await git.mergeInProgress(wt));
  let before: string, m: git.MergeStart, cautions: string[] = [];
  if (resuming) {
    before = saved.before;
    m = { upToDate: false, clean: false, baseSha: saved.baseSha, mergeBase: saved.mergeBase, conflicts: saved.conflicts, output: "" };
    cautions = saved.cautions;
  } else {
    if (await git.mergeInProgress(wt)) await git.abortMerge(wt, "HEAD");   // left over from an interrupted run
    if (job.session_id) store.update(job.id, { session_id: "" });          // that session's merge is gone: start clean
    // This job stopped after committing its merge but before pushing it (a
    // pause or restart during the check): start over from the PR's head.
    const here = await git.head(wt);
    if (saved && saved.before === p.head.sha && here !== p.head.sha && (await git.isAncestor(wt, saved.before, here))) {
      await git.keepAttempt(wt, `${branch}-merge-attempt-${job.id}`).catch(() => {});
      await git.abortMerge(wt, saved.before);
      store.event(`an earlier run of this merge stopped before pushing; starting it again from ${saved.before.slice(0, 7)}`, job.id, "warn");
    }
    before = await git.head(wt);
    // The worktree must be exactly the PR: a merge on top of anything else
    // would push commits nobody asked for.
    if (before !== p.head.sha) await handOver("the worktree isn't at the PR's head", [
      `the worktree is at ${before.slice(0, 7)}, the PR at ${p.head.sha.slice(0, 7)}: someone else pushed, or there are local commits that never went up`]);
    if (!(await git.isClean(wt))) await handOver("the worktree has uncommitted changes", [`tracked files in ${branch}'s worktree are modified; pr-daemon won't merge over them`]);
    rmSync(reportFile, { force: true });
    m = await git.startMerge(wt, base, branch);
    if (m.upToDate) {
      note("ok", `already up to date with ${base}`);
      store.event(`${branch} already contains ${base} (${m.baseSha.slice(0, 7)}); nothing to merge`, job.id);
      return;
    }
    store.update(job.id, { payload: JSON.stringify({ ...payload(job), merge: { before, baseSha: m.baseSha, mergeBase: m.mergeBase, conflicts: m.conflicts, cautions: [] } }) });
  }
  const workflowFiles = await git.changedFiles(wt, m.mergeBase, m.baseSha, ".github/workflows");
  const canPushWorkflows = workflowFiles.length === 0 || (await gh.hasWorkflowScope());

  // 2a. No conflicts. If the merge would carry workflow changes the gh login
  //     can't push, let GitHub do the same merge itself ("Update branch").
  if (m.clean && !canPushWorkflows) {
    await git.abortMerge(wt, before);
    return viaGitHub(ctx, { before, base, branch, wt, n, note, handOver, why: `${base} changed ${workflowFiles.join(", ")}` });
  }

  // 2b. Conflicts: is this an agent's to resolve?
  let report = "";
  if (!m.clean) {
    const a = assessConflicts(m.conflicts, { maxFiles: cfg.merge.maxFiles, humanPaths: cfg.merge.humanPaths, workflowsBlocked: !canPushWorkflows });
    cautions = a.cautions;
    const blockers = [...a.blockers];
    if (!resuming) {
      if (!cfg.merge.fix) blockers.push("`merge.fix` is off");
      const used = store.countAgentRuns(repo.name, "merge", job.number, job.id);
      if (used >= cfg.merge.maxRounds) blockers.push(`${used} conflict-resolution round(s) already used on this PR (\`merge.max_rounds = ${cfg.merge.maxRounds}\`)`);
    }
    if (blockers.length) await handOver(`${m.conflicts.length} conflict(s) that need a person`, blockers, { before, conflicts: m.conflicts });

    store.update(job.id, { payload: JSON.stringify({ ...payload(job), merge: { before, baseSha: m.baseSha, mergeBase: m.mergeBase, conflicts: m.conflicts, cautions } }) });
    note("warn", `resolving ${m.conflicts.length} conflict(s) with ${base}`);
    store.event(`${m.conflicts.length} conflict(s) merging ${base} into ${branch}: ${m.conflicts.map((c) => c.path).join(", ")}`.slice(0, 500), job.id, "warn");
    const text = prompt("merge", {
      PR_NUMBER: job.number, ISSUE_NUMBER: n, REPO: repo.name, BRANCH: branch, BASE: base, BASE_SHA: m.baseSha, MERGE_BASE: m.mergeBase, OUT: out,
      CHECK_CMD: repo.check || "(none: build and test it the way the project's CLAUDE.md says)",
      CONFLICTS: m.conflicts.map((c) => `- \`${c.path}\`: ${c.kind}`).join("\n"),
      BASE_LOG: (await git.baseLog(wt, m.mergeBase, m.baseSha, m.conflicts.map((c) => c.path))) || "(none found)",
    });
    writeFileSync(join(out, `prompt-merge-${job.id}.md`), text);
    const builder = store.stack(repo.name, branch)?.builder_session || "";
    await agentStep(ctx, resuming
      ? { prompt: "pr-daemon paused you. Continue resolving the merge from where you left off.", log: agentLog({ ...job, branch })!, resume: job.session_id, issue: n }
      : { prompt: text, log: agentLog({ ...job, branch })!, resume: builder || undefined, issue: n });

    // Verify, don't trust: the same merge, every conflict gone, then commit it ourselves.
    const problems = await verifyResolution(wt, before, m);
    if (problems.length) await handOver("the agent's resolution didn't hold up", problems, { before, keep: true, conflicts: m.conflicts });
    if (await git.mergeInProgress(wt)) {
      try { await git.commitMerge(wt); }
      catch (e) { await handOver("the resolved merge wouldn't commit", [(e as Error).message.slice(0, 600)], { before, keep: true, conflicts: m.conflicts }); }
    } else store.event("the agent committed the merge itself (it was asked not to); its parents are right, so keeping it", job.id, "warn");
    report = existsSync(reportFile) ? readFileSync(reportFile, "utf8").trim() : "";
  }
  const mergeCommit = await git.head(wt);

  // 3. The stack and the check run on the merged code. A clean merge can still
  //    break the build (the base renamed something this branch uses), so a
  //    failing check gets the same fix rounds as a build, under the same caps.
  const s = await stack.up(repo.up, wt, publicEnv(cfg, branch));
  store.upsertStack({ repo: repo.name, branch, issue: n, worktree: wt, url: s.ok ? s.url || store.stack(repo.name, branch)?.url || "" : "", pr: job.number,
    healthy: s.ok ? 1 : 0, error: s.ok ? "" : s.error, ...routesOf(s),
    networks: withNetworks(store.stack(repo.name, branch)?.networks, s.networks), checked_at: Date.now() });
  let local = await stack.check(repo.check, wt);
  for (let round = 1; !local.ok && round < cfg.agent.maxAttempts; round++) {
    if (!cfg.merge.fix) break;
    if (!store.job(job.id)!.session_id && store.countAgentRuns(repo.name, "merge", job.number, job.id) >= cfg.merge.maxRounds) break;
    store.event(`\`${repo.check}\` fails after merging ${base}; fix round ${round}`, job.id, "warn");
    const fix = `pr-daemon merged \`${base}\` into \`${branch}\` (the merge commit is ${mergeCommit.slice(0, 7)}), and now \`${repo.check}\` FAILS:\n\n\`\`\`\n${local.output}\n\`\`\`\n\n` +
      `Fix the cause: usually something this branch uses changed shape in ${base}. Don't undo the base's changes, weaken tests or touch .github/workflows/. ` +
      `Commit the fix on top (don't amend, reset or rebase; the merge commit stays). Do NOT push. ` +
      `${report || !m.clean ? `Then update ${reportFile}, keeping its CONFIDENCE and NEEDS_HUMAN lines at the end.` : `Then write ${reportFile}: what broke and what you changed, ending with the lines \`CONFIDENCE: high|low\` and \`NEEDS_HUMAN: none\` (or a bullet list).`} Finish with a two-line summary.`;
    const session = store.job(job.id)!.session_id;
    await agentStep(ctx, { prompt: fix, log: agentLog({ ...job, branch })!, resume: session || store.stack(repo.name, branch)?.builder_session || undefined, issue: n });
    await git.commitLeftovers(wt);
    if (!(await git.isAncestor(wt, mergeCommit, "HEAD"))) await handOver("the agent rewrote the merge", ["the merge commit is no longer in the branch's history (reset, amend or rebase)"], { before, keep: true });
    report = existsSync(reportFile) ? readFileSync(reportFile, "utf8").trim() : report;
    local = await stack.check(repo.check, wt);
  }
  if (!local.ok) await handOver(`\`${repo.check}\` fails on the merged code`, [
    m.clean ? `the merge had no conflicts, but the merged code doesn't pass` : `the conflicts were resolved, but the merged code doesn't pass`,
    `it ends:\n\n\`\`\`\n${tail(local.output, 30)}\n\`\`\``], { before, keep: true, conflicts: m.conflicts });

  // 4. Push. A workflow-scope refusal is the one push failure with a way round, for a clean merge.
  try { await git.push(wt, branch); }
  catch (e) {
    const msg = (e as Error).message;
    if (!/workflow/.test(msg)) throw e;
    if (m.clean && (await git.head(wt)) === mergeCommit) {
      await git.abortMerge(wt, before);
      return viaGitHub(ctx, { before, base, branch, wt, n, note, handOver, why: msg });
    }
    await handOver("GitHub refused the merge commit", [msg], { before, keep: true, conflicts: m.conflicts });
  }

  // 5. Say what happened, and how sure to be.
  const head = await git.head(wt);
  // Files only the agent touched: changed since the PR's head, but by neither
  // the base nor a conflict. Often right (a caller of something the base
  // renamed), always worth a look.
  const baseFiles = new Set(m.clean ? [] : await git.changedFiles(wt, m.mergeBase, m.baseSha));
  const outside = m.clean ? [] : (await git.changedFiles(wt, before, head))
    .filter((f) => !baseFiles.has(f) && !m.conflicts.some((c) => c.path === f));
  const agentRan = !!store.job(job.id)!.session_id;
  const r = agentRan ? parseMergeReport(report) : null;
  const reasons = r ? reviewReasons(r, cautions, outside, local.skipped ? null : local.ok) : [];
  const commitUrl = `https://github.com/${repo.name}/commit/${mergeCommit}`;
  const checkLine = local.skipped ? `No local check is configured; your CI runs on the push.` : `Locally, \`${repo.check}\` passes ✅. Your CI runs on the push.`;
  const what = m.clean
    ? `merged \`${base}\` into this branch ([merge commit](${commitUrl})). There were no conflicts${agentRan ? `, but the merged code failed the check and the agent fixed it` : ""}.`
    : `merged \`${base}\` into this branch and resolved ${m.conflicts.length} conflict(s) ([merge commit](${commitUrl}), which GitHub shows as a combined diff).`;
  const verdict = reasons.length
    ? `> [!WARNING]\n> **Needs your review before merging:**\n${reasons.map((x) => `> - ${x}`).join("\n")}`
    : agentRan ? `The check passes and the agent was confident. Review the resolution like any other change.` : "";
  await gh.comment(repo.name, job.number, withPreview(ctx, branch, `🔀 **pr-daemon** ${what}

${verdict}
${m.clean ? "" : `\n${conflictTable(m.conflicts)}\n`}
${checkLine}
${report ? `\n<details${reasons.length ? " open" : ""}><summary>How it was resolved (the agent's report)</summary>\n\n${report}\n</details>` : ""}`));
  note(reasons.length ? "warn" : "ok", reasons.length ? `merged ${base} at ${mergeCommit.slice(0, 7)}; needs your review: ${reasons.join("; ")}`
    : `merged ${base} at ${mergeCommit.slice(0, 7)}${m.clean ? "" : `, ${m.conflicts.length} conflict(s) resolved`}`);
  if (reasons.length) {
    store.event(`merged ${base} into ${branch}, but it needs your review: ${reasons.join("; ")}`.slice(0, 600), job.id, "warn");
    ctx.notice = { kind: "merge", level: "warn", title: `🔀 Review a merge: ${repo.name} #${job.number}`, body: reasons[0], url: p.html_url };
  }
}

/** Markdown table of conflicted files. */
function conflictTable(cs: git.Conflict[]): string {
  return `| File | Conflict |\n|---|---|\n${cs.map((c) => `| \`${c.path}\` | ${c.kind}${c.binary ? " (binary)" : ""} |`).join("\n")}`;
}

/** Why a resolution can't be committed: anything but the merge we started, with every conflict gone. */
async function verifyResolution(wt: string, before: string, m: git.MergeStart): Promise<string[]> {
  const problems: string[] = [];
  if (await git.mergeInProgress(wt)) {
    if ((await git.head(wt)) !== before) problems.push("the branch moved under the merge (the agent committed or reset something)");
  } else {
    const ps = await git.parents(wt);
    if (ps.length !== 2 || ps[0] !== before || ps[1] !== m.baseSha) problems.push("the merge is no longer in the worktree: it was aborted, reset or rewritten");
  }
  for (const c of m.conflicts) {
    const f = join(wt, c.path);
    if (existsSync(f) && hasConflictMarkers(readFileSync(f, "utf8"))) problems.push(`conflict markers are still in \`${c.path}\``);
  }
  return problems;
}

/** The merge done by GitHub ("Update branch"), for when the push of our own merge commit would be refused. Clean merges only. */
async function viaGitHub(ctx: Ctx, o: { before: string; base: string; branch: string; wt: string; n: number; why: string;
  note: (level: "ok" | "warn" | "bad", text: string) => void; handOver: (h: string, r: string[]) => Promise<never> }): Promise<void> {
  const { repo, job, store } = ctx;
  try { await gh.updateBranch(repo.name, job.number, o.before); }
  catch (e) {
    await o.handOver(`neither pr-daemon nor GitHub could merge \`${o.base}\` in`, [
      `pushing the merge needs the \`workflow\` scope (${o.why.slice(0, 300)})`, `GitHub's own "Update branch" failed: ${(e as Error).message.slice(0, 300)}`,
      "allow it with `gh auth refresh -s workflow` on the pr-daemon machine, or press Update branch on the PR yourself"]);
  }
  store.event(`GitHub merged ${o.base} into ${o.branch} (Update branch): ${o.why.slice(0, 200)}`, job.id);
  o.note("ok", `merged ${o.base} via GitHub's Update branch (the base changed workflow files)`);
  await gh.comment(repo.name, job.number, `🔀 **pr-daemon** had GitHub merge \`${o.base}\` into this branch (its **Update branch**), with no conflicts. ` +
    `It couldn't push the merge itself, because \`${o.base}\` changed \`.github/workflows/\` and its gh login lacks the \`workflow\` scope. No local check ran on it; your CI will.`);
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

  // Automatic cleanup (PR or issue closed, label removed) also removes the
  // branch from GitHub. The Tear down button doesn't: an open PR needs its branch.
  const p = payload(job);
  if (!p.deleteBranch) return;
  // The issue or PR is closed (or about to be): its notices are no longer anyone's move.
  const gone = store.clearNotices(repo.name, [job.number, s?.pr ?? 0]);
  if (gone.length) { unnotify(gone); store.event(`cleared ${gone.length} notice(s) about #${job.number}${s?.pr ? ` / PR #${s.pr}` : ""}`, job.id); }
  // Only ever a branch pr-daemon named for this issue.
  if (!branch.startsWith(`${job.number}-`)) { store.event(`not deleting ${branch}: not a pr-daemon branch for #${job.number}`, job.id, "warn"); return; }
  if (p.closePr && s?.pr && (await gh.pr(repo.name, s.pr)).state === "open") {
    await gh.closePr(repo.name, s.pr, `🧹 **pr-daemon** closed this: ${p.why ?? "the label was removed"}. The preview is shut down and the branch deleted (GitHub's "Restore branch" brings it back).`);
  } else if (p.closePr) {
    await gh.comment(repo.name, job.number, `🧹 **pr-daemon** stopped: ${p.why ?? "the label was removed"}. The preview is shut down and the branch \`${branch}\` deleted.`);
  }
  const r = await gh.deleteBranch(repo.name, branch);
  store.event(r === "deleted" ? `deleted branch ${branch} on GitHub` : `branch ${branch} was already gone from GitHub`, job.id);
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
  if (!r.ok) throw new Error(`restart failed: ${lastLine(r.error)} (the stack row has the full output)`);
}

export const JOBS = { build, review, revise, ci, merge, teardown, restart } as const;
