// One cached clone per repo; every issue branch is a worktree off it.
// Auth goes through `gh auth git-credential`, so no token is written to disk.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./config.ts";
import { must, run, slugify } from "./util.ts";

const key = (repo: string) => repo.replace("/", "__");
export const repoDir = (repo: string) => join(HOME, "repos", key(repo));
export const worktreeRoot = (repo: string) => join(HOME, "worktrees", key(repo));
export const outDir = (repo: string, branch: string) => join(HOME, "out", key(repo), branch);

const git = (dir: string, ...args: string[]) => must("git", ["-C", dir, ...args]);

export async function ensureClone(repo: string): Promise<string> {
  const dir = repoDir(repo);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(join(HOME, "repos"), { recursive: true });
    await must("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
      "clone", "-q", `https://github.com/${repo}.git`, dir]);
  }
  await git(dir, "config", "--replace-all", "credential.https://github.com.helper", "");
  await git(dir, "config", "--add", "credential.https://github.com.helper", "!gh auth git-credential");
  await git(dir, "fetch", "-q", "--prune", "origin");
  await git(dir, "worktree", "prune");
  return dir;
}

/** A remote branch named "<n>-…", if one exists. */
export async function findBranch(repo: string, n: number): Promise<string | null> {
  const out = await git(repoDir(repo), "for-each-ref", "--format=%(refname:lstrip=3)", `refs/remotes/origin/${n}-*`);
  return out.split("\n").find(Boolean) ?? null;
}

export function findWorktree(repo: string, n: number): string | null {
  const root = worktreeRoot(repo);
  if (!existsSync(root)) return null;
  const hit = readdirSync(root).find((d) => d.startsWith(`${n}-`));
  return hit ? join(root, hit) : null;
}

/** "<n>-<very-short-summary>", summary from a small model, falling back to the title. */
export async function makeBranchName(n: number, title: string): Promise<string> {
  const r = await run("claude", ["-p", "--model", "haiku", "--max-turns", "1",
    `Reply with ONLY a 2-4 word lowercase kebab-case summary of this GitHub issue title, nothing else: ${title}`],
    { timeoutMs: 60_000 });
  const slug = slugify(r.code === 0 ? r.stdout.split("\n")[0] : "") || slugify(title) || "issue";
  return `${n}-${slug}`;
}

/** Find or create the worktree for an issue. */
export async function ensureWorktree(repo: string, n: number, base: string, title = ""): Promise<{ branch: string; wt: string }> {
  const dir = repoDir(repo);
  const existing = findWorktree(repo, n);
  if (existing) {
    const branch = await git(existing, "rev-parse", "--abbrev-ref", "HEAD");
    await run("git", ["-C", existing, "pull", "-q", "--ff-only", "origin", branch]);
    return { branch, wt: existing };
  }
  mkdirSync(worktreeRoot(repo), { recursive: true });
  const remote = await findBranch(repo, n);
  if (remote) {
    const wt = join(worktreeRoot(repo), remote);
    await git(dir, "worktree", "add", "-q", "-B", remote, wt, `origin/${remote}`);
    return { branch: remote, wt };
  }
  const branch = await makeBranchName(n, title);
  const wt = join(worktreeRoot(repo), branch);
  await git(dir, "worktree", "add", "-q", "-b", branch, wt, `origin/${base}`);
  return { branch, wt };
}

