// The single long-running process: polls GitHub, queues jobs, runs them under
// the token budget, watches stacks, and serves the status page.
import { spawn } from "node:child_process";
import { gate, issueUsed, windowState } from "./budget.ts";
import { loadConfig, saveConfigText, CONFIG_PATH, readConfigText, type Config } from "./config.ts";
import { AGENT_KINDS, openDb, Store, type Job } from "./db.ts";
import * as gh from "./gh.ts";
import { CancelError, FailError, PauseError, JOBS, type Ctx } from "./pipeline.ts";
import { Proxy, publicUrl } from "./proxy.ts";
import * as stack from "./stack.ts";
import { formatAmount, formatDuration } from "./util.ts";

const MAX_HOUSEKEEPING = 2;      // teardown/restart jobs at once (no agent, no tokens)

export class Daemon {
  store: Store;
  cfg: Config;
  proxy: Proxy;
  running = new Map<number, Ctx>();
  activity = new Map<number, string[]>();
  lastPollAt = 0;
  lastPollError = "";
  nextPollAt = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor() {
    this.cfg = loadConfig();
    this.store = new Store(openDb());
    this.proxy = new Proxy(this.store, () => this.cfg);
  }

  get paused(): boolean { return this.store.get("paused") === "1"; }
  setPaused(p: boolean): void { this.store.set("paused", p ? "1" : "0"); this.store.event(p ? "paused: no new jobs will start" : "resumed"); }

  statusUrl(jobId?: number): string { return `http://localhost:${this.cfg.port}/${jobId ? `#job-${jobId}` : ""}`; }

  start(): void {
    const n = this.store.recoverRunning();
    if (n) this.store.event(`${n} job(s) were running when pr-demon stopped; re-queued to resume`);
    this.store.event(`pr-demon started (config ${CONFIG_PATH}, ${this.cfg.repos.length} repo(s))`);
    if (process.platform === "darwin" && this.cfg.preventSleep) {
      spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
    }
    this.schedulePoll(1000);
    setInterval(() => this.tick(), 2000).unref?.();
    this.proxy.start();
  }

  // ------------------------------------------------------------ config
  saveConfig(text: string): Config {
    const before = this.cfg;
    this.cfg = saveConfigText(text);
    this.store.event("config saved");
    if (before.pollMs !== this.cfg.pollMs) this.schedulePoll(1000);
    return this.cfg;
  }
  configText(): string { return readConfigText(); }

  // ------------------------------------------------------------ polling
  schedulePoll(inMs = this.cfg.pollMs): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.nextPollAt = Date.now() + inMs;
    this.pollTimer = setTimeout(() => this.poll(), inMs);
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const errors: string[] = [];
    try {
      for (const repo of this.cfg.repos) {
        try { await this.pollRepo(repo.name); }
        catch (e) { errors.push(`${repo.name}: ${(e as Error).message}`); }
      }
    } finally {
      this.lastPollAt = Date.now();
      if (errors.join() !== this.lastPollError && errors.length) this.store.event(`poll error: ${errors.join("; ")}`, null, "error");
      this.lastPollError = errors.join("; ");
      this.polling = false;
      this.schedulePoll();
    }
  }

  private async allowed(): Promise<string[]> {
    return this.cfg.allowedUsers.length ? this.cfg.allowedUsers : [await gh.viewer()];
  }

