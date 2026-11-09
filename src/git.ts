// One cached clone per repo; every issue branch is a worktree off it.
// Auth goes through `gh auth git-credential`, so no token is written to disk.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { claudeEnv } from "./agent.ts";
import { HOME } from "./config.ts";
import { must, run, sleep, slugify } from "./util.ts";

const key = (repo: string) => repo.replace("/", "__");
export const repoDir = (repo: string) => join(HOME, "repos", key(repo));
export const worktreeRoot = (repo: string) => join(HOME, "worktrees", key(repo));
export const outDir = (repo: string, branch: string) => join(HOME, "out", key(repo), branch);
export const refsDir = (repo: string, branch: string) => join(HOME, "refs", key(repo), branch);

// Every worktree shares the clone's .git (config, refs), and jobs on different
// branches of one repo run at once, so git's lock files can collide: two merge
// jobs started together both rewrote .git/config and one failed with "could
// not lock config file". A command that hits a lock did nothing, so try again.
const LOCKED = /could not lock config file|cannot lock ref|\.lock'?: File exists/i;
async function git(dir: string, ...args: string[]): Promise<string> {
  for (let i = 0; ; i++) {
    try { return await must("git", ["-C", dir, ...args]); }
    catch (e) { if (i >= 5 || !LOCKED.test((e as Error).message)) throw e; await sleep(200 * 2 ** i); }
  }
}

const HELPERS = ["", "!gh auth git-credential"];
const syncing = new Map<string, Promise<string>>();

/** Clone (once) and fetch. One at a time per repo: it writes the shared config and refs. */
export function ensureClone(repo: string): Promise<string> {
  const next = (syncing.get(repo) ?? Promise.resolve("")).catch(() => "").then(() => syncClone(repo));
  syncing.set(repo, next);
  return next;
}

async function syncClone(repo: string): Promise<string> {
  const dir = repoDir(repo);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(join(HOME, "repos"), { recursive: true });
    await must("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
      "clone", "-q", `https://github.com/${repo}.git`, dir]);
  }
  // Reading takes no lock: only write the helpers when they aren't already set.
  const have = await run("git", ["-C", dir, "config", "--get-all", "credential.https://github.com.helper"]);
  if (have.stdout.replace(/\n$/, "").split("\n").join("\0") !== HELPERS.join("\0")) {
    await git(dir, "config", "--replace-all", "credential.https://github.com.helper", HELPERS[0]);
    await git(dir, "config", "--add", "credential.https://github.com.helper", HELPERS[1]);
  }
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
    { timeoutMs: 60_000, env: claudeEnv() });
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

/**
 * Find or create the worktree for a branch that already exists on the remote.
 * Keyed by the branch itself, not by an issue number: pr-daemon names its own
 * branches "<issue>-<summary>", but a PR it adopted was named by somebody else
 * and can look like anything (slashes included, hence the mkdir).
 */
export async function ensureBranchWorktree(repo: string, branch: string): Promise<string> {
  const wt = join(worktreeRoot(repo), branch);
  if (existsSync(join(wt, ".git"))) {
    await run("git", ["-C", wt, "pull", "-q", "--ff-only", "origin", branch]);
    return wt;
  }
  mkdirSync(dirname(wt), { recursive: true });
  await git(repoDir(repo), "worktree", "add", "-q", "-B", branch, wt, `origin/${branch}`);
  return wt;
}

/**
 * A detached checkout of the base for an agent that only talks about an
 * issue: no branch, so nothing it does can be pushed, and `removeDetached()`
 * deletes it after every run. The path is fixed (`<worktrees>/<dir>`) because
 * Claude keys its sessions on the working directory, and the next comment
 * resumes the same conversation from the same place.
 */
export async function detachedWorktree(repo: string, dir: string, base: string): Promise<string> {
  const wt = join(worktreeRoot(repo), dir);
  if (existsSync(wt)) await removeDetached(repo, wt);
  mkdirSync(worktreeRoot(repo), { recursive: true });
  await git(repoDir(repo), "worktree", "add", "-q", "--detach", wt, `origin/${base}`);
  return wt;
}

export async function removeDetached(repo: string, wt: string): Promise<void> {
  const r = await run("git", ["-C", repoDir(repo), "worktree", "remove", "--force", wt]);
  if (r.code !== 0) await run("rm", ["-rf", wt]);
  await run("git", ["-C", repoDir(repo), "worktree", "prune"]);
}

// ---------------------------------------------------------------- references
// Another repository, read-only, for an agent that has to look at code it
// isn't working on ("do it the way <other repo> does"). `gh` is the owner's
// own login, so every repository they can read is already reachable; what was
// missing is somewhere to put the clone that cannot disturb the target repo.

