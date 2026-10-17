// The single long-running process: polls GitHub, queues jobs, runs them under
// the token budget, watches stacks, and serves the status page.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gate, issueUsed, windowState } from "./budget.ts";
import { parseConfig, saveConfigText, CONFIG_PATH, readConfigText, type Config } from "./config.ts";
import { AGENT_KINDS, openDb, Store, type Job, type Stack } from "./db.ts";
import * as gh from "./gh.ts";
import * as git from "./git.ts";
import { agentLog, CancelError, FailError, PauseError, JOBS, type Ctx } from "./pipeline.ts";
import { Proxy, publicUrl, serviceUrl, stackRoutes, STOP_WAIT_MS } from "./proxy.ts";
import { paths, setupDoc } from "./setup.ts";
import * as stack from "./stack.ts";
import { agentPids } from "./agent.ts";
import { parseTranscript, type Entry } from "./transcript.ts";
import { formatAmount, formatDuration, notify } from "./util.ts";

const MAX_HOUSEKEEPING = 2;      // teardown/restart jobs at once (no agent, no tokens)
const COMMAND = "/pr-daemon";    // the PR comment prefix that asks for a revision
/** Shutdown waits this long for running agents to exit (agent.ts SIGKILLs after 10s). */
const AGENT_STOP_MS = 12_000;
/** Shutdown waits this long for Caddy to exit, then quits regardless. launchd's ExitTimeOut must be longer. */
export const EXIT_DEADLINE_MS = STOP_WAIT_MS + 10_000;

export class Daemon {
  store: Store;
  cfg: Config;
  proxy: Proxy;
  running = new Map<number, Ctx>();
  activity = new Map<number, string[]>();
  lastPollAt = 0;
  lastPollError = "";
  nextPollAt = 0;
  /** The GitHub login gh is authenticated as: everything pr-daemon does on GitHub is done as this user. */
  ghUser = "";
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private configWatcher: FSWatcher | null = null;
  private configTimer: NodeJS.Timeout | null = null;
  /** The exact text of the config we are running, so our own writes aren't re-read as edits. */
  private configOnDisk = "";
  /** The last parse error announced, so one broken save doesn't repeat in the event log. */
  private configError = "";
  /** Stacks that just became ready, newest last: the status page turns these into browser notifications. */
  ready: { at: number; repo: string; issue: number; branch: string; url: string }[] = [];
  /** The shutdown in progress, if any. */
  private stopping: Promise<void> | null = null;
  private quitting = false;
  /** Each running job's promise, so shutdown can wait for its agent to exit. */
  private inflight = new Map<number, Promise<void>>();

  constructor() {
    // Keep the text, not just the parsed config: the file watcher compares
    // against it to tell a real edit from the write we just made ourselves.
    this.configOnDisk = readConfigText();
    this.cfg = parseConfig(this.configOnDisk);
    this.store = new Store(openDb());
    this.store.onStackReady = (s) => {
      const url = publicUrl(this.cfg, s.branch) || s.url;
      this.ready = [...this.ready, { at: Date.now(), repo: s.repo, issue: s.issue, branch: s.branch, url }].slice(-20);
      if (this.cfg.notify) notify("pr-daemon: preview ready", `${s.repo}#${s.issue} ${s.branch}`, url);
    };
    this.proxy = new Proxy(this.store, () => this.cfg);
  }

  get paused(): boolean { return this.store.get("paused") === "1"; }
  setPaused(p: boolean): void { this.store.set("paused", p ? "1" : "0"); this.store.event(p ? "paused: no new jobs will start" : "resumed"); }

