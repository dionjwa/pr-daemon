// GitHub through the `gh` CLI, as the logged-in user. No tokens are stored by
// pr-daemon; `gh` (and git, via `gh auth git-credential`) use your own login.
import { must, run, tail } from "./util.ts";

async function api<T>(path: string, args: string[] = []): Promise<T> {
  return JSON.parse((await must("gh", ["api", ...args, path])) || "null") as T;
}

/** All pages of a list endpoint, flattened. */
async function apiAll<T>(path: string): Promise<T[]> {
  const out = await must("gh", ["api", "--paginate", "--slurp", path]);
  return (JSON.parse(out) as T[][]).flat();
}

/** All pages of an endpoint that wraps its list in an object (check-runs, workflow runs). */
async function apiPages<T>(path: string, pick: (page: Record<string, unknown>) => T[] | undefined): Promise<T[]> {
  const out = await must("gh", ["api", "--paginate", "--slurp", path]);
  return (JSON.parse(out) as Record<string, unknown>[]).flatMap((p) => pick(p) ?? []);
}

let viewerLogin: string | undefined;
export async function viewer(): Promise<string> {
  viewerLogin ??= (await api<{ login: string }>("user")).login;
  return viewerLogin;
}

/** Who may direct pr-daemon: `allowed_users`, or else only the gh user. */
export async function allowedUsers(configured: string[]): Promise<string[]> {
  return configured.length ? configured : [await viewer()];
}

/**
 * Whose words may reach an agent: the allowed users plus the gh user (whose
 * account pr-daemon itself writes with: PR bodies, reviews, summaries).
 */
export async function trustedAuthors(configured: string[]): Promise<string[]> {
  return [...new Set([...(await allowedUsers(configured)), await viewer()])];
}

/** GitHub logins are case-insensitive. */
export function isListed(users: string[], login: string): boolean {
  const l = login.toLowerCase();
  return users.some((u) => u.toLowerCase() === l);
}

/** Everyone whose words are in an issue's title or body: the author, body editors, title renamers. */
export interface Provenance { author: string; editors: string[]; renamers: string[] }

/** The writers of an issue's title and body who aren't trusted (deleted accounts show as "ghost"). */
export function untrustedWriters(p: Provenance, trusted: string[]): string[] {
  return [...new Set([p.author, ...p.editors, ...p.renamers])].filter((u) => !isListed(trusted, u));
}

/** Why an issue's text isn't safe to hand an agent, and what to do about it. */
export const untrustedIssue = (who: string[]) =>
  `its title or text was written or edited by ${who.map((u) => `@${u}`).join(", ")}, who ${who.length === 1 ? "isn't" : "aren't"} in allowed_users`;
export const UNTRUSTED_HELP = "The issue is the agent's instructions, so only allowed users may write it. Open a new issue in your own words (or add them to allowed_users), then label that.";