/** The repository root of a directory the agent is working in. */
export const topLevel = (dir: string) => git(dir, "rev-parse", "--show-toplevel");

/**
 * Where a worktree's references live: the path mapping `pr-daemon ref` uses,
 * so it needs no configuration and no database. A worktree is
 * `<HOME>/worktrees/<org>__<repo>/<branch>`; its references sit under
 * `<HOME>/refs/` at the same place, i.e. refsDir() for that repo and branch.
 * "" for a directory that isn't one of pr-daemon's worktrees. Pure.
 */
export function refsFor(worktree: string, home = HOME): string {
  const root = resolve(home, "worktrees") + sep;
  const abs = resolve(worktree) + sep;
  if (!abs.startsWith(root)) return "";
  const rest = abs.slice(root.length, -1);
  return rest ? join(home, "refs", rest) : "";
}

/**
 * A read-only shallow clone of `repo` under `refs`, and its path. Idempotent:
 * an existing clone is fetched and moved to the new tip, so a resumed session
 * doesn't pay for it twice.
 *
 * The clone lives outside the worktree, so nothing in it reaches the target
 * repo's index, its check or its build context. Pushing is disabled rather
 * than merely discouraged (an agent cannot write to somebody else's
 * repository), and so are the clone's own hooks.
 */
export async function addReference(refs: string, repo: string, branch = ""): Promise<string> {
  const dir = join(refs, key(repo));
  const auth = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(refs, { recursive: true });
    await must("git", [...auth, "clone", "-q", "--depth", "1", "--single-branch", "--no-tags",
      ...(branch ? ["--branch", branch] : []), `https://github.com/${repo}.git`, dir]);
  } else {
    // Update the branch the clone is already on (or switch to the one asked
    // for), and check the fetched tip out under that same name: a clone must
    // never end up labelled with one branch while holding another's code.
    const target = branch || (await git(dir, "rev-parse", "--abbrev-ref", "HEAD"));
    await must("git", ["-C", dir, ...auth, "fetch", "-q", "--depth", "1", "--no-tags", "origin", target]);
    await git(dir, "checkout", "-q", "--force", ...(target === "HEAD" ? ["--detach"] : ["-B", target]), "FETCH_HEAD");
  }
  await git(dir, "config", "remote.origin.pushurl", "/dev/null");
  await git(dir, "config", "core.hooksPath", "/dev/null");
  return dir;
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

/**
 * Commits on this branch that the remote hasn't got: what a push would send.
 * Asked instead of comparing HEAD against a snapshot, because a job that
 * paused mid-round resumes with its earlier rounds already committed here.
 */