  statusUrl(jobId?: number): string { return `http://localhost:${this.cfg.port}/${jobId ? `#job-${jobId}` : ""}`; }

  start(): void {
    this.stopOrphans();
    const n = this.store.recoverRunning();
    if (n) this.store.event(`${n} job(s) were running when pr-daemon stopped; re-queued to resume`);
    this.store.event(`pr-daemon started (config ${CONFIG_PATH}, ${this.cfg.repos.length} repo(s))`);
    if (process.platform === "darwin" && this.cfg.preventSleep) {
      spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
    }
    gh.viewer().then((u) => { this.ghUser = u; this.store.event(`acting on GitHub as @${u}`); }, () => {});
    this.schedulePoll(1000);
    setInterval(() => this.tick(), 2000).unref?.();
    this.proxy.start();
    this.watchConfig();
  }

  /**
   * A hard-killed pr-daemon (SIGKILL, a crash) couldn't stop its agents, and
   * they keep working with nobody reading their output. Stop them before their
   * jobs resume the same sessions, so two agents never share a worktree. What
   * they were in the middle of is lost; the resumed session redoes it.
   */
  private stopOrphans(): void {
    const sessions = this.store.jobs(500).filter((j) => j.state === "running" && j.session_id).map((j) => j.session_id);
    if (!sessions.length) return;
    let ps = "";
    try { ps = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64e6 }); }
    catch (e) { this.store.event(`couldn't list processes to find leftover agents: ${(e as Error).message}`, null, "warn"); return; }
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const orphans = agentPids(ps, sessions).filter((o) => o.pid !== process.pid);
    for (const o of orphans) {
      this.store.event(`stopping a leftover agent (pid ${o.pid}, session ${o.session}) from before pr-daemon restarted`, null, "warn");
      try { process.kill(o.pid, "SIGTERM"); } catch {}
    }
    // Blocking is fine here: nothing else has started yet.
    const nap = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 40 && orphans.some((o) => alive(o.pid)); i++) Atomics.wait(nap, 0, 0, 250);
    for (const o of orphans.filter((o) => alive(o.pid))) { try { process.kill(o.pid, "SIGKILL"); } catch {} }
  }

  /**
   * Asked to quit from the status page or `pr-daemon stop`. Reply first, then
   * exit the way a signal would: Caddy stops with us, running jobs are
   * re-queued and resume their Claude session on the next start.
   */
  requestShutdown(): void {
    this.store.event("shutdown requested", null, "warn");
    setTimeout(() => {
      const done = (): never => process.exit(0);
      setTimeout(done, EXIT_DEADLINE_MS).unref();
      this.shutdown().then(done, done);
    }, 100);
  }

  /**
   * Stop polling and take the preview proxy down with us, waiting until Caddy
   * has exited. Running jobs are re-queued on the next start. Safe to call
   * twice (a signal arriving during a page-requested shutdown): both wait on
   * the same stop.
   */
  shutdown(): Promise<void> {
    this.stopping ??= this.doShutdown();
    return this.stopping;
  }

  private async doShutdown(): Promise<void> {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.configTimer) clearTimeout(this.configTimer);
    this.configWatcher?.close();
    this.configWatcher = null;
    this.store.event("pr-daemon is shutting down");
    // Stop the agents too. The service lets children outlive pr-daemon (so
    // preview stacks survive a restart), and an agent left running would work
    // on alongside the resumed copy of its own session. Jobs stay `running`,
    // so the next start re-queues them and they resume their sessions.
    this.quitting = true;
    for (const ctx of this.running.values()) { ctx.halted = true; ctx.current?.kill("pr-daemon is shutting down"); }
    const agents = Promise.race([Promise.allSettled(this.inflight.values()), new Promise((r) => setTimeout(r, AGENT_STOP_MS).unref())]);
    await Promise.all([agents, this.proxy.shutdown()]);
  }

  // ------------------------------------------------------------ config
  saveConfig(text: string): Config {
    const cfg = saveConfigText(text);
    // Remember what we wrote, so the watcher sees this as "already running".
    this.configOnDisk = text;
    this.configError = "";
    return this.apply(cfg, "config saved");
  }
  configText(): string { return readConfigText(); }

  /** Swap in a new config and do the things that don't pick it up by themselves. */
  private apply(cfg: Config, why: string): Config {
    const before = this.cfg;
    this.cfg = cfg;
    this.store.event(why);
    // Most readers call cfg() or this.cfg per use, so they just follow. These
    // two are fixed at startup and cannot be changed under a running process.
    if (before.port !== cfg.port) {
      this.store.event(`port ${before.port} -> ${cfg.port} takes effect when pr-daemon restarts`, null, "warn");
    }
    if (before.preventSleep !== cfg.preventSleep) {
      this.store.event(`prevent_sleep ${before.preventSleep} -> ${cfg.preventSleep} takes effect when pr-daemon restarts`, null, "warn");
    }
    if (before.pollMs !== cfg.pollMs) this.schedulePoll(1000);
    return this.cfg;
  }

  /**
   * Watch config.toml so an edit made OUTSIDE the status page applies live too.
   *
   * Config changes are meant to apply live, but that was only true of the
   * Config page (which calls saveConfig). A hand edit of the file — or an edit
   * by an agent — sat there unread until the process restarted, and restarting
   * re-queues whatever was running. The symptom was silent: `doctor` reads the
   * file and said the preview proxy was configured while the running daemon
   * still had the old value and no proxy.
   *
   * Watch the DIRECTORY, not the file. saveConfigText writes `<config>.tmp` and
   * renames it over config.toml, and a watch on a path follows the inode it was
   * opened on — a file watch would survive exactly one save and then go deaf.
   */
  private watchConfig(): void {
    const name = basename(CONFIG_PATH);
    try {
      this.configWatcher = watch(dirname(CONFIG_PATH), (_type, filename) => {
        // The .tmp file lands in this directory too; only the real one counts.
        if (filename && filename !== name) return;
        // One save produces several events (a rename is a write then a rename,
        // and editors add their own), so settle first: reading immediately can
        // catch a half-written file, which then fails to parse for no reason.
        if (this.configTimer) clearTimeout(this.configTimer);
        this.configTimer = setTimeout(() => this.reloadConfig(), 250);
        this.configTimer.unref?.();
      });
      this.configWatcher.unref?.();
    } catch (e) {
      this.store.event(`cannot watch ${CONFIG_PATH} (${(e as Error).message}); edits need a restart`, null, "warn");
    }
  }

  /** Re-read config.toml after an edit. A file that no longer parses is ignored, not applied. */
  private reloadConfig(): void {
    let text: string;
    try { text = readConfigText(); } catch { return; } // caught mid-rename; another event follows
    if (text === this.configOnDisk) return;            // our own save, or a touch that changed nothing
    let cfg: Config;
    try {
      cfg = parseConfig(text);
    } catch (e) {
      // Keep running the config we have. Announce each distinct error once:
      // an editor that saves on every keystroke would otherwise flood the log
      // while the file is briefly incomplete.
      const msg = (e as Error).message;
      if (msg !== this.configError) {
        this.configError = msg;
        this.store.event(`config.toml is invalid, still running the previous config: ${msg}`, null, "error");
      }
      return;
    }
    this.configOnDisk = text;
    this.configError = "";
    this.apply(cfg, `config reloaded: ${CONFIG_PATH} changed on disk`);
  }

  /** The contract a project has to meet, with this machine's paths filled in: GET /setup. */
  setupDoc(): string { return setupDoc(this.cfg, COMMAND); }

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
    this.ghUser ||= await gh.viewer();
    return gh.allowedUsers(this.cfg.allowedUsers);
  }

  /** Who may trigger work: allowed_users, or else only the gh user (empty until that's known). */
  private allowedNow(): string[] {
    return this.cfg.allowedUsers.length ? this.cfg.allowedUsers : this.ghUser ? [this.ghUser] : [];
  }

  private async pollRepo(repo: string): Promise<void> {
    const { store, cfg } = this;
    const allowed = await this.allowed();

    // 1. Issues carrying the label → build. Keyed by the label event, so
    //    removing and re-adding the label starts a fresh build.
    const issues = await gh.labeledIssues(repo, cfg.label);
    const labeled = new Set(issues.map((i) => i.number));
    for (const issue of issues) {
      if (store.activeFor(repo, "build", issue.number)) continue;
      const ev = await gh.lastLabeled(repo, issue.number, cfg.label);
      if (!ev) continue;
      const key = `label:${repo}#${issue.number}:${ev.id}`;
      if (store.hasTrigger(key)) continue;
      if (!gh.isListed(allowed, ev.actor)) {
        store.enqueue({ repo, kind: "build", number: issue.number, trigger_key: key, state: "ignored", reason: `label added by @${ev.actor}, who isn't allowed` });
        store.event(`ignored ${repo}#${issue.number}: label added by @${ev.actor} (not in allowed_users)`, null, "warn");
        continue;
      }
      // Who added the label isn't enough: the issue's text is the agent's
      // instructions, so whoever wrote it (or edited it since) must be trusted too.
      const strangers = gh.untrustedWriters(await gh.provenance(repo, issue.number), await gh.trustedAuthors(cfg.allowedUsers));
      if (strangers.length) {
        const why = gh.untrustedIssue(strangers);
        if (store.enqueue({ repo, kind: "build", number: issue.number, trigger_key: key, state: "ignored", reason: why })) {
          store.event(`ignored ${repo}#${issue.number}: ${why}`, null, "warn");
          await gh.comment(repo, issue.number, `🚫 **pr-daemon** won't build this: ${why}. ${gh.UNTRUSTED_HELP}`);
        }
        continue;
      }
      const id = store.enqueue({ repo, kind: "build", number: issue.number, trigger_key: key });
      if (id) store.event(`queued build for ${repo}#${issue.number} "${issue.title}" (label by @${ev.actor})`, id);
    }

    // 2. "/pr-daemon …" comments on PRs → revise.
    const sinceKey = `comments-since:${repo}`;
    const since = store.get(sinceKey) ?? new Date(Date.now() - 10 * 60e3).toISOString(); // first run: don't replay history
    const startedAt = Date.now();
    for (const c of await gh.commentsSince(repo, since)) {
      const body = c.body.trimStart();
      if (!body.startsWith(COMMAND) || !c.html_url.includes("/pull/")) continue;
      const key = `comment:${repo}:${c.id}`;
      if (store.hasTrigger(key)) continue;
      const pr = Number(c.issue_url.split("/").pop());
      if (!gh.isListed(allowed, c.user.login)) {
        store.enqueue({ repo, kind: "revise", number: pr, trigger_key: key, state: "ignored", reason: `${COMMAND} from @${c.user.login}, who isn't allowed` });
        continue;
      }
      const branch = (await gh.pr(repo, pr)).head.ref;
      const id = store.enqueue({ repo, kind: "revise", number: pr, branch, trigger_key: key, payload: { feedback: body.slice(COMMAND.length).trim(), commentId: c.id } });
      if (id) store.event(`queued revise for ${repo} PR #${pr} (${COMMAND} by @${c.user.login})`, id);
    }
    store.set(sinceKey, new Date(startedAt - 60e3).toISOString()); // overlap; ids dedupe

    // 3. The label came off: stop any work on that issue. The stack (if there
    //    is one) is cleaned up below once nothing is running on it.
    for (const j of store.jobs(200)) {
      if (j.repo !== repo || j.kind !== "build" || !["queued", "running", "paused"].includes(j.state) || labeled.has(j.number)) continue;
      if ((await this.unlabeled(repo, j.number)) === "removed") this.cancel(j.id, `the ${cfg.label} label was removed`);
    }

    // 4. Stacks: clean up when the PR or issue closes, or the label comes off;
    //    keep them healthy otherwise.
    for (const s of store.stacks().filter((x) => x.repo === repo)) {
      const why = await this.cleanupReason(repo, s, labeled);
      if (this.busy(repo, s.branch, s.issue)) {
        // Revisions and reviews on an abandoned branch: stop them, tear down next poll.
        if (why.labelRemoved) for (const j of this.activeFor(repo, s.branch, s.issue)) this.cancel(j.id, why.text);
        continue;
      }
      if (why.text) {
        const id = store.enqueue({ repo, kind: "teardown", number: s.issue, branch: s.branch, trigger_key: `teardown:${repo}:${s.branch}:${s.created_at}`,
          payload: { deleteBranch: true, closePr: why.labelRemoved, why: why.text } });
        if (id) store.event(`queued teardown of ${s.branch} (${why.text})`, id);
        continue;
      }
      if (s.url && Date.now() - (s.checked_at ?? 0) > cfg.stacks.healthEveryMs) {
        const ok = await stack.healthy(s.url);
        store.upsertStack({ repo, branch: s.branch, issue: s.issue, worktree: s.worktree, healthy: ok ? 1 : 0,
          error: ok ? "" : `${s.url} stopped answering`, checked_at: Date.now() });
        if (!ok && cfg.stacks.autoRestart) {
          const id = store.enqueue({ repo, kind: "restart", number: s.issue, branch: s.branch, trigger_key: `restart:${repo}:${s.branch}:${Math.floor(Date.now() / cfg.stacks.healthEveryMs)}` });
          if (id) store.event(`stack ${s.branch} isn't answering; queued restart`, id, "warn");
        }
      }
    }
  }

  /**
   * Is an issue missing from the labeled list because it closed, or because
   * the label came off? Asked of the issue itself before acting, so a list
   * that lags behind can't tear anything down.
   */
  private async unlabeled(repo: string, n: number): Promise<"closed" | "removed" | null> {
    const issue = await gh.issue(repo, n);
    if (issue.state === "closed") return "closed";
    return issue.labels.some((l) => l.name === this.cfg.label) ? null : "removed";
  }

  /** Why a stack should go, if it should: its PR (or, before there's a PR, its issue) closed, or the label was removed. */
  private async cleanupReason(repo: string, s: Stack, labeled: Set<number>): Promise<{ text: string; labelRemoved: boolean }> {
    const issue = labeled.has(s.issue) ? null : await this.unlabeled(repo, s.issue);
    if (issue === "removed") return { text: `the ${this.cfg.label} label was removed from #${s.issue}`, labelRemoved: true };
    if (s.pr) {
      const pr = await gh.pr(repo, s.pr);
      if (pr.state === "closed") return { text: `PR #${s.pr} ${pr.merged_at ? "merged" : "closed"}`, labelRemoved: false };
    } else if (issue === "closed") {
      return { text: `issue #${s.issue} closed`, labelRemoved: false };
    }
    return { text: "", labelRemoved: false };
  }

  /** Is any job running or waiting for this branch/issue? (Don't tear down under a build.) */
  private busy(repo: string, branch: string, issue: number): boolean {
    return this.activeFor(repo, branch, issue).length > 0;
  }
  private activeFor(repo: string, branch: string, issue: number): Job[] {
    return this.store.jobs(200).filter((j) => j.repo === repo && ["queued", "running", "paused"].includes(j.state)
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
    if (this.paused || this.quitting) return;
    const runningJobs = [...this.running.values()].map((c) => c.job);
    let agents = runningJobs.filter((j) => AGENT_KINDS.includes(j.kind)).length;
    let chores = runningJobs.length - agents;
    const locks = new Set(runningJobs.map((j) => this.lockKey(j)));

    for (const job of this.store.runnable()) {
      if (this.running.has(job.id)) continue;
      const repo = this.cfg.repos.find((r) => r.name === job.repo);
      if (!repo) { this.store.update(job.id, { state: "failed", reason: "repo is not in the config", finished_at: Date.now() }); continue; }
      const isAgent = AGENT_KINDS.includes(job.kind);
      if (isAgent ? agents >= this.cfg.concurrency : chores >= MAX_HOUSEKEEPING) {
        this.waiting(job, isAgent ? `waiting: ${agents} of ${this.cfg.concurrency} agent slot(s) in use` : "waiting: other chores are running");
        continue;
      }
      const lock = this.lockKey(job);
      if (locks.has(lock)) {
        // One job per branch at a time: a restart can't run under its build.
        const holder = runningJobs.find((j) => this.lockKey(j) === lock);
        this.waiting(job, `waiting: ${holder ? `${holder.kind} #${holder.id}` : "another job"} is running on this branch`);
        continue;
      }
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

  /** Why a queued job isn't starting, shown on the page. Written only when it changes. */
  private waiting(job: Job, reason: string): void {
    if (job.state === "queued" && job.reason !== reason) this.store.update(job.id, { reason });
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

    const done = JOBS[job.kind](ctx)
      .then(async () => {
        this.store.update(job.id, { state: "done", finished_at: Date.now() });
        // A review/revise that was paused set the issue to agent:paused; put it back.
        if (job.kind === "review" || job.kind === "revise") await gh.setStatus(job.repo, this.issueOf(job), this.cfg.label, "in-review").catch(() => {});
        this.store.event(`finished ${job.kind} ${job.repo}#${job.number}`, job.id);
      })
      .catch(async (e: Error) => {
        if (this.quitting) {     // stopped for shutdown: leave it `running`, to resume on the next start
          this.store.event(`stopped for shutdown; resumes when pr-daemon starts again`, job.id, "warn");
          return;
        }
        if (e instanceof PauseError) {
          this.store.update(job.id, { state: "paused", reason: e.message, resume_after: e.retryAt });
          const when = e.retryAt ? `It resumes on its own in about ${formatDuration(e.retryAt - Date.now())}.` : `Press Resume on the status page when you're ready: ${this.statusUrl(job.id)}`;
          this.store.event(`paused: ${e.message}`, job.id, "warn");
          await gh.setStatus(job.repo, this.issueOf(job), this.cfg.label, "paused").catch(() => {});
          await gh.comment(job.repo, job.number, `⏸️ **pr-daemon** paused: ${e.message}. ${when}`);
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
            await gh.comment(job.repo, job.number, `❌ **pr-daemon** hit an error: \`${e.message.slice(0, 300)}\`\n\nDetails: ${this.statusUrl(job.id)} (on the pr-daemon machine). Retry from there, or remove and re-add the \`${this.cfg.label}\` label.`);
          }
        }
      })
      .finally(() => { this.running.delete(job.id); this.inflight.delete(job.id); this.tick(); });
    this.inflight.set(job.id, done);
    return done;
  }

  // ------------------------------------------------------------ actions from the page
  cancel(id: number, why = "cancelled by you"): void {
    const ctx = this.running.get(id);
    if (ctx) {
      if (ctx.cancelled) return;
      this.store.update(id, { reason: why });
      this.store.event(`${why}; stopping the agent`, id, "warn");
      ctx.cancelled = true; ctx.current?.kill("cancelled");
      return;
    }
    const j = this.store.job(id);
    if (j && ["queued", "paused"].includes(j.state)) {
      this.store.update(id, { state: "cancelled", reason: why, finished_at: Date.now() });
      this.store.event(`cancelled ${j.kind} ${j.repo}#${j.number} before it started`, id, "warn");
    }
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
  teardownStack(repo: string, branch: string): void { this.stackAction("teardown", repo, branch); }
  restartStack(repo: string, branch: string): void { this.stackAction("restart", repo, branch); }

  /**
   * Queue one stack chore. Pressing the button again while the first is still
   * queued (behind a build, say) used to pile up identical jobs, which read
   * like something had gone wrong.
   */
  private stackAction(kind: "teardown" | "restart", repo: string, branch: string): void {
    const s = this.store.stack(repo, branch);
    if (!s) return;
    const pending = this.store.jobs(200).find((j) => j.repo === repo && j.branch === branch && j.kind === kind
      && ["queued", "running"].includes(j.state));
    if (pending) {
      this.store.event(`${kind} of ${branch} is already ${pending.state}`, pending.id, "warn");
      return;
    }
    this.store.enqueue({ repo, kind, number: s.issue, branch, trigger_key: `${kind}:${repo}:${branch}:manual:${Date.now()}` });
    this.tick();
  }

  /**
   * The agent's transcript for one job, from entry `from` on (the page polls
   * for what's new). Logs live in the branch's out/ directory, so they go
   * when the stack is torn down.
   */
  transcript(id: number, from = 0): { file: string | null; total: number; entries: Entry[] } {
    const j = this.store.job(id);
    const file = j ? agentLog(j) : null;
    if (!file || !existsSync(file)) return { file, total: 0, entries: [] };
    const all = parseTranscript(readFileSync(file, "utf8"));
    return { file, total: all.length, entries: all.slice(from > all.length ? 0 : from) };
  }

  // ------------------------------------------------------------ status for the page
  status(): unknown {
    const w = windowState(this.store, this.cfg);
    return {
      now: Date.now(),
      paused: this.paused,
      configPath: CONFIG_PATH,
      paths: paths(),
      repos: this.cfg.repos.map((r) => r.name),
      label: this.cfg.label,
      github: { actingAs: this.ghUser, allowedUsers: this.allowedNow(), allowedFromConfig: this.cfg.allowedUsers.length > 0 },
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
        out: j.branch ? git.outDir(j.repo, j.branch) : "",
        worktree: j.branch ? join(git.worktreeRoot(j.repo), j.branch) : "",
      })),
      stacks: this.store.stacks().map((s) => ({ ...s, public_url: publicUrl(this.cfg, s.branch),
        services: Object.entries(stackRoutes(s)).map(([name, upstream]) => ({ name, upstream, url: serviceUrl(this.cfg, s.branch, name) })) })),
      proxy: this.proxy.status,
      ready: this.ready,
      events: this.store.events(120),
    };
  }
}
