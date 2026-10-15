// GitHub through the `gh` CLI, as the logged-in user. No tokens are stored by
// pr-demon; `gh` (and git, via `gh auth git-credential`) use your own login.
import { must, run } from "./util.ts";

async function api<T>(path: string, args: string[] = []): Promise<T> {
  return JSON.parse((await must("gh", ["api", ...args, path])) || "null") as T;
}

/** All pages of a list endpoint, flattened. */
async function apiAll<T>(path: string): Promise<T[]> {
  const out = await must("gh", ["api", "--paginate", "--slurp", path]);
  return (JSON.parse(out) as T[][]).flat();
}

let viewerLogin: string | undefined;
export async function viewer(): Promise<string> {
  viewerLogin ??= (await api<{ login: string }>("user")).login;
  return viewerLogin;
}

export async function defaultBranch(repo: string): Promise<string> {
  return (await api<{ default_branch: string }>(`repos/${repo}`)).default_branch;
}

export interface Issue { number: number; title: string; body: string | null; state: string; html_url: string; pull_request?: unknown }

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

export interface PR { number: number; state: string; merged_at: string | null; head: { ref: string }; base: { ref: string }; html_url: string }

export async function pr(repo: string, n: number): Promise<PR> {
  return api<PR>(`repos/${repo}/pulls/${n}`);
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

export async function comment(repo: string, n: number, body: string): Promise<void> {
  await run("gh", ["issue", "comment", String(n), "-R", repo, "--body-file", "-"], { input: body });
}

/** A COMMENT review (you can't approve or request changes on your own PR). */
export async function review(repo: string, n: number, bodyFile: string): Promise<void> {
  const r = await run("gh", ["pr", "review", String(n), "-R", repo, "--comment", "--body-file", bodyFile]);
  if (r.code !== 0) await run("gh", ["pr", "comment", String(n), "-R", repo, "--body-file", bodyFile]);
}

export async function ensureLabels(repo: string, label: string): Promise<void> {
  const labels: [string, string, string][] = [
    [label, "5319e7", "An agent builds this issue (pr-demon)"],
    [`${label}:working`, "fbca04", "pr-demon is working on this"],
    [`${label}:in-review`, "0e8a16", "pr-demon opened a PR; waiting for a human"],
    [`${label}:paused`, "c5def5", "pr-demon paused this (token budget); resumes automatically"],
    [`${label}:failed`, "d93f0b", "pr-demon gave up; see the issue comments"],
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