/** Commit tracked edits the agent left behind. Untracked files (tool caches, logs) are left alone. */
export async function commitLeftovers(wt: string): Promise<string[]> {
  await git(wt, "add", "-u");
  const staged = await run("git", ["-C", wt, "diff", "--cached", "--quiet"]);
  if (staged.code !== 0) await git(wt, "commit", "-q", "-m", "pr-daemon: uncommitted agent changes");
  return (await git(wt, "ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean);
}

/** The commit a worktree is on, to tell "the agent committed something" from "it didn't". */
export async function head(wt: string): Promise<string> {
  return git(wt, "rev-parse", "HEAD");
}

export async function commitsAhead(wt: string, base: string): Promise<number> {
  return Number(await git(wt, "rev-list", "--count", `origin/${base}..HEAD`));
}

export async function push(wt: string, branch: string): Promise<void> {
  const r = await run("git", ["-C", wt, "push", "-q", "-u", "origin", branch]);
  if (r.code === 0) return;
  if (/without `?workflow`? scope/.test(r.stderr)) {
    // gh's default login can't push changes under .github/workflows. That's a
    // useful guard (the agent can't rewrite CI), so say so instead of a raw git error.
    throw new Error(`GitHub refused the push because the branch changes .github/workflows/ and your gh login lacks the "workflow" scope. ` +
      `Either undo the workflow change on ${branch}, or allow it with: gh auth refresh -s workflow`);
  }
  throw new Error(`git push failed: ${r.stderr.trim().slice(-800)}`);
}

export async function removeWorktree(repo: string, wt: string, branch: string): Promise<void> {
  const dir = repoDir(repo);
  const r = await run("git", ["-C", dir, "worktree", "remove", "--force", wt]);
  if (r.code !== 0) await run("rm", ["-rf", wt]);
  await run("git", ["-C", dir, "worktree", "prune"]);
  await run("git", ["-C", dir, "branch", "-D", branch]);
}

// ---------- screenshots ----------
// GitHub has no API to attach images to a PR, so they're committed to an
// orphan branch and linked. In a private repo they render for anyone who can see the PR.
export async function uploadScreenshots(repo: string, branch: string, files: string[], assetsBranch = "pr-daemon-assets"): Promise<string> {
  if (!files.length) return "";
  const dir = join(HOME, "assets", key(repo));
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    await git(dir, "init", "-q");
    await git(dir, "remote", "add", "origin", `https://github.com/${repo}.git`);
  }
  await git(dir, "config", "credential.https://github.com.helper", "!gh auth git-credential");
  const fetched = await run("git", ["-C", dir, "fetch", "-q", "origin", assetsBranch]);
  if (fetched.code === 0) await git(dir, "checkout", "-q", "-B", assetsBranch, "FETCH_HEAD");
  else await run("git", ["-C", dir, "checkout", "-q", "--orphan", assetsBranch]);
  mkdirSync(join(dir, branch), { recursive: true });
  for (const f of files) await must("cp", [f, join(dir, branch)]);
  await git(dir, "add", branch);
  await run("git", ["-C", dir, "commit", "-q", "-m", `screenshots for ${branch}`]);
  await git(dir, "push", "-q", "origin", `HEAD:${assetsBranch}`);
  const sha = await git(dir, "rev-parse", "HEAD");
  return files.map((f) => {
    const name = f.split("/").pop()!, label = name.replace(/\.png$/, "");
    return `**${label}**\n\n![${label}](https://github.com/${repo}/blob/${sha}/${branch}/${name}?raw=true)\n`;
  }).join("\n");
}

// ---------- merging the base branch in ----------
// Always a merge, never a rebase: no force-push, and review comments stay on
// the commits they were made on.

export interface MergeStart {
  /** The base was already in the branch: nothing to do. */
  upToDate: boolean;
  clean: boolean;
  /** The base commit being merged. */
  baseSha: string;
  /** Where base and branch last met: the base's own changes are mergeBase..baseSha. */
  mergeBase: string;
  conflicts: Conflict[];
  /** Git's own words, for the event log when something is odd. */
  output: string;
}

/** `git status` codes for an unmerged path, in plain words. */
export const CONFLICT_KINDS: Record<string, string> = {
  UU: "both modified", AA: "both added", DD: "both deleted",
  AU: "added by this branch", UA: "added by the base",
  DU: "deleted by this branch, changed in the base", UD: "changed in this branch, deleted in the base",
};
export interface Conflict { path: string; code: string; kind: string; binary: boolean }

/** Unmerged paths from `git status --porcelain=v1 -z`. Pure: unit-tested. */
export function parseConflicts(z: string): Omit<Conflict, "binary">[] {
  const out: Omit<Conflict, "binary">[] = [];
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    if (code[0] === "R" || code[0] === "C") i++;   // a rename carries its old path in the next field
    if (CONFLICT_KINDS[code]) out.push({ path: e.slice(3), code, kind: CONFLICT_KINDS[code] });
  }
  return out;
}