export async function unpushed(wt: string, branch: string): Promise<number> {
  const r = await run("git", ["-C", wt, "rev-list", "--count", `origin/${branch}..HEAD`]);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

const WORKFLOWS = ".github/workflows";

/**
 * Take `.github/workflows/` edits out of the commits a push would send, and
 * keep everything else. GitHub refuses a push in which *any* commit touches a
 * workflow file (without the `workflow` scope), so a revert on top wouldn't
 * do: the unpushed commits are squashed into one without the workflow change.
 * Returns what was taken out, or null when there was nothing to take out, or
 * when the unpushed commits include a merge (squashing that would flatten
 * the base's history; the merge job has its own way round, `viaGitHub`).
 */
export async function stripWorkflows(wt: string): Promise<{ files: string[]; patch: string } | null> {
  const commits = (await git(wt, "rev-list", "--parents", "HEAD", "--not", "--remotes=origin")).split("\n").filter(Boolean);
  if (!commits.length || commits.some((l) => l.split(" ").length !== 2)) return null;
  const from = commits.at(-1)!.split(" ")[1];   // newest first: the oldest unpushed commit's parent
  const files = await changedFiles(wt, from, "HEAD", WORKFLOWS);
  if (!files.length) return null;
  const patch = await git(wt, "diff", from, "HEAD", "--", WORKFLOWS);
  const messages = (await git(wt, "log", "--reverse", "--format=%B%x00", `${from}..HEAD`)).split("\0").map((m) => m.trim()).filter(Boolean);
  await git(wt, "reset", "-q", "--soft", from);
  // Files the commits added go too: restore deletes what `from` doesn't have.
  const existed = await git(wt, "ls-tree", "--name-only", from, `${WORKFLOWS}/`);
  if (existed) await git(wt, "restore", `--source=${from}`, "--staged", "--worktree", "--", WORKFLOWS);
  else await git(wt, "rm", "-q", "-r", "-f", "--", WORKFLOWS);
  const staged = await run("git", ["-C", wt, "diff", "--cached", "--quiet"]);
  if (staged.code !== 0) {
    await git(wt, "commit", "-q", "-m", `${messages.join("\n\n")}\n\npr-daemon took out the change to ${files.join(", ")}: it can't push workflow files. It's on the PR for a human to apply.`);
  }
  return { files, patch };
}

/** Does the remote have this branch? Unknown (a network error) counts as yes, so nothing is done on a guess. */
export async function onRemote(wt: string, branch: string): Promise<boolean> {
  return (await run("git", ["-C", wt, "ls-remote", "--exit-code", "--heads", "origin", branch])).code !== 2;
}

/**
 * Merge the base in when a branch GitHub hasn't seen yet would carry older
 * `.github/workflows/` than the base has. A new branch has no old tip, so
 * GitHub compares it with the default branch, and a workflow change that
 * landed there while the agent worked looks like this branch undoing it: the
 * push is refused for the `workflow` scope although no commit of ours touches
 * a workflow file (superslides.io #204 and #205). Merging the base in makes
 * them match, which GitHub accepts. Run it after `stripWorkflows()`: that one
 * won't squash across a merge. Returns the workflow files that differed ([]
 * when nothing was done); throws, with the merge undone, when it conflicts.
 */
export async function catchUpWorkflows(wt: string, base: string, branch: string): Promise<string[]> {
  if (await onRemote(wt, branch)) return [];
  await git(wt, "fetch", "-q", "origin", base);
  const files = await changedFiles(wt, "HEAD", `origin/${base}`, WORKFLOWS);
  if (!files.length) return [];
  const before = await git(wt, "rev-parse", "HEAD");
  const m = await startMerge(wt, base, branch);
  if (m.clean) return files;
  await abortMerge(wt, before);
  throw new Error(`GitHub would refuse the push: ${base} changed ${files.join(", ")} since ${branch} started, ` +
    `and pr-daemon's gh login lacks the "workflow" scope, so ${branch} has to include that change. Merging ${base} in conflicts ` +
    `(${m.conflicts.map((c) => c.path).join(", ")}). Merge it yourself, then press Resume on the job (status page):\n` +
    `cd ${wt} && git fetch origin && git merge origin/${base}   # resolve, then: git commit --no-edit`);
}

/**
 * The PR comment for a workflow change `stripWorkflows()` held back: every
 * step the human needs, ready to paste. The diff rides in a heredoc, so the
 * shell block applies it in one go; secrets the change refers to get their
 * `gh secret set` lines, since without them the change does nothing.
 */
export function heldWorkflowComment(o: { repo: string; branch: string; files: string[]; patch: string }): string {
  const files = o.files.map((f) => `\`${f}\``).join(", ");
  const added = o.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  const secrets = [...new Set([...added.matchAll(/\$\{\{\s*secrets\.(\w+)/g)].map((m) => m[1]))].filter((s) => s !== "GITHUB_TOKEN");
  const fence = "`".repeat(Math.max(3, ...(o.patch.match(/`+/g) ?? []).map((t) => t.length + 1)));
  return `> [!WARNING]
> **pr-daemon** held back its agent's change to ${files}: its gh login can't push workflow files, which keeps agents out of CI and its secrets. The rest of the work is pushed. **Apply this yourself if you want it**; until then CI runs without it.

**To apply it**, from your own checkout of ${o.repo} (your usual git login can push workflow files; pr-daemon's can't):

${fence}bash
git fetch origin && git checkout ${o.branch} && git pull --ff-only
git apply <<'PR_DAEMON_DIFF'
${o.patch}
PR_DAEMON_DIFF
git add -- .github/workflows && git commit -m "ci: apply the workflow change pr-daemon held back" && git push
${fence}
${secrets.length ? `
**It uses ${secrets.length === 1 ? "a secret" : "secrets"} the repo may not have yet.** Set ${secrets.length === 1 ? "it" : "them"} first (each command asks for the value):

\`\`\`bash
${secrets.map((s) => `gh secret set ${s} -R ${o.repo}`).join("\n")}
\`\`\`

or in the browser: https://github.com/${o.repo}/settings/secrets/actions
` : ""}
Or in the browser: open each file on \`${o.branch}\` (https://github.com/${o.repo}/tree/${o.branch}/.github/workflows), press the pencil and make the \`+\` lines above, committing to \`${o.branch}\`.

Not wanted? Do nothing: the PR works without it.`;
}

export async function push(wt: string, branch: string): Promise<void> {
  const r = await run("git", ["-C", wt, "push", "-q", "-u", "origin", branch]);
  if (r.code === 0) return;
  if (/without `?workflow`? scope/.test(r.stderr)) {
    // gh's default login can't push changes under .github/workflows. That's a
    // useful guard (the agent can't rewrite CI), so say so instead of a raw git error.
    // Agent work goes through pipeline's pushWork(), which strips such changes first.
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
