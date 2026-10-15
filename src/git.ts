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
  if (staged.code !== 0) await git(wt, "commit", "-q", "-m", "pr-demon: uncommitted agent changes");
  return (await git(wt, "ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean);
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
export async function uploadScreenshots(repo: string, branch: string, files: string[], assetsBranch = "pr-demon-assets"): Promise<string> {
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