/** Unmerged paths right now, with binary ones marked (git leaves no markers in those). */
export async function conflicts(wt: string): Promise<Conflict[]> {
  const z = (await run("git", ["-C", wt, "status", "--porcelain=v1", "-z", "--untracked-files=no"])).stdout;
  const binary = new Set<string>();
  // numstat shows "-\t-\t<path>" for a binary file; for an unmerged path, diff the two sides.
  for (const c of parseConflicts(z)) {
    if (c.code !== "UU" && c.code !== "AA") continue;
    const r = await run("git", ["-C", wt, "diff", "--numstat", `:2:${c.path}`, `:3:${c.path}`]);
    if (/^-\t-\t/m.test(r.stdout)) binary.add(c.path);
  }
  return parseConflicts(z).map((c) => ({ ...c, binary: binary.has(c.path) }));
}

/**
 * Fetch the base and merge it into the worktree's branch. A clean merge is
 * committed; a conflicted one is left in progress (MERGE_HEAD set, markers in
 * the files) for an agent or a human to finish.
 */
export async function startMerge(wt: string, base: string, branch: string): Promise<MergeStart> {
  await git(wt, "fetch", "-q", "origin", base);
  const baseSha = await git(wt, "rev-parse", `origin/${base}`);
  const mergeBase = await git(wt, "merge-base", "HEAD", baseSha);
  if (mergeBase === baseSha) return { upToDate: true, clean: true, baseSha, mergeBase, conflicts: [], output: "" };
  const r = await run("git", ["-C", wt, "-c", "merge.conflictstyle=diff3", "merge", "--no-ff", "--no-edit",
    "-m", `Merge ${base} into ${branch}`, baseSha]);
  const output = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code === 0) return { upToDate: false, clean: true, baseSha, mergeBase, conflicts: [], output };
  if (!(await mergeInProgress(wt))) throw new Error(`git merge failed before it started: ${output.slice(-800)}`);
  return { upToDate: false, clean: false, baseSha, mergeBase, conflicts: await conflicts(wt), output };
}

export async function mergeInProgress(wt: string): Promise<boolean> {
  return (await run("git", ["-C", wt, "rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
}

/** Throw the merge away and go back to `to` (the branch's head before it). */
export async function abortMerge(wt: string, to: string): Promise<void> {
  if (await mergeInProgress(wt)) await run("git", ["-C", wt, "merge", "--abort"]);
  await git(wt, "reset", "-q", "--hard", to);
}

/** Keep a copy of an attempt that isn't being pushed, so a human can look at it. */
export async function keepAttempt(wt: string, name: string): Promise<void> {
  await git(wt, "branch", "-f", name, "HEAD");
}

export async function isAncestor(wt: string, a: string, b: string): Promise<boolean> {
  return (await run("git", ["-C", wt, "merge-base", "--is-ancestor", a, b])).code === 0;
}

export async function parents(wt: string, rev = "HEAD"): Promise<string[]> {
  return (await git(wt, "rev-list", "--parents", "-n", "1", rev)).split(" ").slice(1);
}

/** Files that differ between two commits, optionally under some paths. */
export async function changedFiles(wt: string, a: string, b: string, ...paths: string[]): Promise<string[]> {
  return (await git(wt, "diff", "--name-only", a, b, ...(paths.length ? ["--", ...paths] : []))).split("\n").filter(Boolean);
}

/** No tracked file changed, staged or not. */
export async function isClean(wt: string): Promise<boolean> {
  return (await git(wt, "status", "--porcelain", "--untracked-files=no")) === "";
}

/** The base's commits since the branch left it that touch these files: what the other side meant. */
export async function baseLog(wt: string, mergeBase: string, baseSha: string, files: string[]): Promise<string> {
  const r = await run("git", ["-C", wt, "log", "--no-merges", "--format=%h %an: %s", "-n", "40", `${mergeBase}..${baseSha}`, "--", ...files]);
  return r.stdout.trim();
}

/** Stage what's resolved and finish the merge with git's own message. */
export async function commitMerge(wt: string): Promise<void> {
  await git(wt, "add", "-u");
  await git(wt, "commit", "-q", "--no-edit");
}