  private async pollRepo(repo: string): Promise<void> {
    const { store, cfg } = this;
    const allowed = await this.allowed();

    // 1. Issues carrying the label → build. Keyed by the label event, so
    //    removing and re-adding the label starts a fresh build.
    for (const issue of await gh.labeledIssues(repo, cfg.label)) {
      if (store.activeFor(repo, "build", issue.number)) continue;
      const ev = await gh.lastLabeled(repo, issue.number, cfg.label);
      if (!ev) continue;
      const key = `label:${repo}#${issue.number}:${ev.id}`;
      if (store.hasTrigger(key)) continue;
      if (!allowed.includes(ev.actor)) {
        store.enqueue({ repo, kind: "build", number: issue.number, trigger_key: key, state: "ignored", reason: `label added by @${ev.actor}, who isn't allowed` });
        store.event(`ignored ${repo}#${issue.number}: label added by @${ev.actor} (not in allowed_users)`, null, "warn");
        continue;
      }
      const id = store.enqueue({ repo, kind: "build", number: issue.number, trigger_key: key });
      if (id) store.event(`queued build for ${repo}#${issue.number} "${issue.title}" (label by @${ev.actor})`, id);
    }

    // 2. "/demon …" comments on PRs → revise.
    const sinceKey = `comments-since:${repo}`;
    const since = store.get(sinceKey) ?? new Date(Date.now() - 10 * 60e3).toISOString(); // first run: don't replay history
    const startedAt = Date.now();
    for (const c of await gh.commentsSince(repo, since)) {
      if (!c.body.trimStart().startsWith("/demon") || !c.html_url.includes("/pull/")) continue;
      const key = `comment:${repo}:${c.id}`;
      if (store.hasTrigger(key)) continue;
      const pr = Number(c.issue_url.split("/").pop());
      if (!allowed.includes(c.user.login)) {
        store.enqueue({ repo, kind: "revise", number: pr, trigger_key: key, state: "ignored", reason: `/demon from @${c.user.login}, who isn't allowed` });
        continue;
      }
      const branch = (await gh.pr(repo, pr)).head.ref;
      const id = store.enqueue({ repo, kind: "revise", number: pr, branch, trigger_key: key, payload: { feedback: c.body.trimStart().slice("/demon".length).trim() } });
      if (id) store.event(`queued revise for ${repo} PR #${pr} (/demon by @${c.user.login})`, id);
    }
    store.set(sinceKey, new Date(startedAt - 60e3).toISOString()); // overlap; ids dedupe

    // 3. Stacks: clean up when their PR or issue is closed; keep them healthy.
    for (const s of store.stacks().filter((x) => x.repo === repo)) {
      if (this.busy(repo, s.branch, s.issue)) continue;
      let closed = false;
      if (s.pr) closed = (await gh.pr(repo, s.pr)).state === "closed";
      else closed = (await gh.issue(repo, s.issue)).state === "closed";
      if (closed) {
        const id = store.enqueue({ repo, kind: "teardown", number: s.issue, branch: s.branch, trigger_key: `teardown:${repo}:${s.branch}:${s.created_at}` });
        if (id) store.event(`queued teardown of ${s.branch} (${s.pr ? `PR #${s.pr}` : `issue #${s.issue}`} closed)`, id);
        continue;
      }
      if (s.url && Date.now() - (s.checked_at ?? 0) > cfg.stacks.healthEveryMs) {
        const ok = await stack.healthy(s.url);
        store.upsertStack({ repo, branch: s.branch, issue: s.issue, worktree: s.worktree, healthy: ok ? 1 : 0, checked_at: Date.now() });
        if (!ok && cfg.stacks.autoRestart) {
          const id = store.enqueue({ repo, kind: "restart", number: s.issue, branch: s.branch, trigger_key: `restart:${repo}:${s.branch}:${Math.floor(Date.now() / cfg.stacks.healthEveryMs)}` });
          if (id) store.event(`stack ${s.branch} isn't answering; queued restart`, id, "warn");
        }
      }
    }
  }

  /** Is any job running or waiting for this branch/issue? (Don't tear down under a build.) */
  private busy(repo: string, branch: string, issue: number): boolean {
    return this.store.jobs(200).some((j) => j.repo === repo && ["queued", "running", "paused"].includes(j.state)
      && j.kind !== "teardown" && (j.branch === branch || (j.kind === "build" && j.number === issue)));
  }

  /** The issue a job is about: builds carry it; review/revise carry the PR, whose branch starts with it. */
  private issueOf(job: Job): number {
    return job.kind === "review" || job.kind === "revise" ? Number(job.branch.split("-")[0]) || job.number : job.number;
  }

  // ------------------------------------------------------------ scheduling
  private lockKey(j: Job): string {
    return `${j.repo}:${j.branch || this.store.stackForIssue(j.repo, j.number)?.branch || `#${j.number}`}`;
  }

  tick(): void {
    if (this.paused) return;
    const runningJobs = [...this.running.values()].map((c) => c.job);
    let agents = runningJobs.filter((j) => AGENT_KINDS.includes(j.kind)).length;
    let chores = runningJobs.length - agents;
    const locks = new Set(runningJobs.map((j) => this.lockKey(j)));

    for (const job of this.store.runnable()) {
      if (this.running.has(job.id)) continue;
      const repo = this.cfg.repos.find((r) => r.name === job.repo);
      if (!repo) { this.store.update(job.id, { state: "failed", reason: "repo is not in the config", finished_at: Date.now() }); continue; }
      const isAgent = AGENT_KINDS.includes(job.kind);
      if (isAgent ? agents >= this.cfg.concurrency : chores >= MAX_HOUSEKEEPING) continue;
      const lock = this.lockKey(job);
      if (locks.has(lock)) continue;
      if (isAgent) {
        const g = gate(this.store, this.cfg, job.repo, this.issueOf(job));
        if (!g.ok) {
          if (job.reason !== g.reason) this.store.update(job.id, { reason: g.reason });
          if (g.needsHuman && job.state !== "paused") this.store.update(job.id, { state: "paused", resume_after: null });
          continue;
        }
      }
      locks.add(lock);
      if (isAgent) agents++; else chores++;
      this.launch(job, repo);
    }
  }

  /** Run one job now, in this process, and wait for it (the `run` CLI command). */
  runNow(id: number): Promise<void> {
    const job = this.store.job(id)!;
    const repo = this.cfg.repos.find((r) => r.name === job.repo);
    if (!repo) throw new Error(`${job.repo} is not in ${CONFIG_PATH}`);
    return this.launch(job, repo);
  }

  private launch(job: Job, repo: Config["repos"][number]): Promise<void> {
    this.store.update(job.id, { state: "running", reason: "", started_at: Date.now(), resume_after: null });
    const lines: string[] = [];
    this.activity.set(job.id, lines);
    const ctx: Ctx = {
      store: this.store, cfg: () => this.cfg, repo, job: this.store.job(job.id)!, current: null, cancelled: false,
      statusUrl: this.statusUrl(job.id),
      activity: (l) => { lines.push(`${new Date().toISOString().slice(11, 19)} ${l}`); if (lines.length > 200) lines.shift(); },
    };
    this.running.set(job.id, ctx);
    this.store.event(`started ${job.kind} ${job.repo}#${job.number}`, job.id);

    return JOBS[job.kind](ctx)
      .then(async () => {
        this.store.update(job.id, { state: "done", finished_at: Date.now() });
        // A review/revise that was paused set the issue to agent:paused; put it back.
        if (job.kind === "review" || job.kind === "revise") await gh.setStatus(job.repo, this.issueOf(job), this.cfg.label, "in-review").catch(() => {});
        this.store.event(`finished ${job.kind} ${job.repo}#${job.number}`, job.id);
      })
      .catch(async (e: Error) => {
        if (e instanceof PauseError) {
          this.store.update(job.id, { state: "paused", reason: e.message, resume_after: e.retryAt });
          const when = e.retryAt ? `It resumes on its own in about ${formatDuration(e.retryAt - Date.now())}.` : `Press Resume on the status page when you're ready: ${this.statusUrl(job.id)}`;
          this.store.event(`paused: ${e.message}`, job.id, "warn");
          await gh.setStatus(job.repo, this.issueOf(job), this.cfg.label, "paused").catch(() => {});
          await gh.comment(job.repo, job.number, `⏸️ **pr-demon** paused: ${e.message}. ${when}`);
        } else if (e instanceof CancelError || ctx.cancelled) {
          this.store.update(job.id, { state: "cancelled", finished_at: Date.now() });
          this.store.event("cancelled", job.id, "warn");
        } else if (e instanceof FailError) {
          this.store.update(job.id, { state: "failed", reason: e.message, finished_at: Date.now() });
          this.store.event(`gave up: ${e.message}`, job.id, "error");
        } else {
          this.store.update(job.id, { state: "failed", reason: e.message.slice(0, 2000), finished_at: Date.now() });
          this.store.event(`error: ${e.message.slice(0, 500)}`, job.id, "error");
          if (AGENT_KINDS.includes(job.kind)) {
            if (job.kind === "build") await gh.setStatus(job.repo, job.number, this.cfg.label, "failed").catch(() => {});
            await gh.comment(job.repo, job.number, `❌ **pr-demon** hit an error: \`${e.message.slice(0, 300)}\`\n\nDetails: ${this.statusUrl(job.id)} (on the pr-demon machine). Retry from there, or remove and re-add the \`${this.cfg.label}\` label.`);
          }
        }
      })
      .finally(() => { this.running.delete(job.id); this.tick(); });
  }

  // ------------------------------------------------------------ actions from the page
  cancel(id: number): void {
    const ctx = this.running.get(id);
    if (ctx) { ctx.cancelled = true; ctx.current?.kill("cancelled"); return; }
    const j = this.store.job(id);
    if (j && ["queued", "paused"].includes(j.state)) this.store.update(id, { state: "cancelled", finished_at: Date.now() });
  }
  /** Continue where it left off (same Claude session). */
  resume(id: number): void {
    const j = this.store.job(id);
    if (j && ["paused", "failed", "cancelled"].includes(j.state)) {
      this.store.update(id, { state: "queued", reason: "resumed by you", resume_after: null, finished_at: null });
      this.tick();
    }
  }
  /** Start over (fresh Claude session). */
  retry(id: number): void {
    const j = this.store.job(id);
    if (j && ["paused", "failed", "cancelled", "done"].includes(j.state)) {
      this.store.update(id, { state: "queued", reason: "retried by you", session_id: "", resume_after: null, finished_at: null });
      this.tick();
    }
  }
  teardownStack(repo: string, branch: string): void {
    const s = this.store.stack(repo, branch);
    if (s) this.store.enqueue({ repo, kind: "teardown", number: s.issue, branch, trigger_key: `teardown:${repo}:${branch}:manual:${Date.now()}` });
    this.tick();
  }
  restartStack(repo: string, branch: string): void {
    const s = this.store.stack(repo, branch);
    if (s) this.store.enqueue({ repo, kind: "restart", number: s.issue, branch, trigger_key: `restart:${repo}:${branch}:manual:${Date.now()}` });
    this.tick();
  }

  // ------------------------------------------------------------ status for the page
  status(): unknown {
    const w = windowState(this.store, this.cfg);
    return {
      now: Date.now(),
      paused: this.paused,
      configPath: CONFIG_PATH,
      repos: this.cfg.repos.map((r) => r.name),
      label: this.cfg.label,
      poll: { lastAt: this.lastPollAt, nextAt: this.nextPollAt, error: this.lastPollError, every: formatDuration(this.cfg.pollMs) },
      budget: {
        used: w.used, limit: w.limit, usedText: formatAmount(w.used), limitText: w.limit === null ? "unlimited" : formatAmount(w.limit),
        window: formatDuration(w.windowMs), freesAt: w.freesAt, breakdown: w.breakdown,
        perIssue: this.cfg.budget.perIssue === null ? null : formatAmount(this.cfg.budget.perIssue),
        countCacheReads: this.cfg.budget.countCacheReads,
      },
      concurrency: this.cfg.concurrency,
      jobs: this.store.jobs(80).map((j) => ({
        ...j, payload: undefined,
        tokensText: formatAmount(j.tokens),
        issueTokensText: j.kind === "build" ? formatAmount(issueUsed(this.store, this.cfg, j.repo, j.number)) : undefined,
        activity: this.activity.get(j.id)?.slice(-40) ?? [],
      })),
      stacks: this.store.stacks().map((s) => ({ ...s, public_url: publicUrl(this.cfg, s.branch) })),
      proxy: this.proxy.status,
      events: this.store.events(120),
    };
  }
}