export async function provenance(repo: string, n: number): Promise<Provenance> {
  const [owner, name] = repo.split("/");
  const query = `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { issue(number: $n) {
    author { login }
    userContentEdits(last: 100) { nodes { editor { login } } }
    timelineItems(last: 100, itemTypes: [RENAMED_TITLE_EVENT]) { nodes { ... on RenamedTitleEvent { actor { login } } } } } } }`;
  type Who = { login: string } | null;
  const r = JSON.parse(await must("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `n=${n}`]));
  const i = r.data.repository.issue as { author: Who; userContentEdits: { nodes: { editor: Who }[] }; timelineItems: { nodes: { actor?: Who }[] } };
  const who = (w: Who | undefined) => w?.login ?? "ghost";
  return { author: who(i.author), editors: i.userContentEdits.nodes.map((e) => who(e.editor)), renamers: i.timelineItems.nodes.map((e) => who(e.actor)) };
}

/** A PR's conversation (comments and review bodies), oldest first, from trusted authors only. */
export async function trustedDiscussion(repo: string, pr: number, trusted: string[], skipCommentId?: number): Promise<{ text: string; dropped: number }> {
  const [comments, reviews] = await Promise.all([
    apiAll<{ id: number; body: string; user: { login: string } | null; created_at: string }>(`repos/${repo}/issues/${pr}/comments?per_page=100`),
    apiAll<{ body: string; user: { login: string } | null; submitted_at: string }>(`repos/${repo}/pulls/${pr}/reviews?per_page=100`),
  ]);
  const all = [
    ...comments.filter((c) => c.id !== skipCommentId).map((c) => ({ who: c.user?.login ?? "ghost", at: c.created_at, body: c.body })),
    ...reviews.filter((r) => r.body?.trim()).map((r) => ({ who: r.user?.login ?? "ghost", at: r.submitted_at, body: r.body })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const kept = all.filter((c) => isListed(trusted, c.who));
  const text = kept.map((c) => `--- @${c.who}, ${c.at}\n${c.body.trim()}`).join("\n\n").slice(-30_000);
  return { text, dropped: all.length - kept.length };
}

export async function defaultBranch(repo: string): Promise<string> {
  return (await api<{ default_branch: string }>(`repos/${repo}`)).default_branch;
}

export interface Issue { number: number; title: string; body: string | null; state: string; html_url: string; labels: { name: string }[]; pull_request?: unknown }

export async function labeledIssues(repo: string, label: string): Promise<Issue[]> {
  const items = await apiAll<Issue>(`repos/${repo}/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`);
  return items.filter((i) => !i.pull_request);
}

export async function issue(repo: string, n: number): Promise<Issue> {
  return api<Issue>(`repos/${repo}/issues/${n}`);
}

/** The most recent time `label` was added to the issue: event id + who added it. */
export async function lastLabeled(repo: string, n: number, label: string): Promise<{ id: number; actor: string } | null> {
  const events = await apiAll<{ id: number; event: string; label?: { name: string }; actor?: { login: string } }>(
    `repos/${repo}/issues/${n}/events?per_page=100`);
  const hits = events.filter((e) => e.event === "labeled" && e.label?.name === label);
  const last = hits[hits.length - 1];
  return last ? { id: last.id, actor: last.actor?.login ?? "" } : null;
}

export interface Comment { id: number; body: string; user: { login: string }; html_url: string; issue_url: string; created_at: string }

/** Every issue + PR comment in the repo created/updated since `since` (ISO). */
export async function commentsSince(repo: string, since: string): Promise<Comment[]> {
  return apiAll<Comment>(`repos/${repo}/issues/comments?per_page=100&sort=created&direction=asc&since=${encodeURIComponent(since)}`);
}

export interface PR { number: number; state: string; merged_at: string | null; head: { ref: string; sha: string }; base: { ref: string }; html_url: string }

export async function pr(repo: string, n: number): Promise<PR> {
  return api<PR>(`repos/${repo}/pulls/${n}`);
}

// ---------------------------------------------------------------- checks (the project's own CI)
// pr-daemon pushes as the owner, so the repo's normal CI runs on every push.
// Two APIs describe it, and a repo can use either: check runs (GitHub Actions
// and most apps) and the older commit statuses (external CI). Read both, for
// one commit, and reduce them to "is this red, and what is red".

/**
 * Conclusions worth waking an agent for. Everything else that has finished
 * counts as done, including `neutral`, `skipped`, `cancelled` and `stale`: a
 * skipped job is not a red PR, and a cancelled one is somebody's decision.
 */
const FAILED = ["failure", "timed_out", "action_required", "error"];

export type ChecksState = "none" | "pending" | "failure" | "success";

export interface Checks {
  state: ChecksState;
  /** Check runs plus statuses, as GitHub counts them. */
  total: number;
  pending: string[];
  failing: { name: string; note: string; url: string }[];
  /** One line for the status page and the event log. */
  summary: string;
}

export interface CheckRun {
  name: string; status: string; conclusion: string | null; html_url?: string | null; details_url?: string | null;
  output?: { title?: string | null; summary?: string | null };
}
export interface CommitStatus { context: string; state: string; description?: string | null; target_url?: string | null }

/**
 * Every check GitHub knows about for one commit. `state` is the whole PR's
 * verdict: `failure` if anything failed, else `pending` while anything is
 * still running, else `success` (or `none` when the repo has no CI at all).
 */
export async function checks(repo: string, sha: string): Promise<Checks> {
  const [runs, combined] = await Promise.all([
    apiPages<CheckRun>(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, (p) => p.check_runs as CheckRun[] | undefined),
    api<{ statuses: CommitStatus[] } | null>(`repos/${repo}/commits/${sha}/status`).catch(() => null),
  ]);
  return summarizeChecks(runs, combined?.statuses ?? []);
}

/** The verdict for one commit's checks. Pure: unit-tested. */
export function summarizeChecks(runs: CheckRun[], rawStatuses: CommitStatus[]): Checks {
  // A context can report many times; only its latest state counts.
  const statuses = new Map<string, CommitStatus>();
  for (const s of rawStatuses) statuses.set(s.context, s);

  const pending = [
    ...runs.filter((r) => r.status !== "completed").map((r) => r.name),
    ...[...statuses.values()].filter((s) => s.state === "pending").map((s) => s.context),
  ];
  const failing = [
    ...runs.filter((r) => FAILED.includes(r.conclusion ?? "")).map((r) => ({
      name: r.name,
      note: ((r.output?.title || r.output?.summary || r.conclusion) ?? "").split("\n")[0].slice(0, 300),
      url: r.html_url || r.details_url || "",
    })),
    ...[...statuses.values()].filter((s) => FAILED.includes(s.state)).map((s) => ({
      name: s.context, note: (s.description ?? "").slice(0, 300), url: s.target_url ?? "",
    })),
  ];
  const total = runs.length + statuses.size;
  const done = total - pending.length - failing.length;
  const state: ChecksState = failing.length ? "failure" : pending.length ? "pending" : total ? "success" : "none";
  const summary = state === "none" ? "no checks"
    : state === "failure" ? `${failing.length} failing: ${failing.map((f) => f.name).join(", ")}`.slice(0, 300)
    : state === "pending" ? `${pending.length} running: ${pending.join(", ")}`.slice(0, 300)
    : `${done} passing`;
  return { state, total, pending, failing, summary };
}

/**
 * The tail of the logs of whatever failed on this commit, for the agent to
 * read. Only GitHub Actions has logs we can fetch; an external CI's failure
 * is just its name, note and link (see checks() above).
 *
 * Logs don't always survive: GitHub expires them, and a self-hosted runner may
 * never upload any — `gh run view --log-failed` then prints nothing and exits
 * 0. So when there is no log, say which steps failed, which at least tells the
 * agent where to look.
 */
export async function failureLogs(repo: string, sha: string, lines = 120): Promise<string> {
  type Run = { id: number; name: string; conclusion: string | null };
  const runs = await apiPages<Run>(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`,
    (p) => p.workflow_runs as Run[] | undefined).catch(() => []);
  const out: string[] = [];
  for (const r of runs.filter((x) => FAILED.includes(x.conclusion ?? "")).slice(0, 3)) {
    // --log-failed prints only the failed steps, which is what we want to pay for.
    const log = await run("gh", ["run", "view", String(r.id), "-R", repo, "--log-failed"], { timeoutMs: 120_000 });
    const text = (log.stdout || log.stderr).trim();
    out.push(`--- ${r.name} (run ${r.id})\n${text ? tail(text, lines) : await failedSteps(repo, r.id)}`);
  }
  return out.join("\n\n").slice(-20_000);
}

/** Which jobs and steps failed, when the logs are gone. */
async function failedSteps(repo: string, runId: number): Promise<string> {
  type Job = { name: string; conclusion: string | null; html_url: string | null; steps?: { name: string; conclusion: string | null }[] };
  const jobs = await apiPages<Job>(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, (p) => p.jobs as Job[] | undefined).catch(() => []);
  const bad = jobs.filter((j) => FAILED.includes(j.conclusion ?? ""));
  if (!bad.length) return "(no logs and no failed jobs: the run may have been cancelled or its logs expired)";
  return `(no logs: GitHub has none for this run — expired, or a runner that uploads none. The failures were:)\n` +
    bad.map((j) => `  job "${j.name}": step(s) ${(j.steps ?? []).filter((s) => FAILED.includes(s.conclusion ?? "")).map((s) => `"${s.name}"`).join(", ") || "unknown"}` +
      `${j.html_url ? `\n    ${j.html_url}` : ""}`).join("\n");
}

export async function openPrForBranch(repo: string, branch: string): Promise<number | null> {
  const owner = repo.split("/")[0];
  const prs = await api<PR[]>(`repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`);
  return prs[0]?.number ?? null;
}

export async function createPr(repo: string, o: { base: string; head: string; title: string; bodyFile: string }): Promise<number> {
  const url = await must("gh", ["pr", "create", "-R", repo, "--base", o.base, "--head", o.head, "--title", o.title, "--body-file", o.bodyFile]);
  return Number(/\/pull\/(\d+)/.exec(url)?.[1]);
}

export async function editPr(repo: string, n: number, o: { title: string; bodyFile: string }): Promise<void> {
  await must("gh", ["pr", "edit", String(n), "-R", repo, "--title", o.title, "--body-file", o.bodyFile]);
}

/** Close a PR, saying why. */
export async function closePr(repo: string, n: number, why: string): Promise<void> {
  await must("gh", ["pr", "close", String(n), "-R", repo, "--comment", why]);
}

/**
 * Delete a branch on GitHub. "gone" when it isn't there (never pushed, or the
 * repo deletes head branches on merge itself). A PR's commits stay reachable
 * from the PR, and GitHub offers "Restore branch" on it.
 */
export async function deleteBranch(repo: string, branch: string): Promise<"deleted" | "gone"> {
  const r = await run("gh", ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`]);
  if (r.code === 0) return "deleted";
  if (/Reference does not exist|Not Found|\b(404|422)\b/i.test(r.stderr + r.stdout)) return "gone";
  throw new Error(`deleting branch ${branch} failed: ${(r.stderr || r.stdout).trim().slice(-400)}`);
}

export async function comment(repo: string, n: number, body: string): Promise<void> {
  await run("gh", ["issue", "comment", String(n), "-R", repo, "--body-file", "-"], { input: body });
}

/**
 * Append `mark` to a comment, so whoever wrote it can see pr-daemon took it.
 * Reactions can't do this: GitHub only offers eight, and none is the mark.
 * Re-reads the body (it may have been edited since) and does nothing when the
 * mark is already there, so a resumed job doesn't add it twice. Editing
 * doesn't re-trigger: triggers are keyed by comment id.
 */
export async function markComment(repo: string, id: number, mark: string): Promise<void> {
  const c = await api<{ body: string }>(`repos/${repo}/issues/comments/${id}`);
  if (c.body.includes(mark)) return;
  await must("gh", ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "--input", "-"], { input: JSON.stringify({ body: `${c.body.trimEnd()}\n\n${mark}` }) });
}

/** A COMMENT review (you can't approve or request changes on your own PR). */
export async function review(repo: string, n: number, bodyFile: string): Promise<void> {
  const r = await run("gh", ["pr", "review", String(n), "-R", repo, "--comment", "--body-file", bodyFile]);
  if (r.code !== 0) await run("gh", ["pr", "comment", String(n), "-R", repo, "--body-file", bodyFile]);
}

export async function ensureLabels(repo: string, label: string): Promise<void> {
  const labels: [string, string, string][] = [
    [label, "5319e7", "An agent builds this issue (pr-daemon)"],
    [`${label}:working`, "fbca04", "pr-daemon is working on this"],
    [`${label}:in-review`, "0e8a16", "pr-daemon opened a PR; waiting for a human"],
    [`${label}:paused`, "c5def5", "pr-daemon paused this (token budget); resumes automatically"],
    [`${label}:failed`, "d93f0b", "pr-daemon gave up; see the issue comments"],
  ];
  await Promise.all(labels.map(([name, color, desc]) =>
    run("gh", ["label", "create", name, "-R", repo, "--color", color, "--description", desc])));
}

const labelsReady = new Set<string>();

/** Set exactly one of the status labels (or none). Only touches labels the issue has. */
export async function setStatus(repo: string, n: number, label: string, status: "working" | "in-review" | "paused" | "failed" | null): Promise<void> {
  if (!labelsReady.has(repo)) { await ensureLabels(repo, label); labelsReady.add(repo); }
  const want = status ? `${label}:${status}` : null;
  const has = (await api<{ name: string }[]>(`repos/${repo}/issues/${n}/labels`)).map((l) => l.name);
  const statuses = ["working", "in-review", "paused", "failed"].map((s) => `${label}:${s}`);
  for (const l of has) {
    if (statuses.includes(l) && l !== want) await run("gh", ["api", "-X", "DELETE", `repos/${repo}/issues/${n}/labels/${encodeURIComponent(l)}`]);
  }
  if (want && !has.includes(want)) await run("gh", ["api", "-X", "POST", `repos/${repo}/issues/${n}/labels`, "-f", `labels[]=${want}`]);
}
