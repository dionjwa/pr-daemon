import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessConflicts, globToRegExp, hasConflictMarkers, parseMergeReport, reviewReasons } from "./merge.ts";
import * as git from "./git.ts";
import type { Conflict } from "./git.ts";
import { DEFAULT_TOML, parseConfig } from "./config.ts";
import { AGENT_KINDS, openDb, PRIORITY, Store } from "./db.ts";
import { mergeability } from "./gh.ts";

const c = (path: string, code = "UU", binary = false): Conflict => ({ path, code, kind: git.CONFLICT_KINDS[code], binary });
const opts = { maxFiles: 15, humanPaths: [] as string[], workflowsBlocked: false };

test("globs: * stays in a folder, ** crosses them, a trailing / is everything under it", () => {
  assert.ok(globToRegExp("*.lock").test("yarn.lock"));
  assert.ok(!globToRegExp("*.lock").test("sub/yarn.lock"));
  assert.ok(globToRegExp("**/*.lock").test("sub/yarn.lock"));
  assert.ok(globToRegExp("**/*.lock").test("yarn.lock"));
  assert.ok(globToRegExp("db/migrations/**").test("db/migrations/2026/01_init.sql"));
  assert.ok(globToRegExp("db/migrations/").test("db/migrations/01.sql"));
  assert.ok(!globToRegExp("db/migrations/").test("db/migrationsX/01.sql"));
  assert.ok(globToRegExp("src/a.ts").test("src/a.ts") && !globToRegExp("src/a.ts").test("src/aXts"));
});

test("conflicts: what goes to an agent, and what goes to a person", () => {
  assert.deepEqual(assessConflicts([c("src/a.ts"), c("README.md", "AA")], opts), { blockers: [], cautions: [] });
  // Too many, binary, the owner's paths, workflow files, and workflow changes the login can't push: a person's call.
  assert.match(assessConflicts(Array.from({ length: 16 }, (_, i) => c(`f${i}`)), opts).blockers[0], /16 files conflict/);
  assert.match(assessConflicts([c("logo.png", "UU", true)], opts).blockers[0], /binary.*logo\.png/);
  assert.match(assessConflicts([c("db/migrations/3.sql")], { ...opts, humanPaths: ["db/migrations/**"] }).blockers[0], /human_paths.*3\.sql/);
  assert.match(assessConflicts([c(".github/workflows/ci.yml")], opts).blockers[0], /never edits \.github\/workflows/);
  assert.match(assessConflicts([c("src/a.ts")], { ...opts, workflowsBlocked: true }).blockers[0], /workflow` scope/);
  // Deleted on one side: the agent may try, but a person should look.
  const a = assessConflicts([c("src/old.ts", "UD")], opts);
  assert.deepEqual(a.blockers, []);
  assert.match(a.cautions[0], /old\.ts.*deleted in the base/);
});

test("conflict markers, but not a markdown heading underline", () => {
  assert.ok(hasConflictMarkers("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n"));
  assert.ok(hasConflictMarkers("a\n||||||| base\n"));
  assert.ok(!hasConflictMarkers("Title\n=======\n\ntext"));
  assert.ok(!hasConflictMarkers("x <<<<<<< not at line start"));
});

test("the agent's report: confidence and flags, and silence counts as doubt", () => {
  assert.deepEqual(parseMergeReport("## a.ts\nkept both\n\nCONFIDENCE: high\nNEEDS_HUMAN: none\n"), { confidence: "high", needsHuman: [] });
  assert.deepEqual(parseMergeReport("**CONFIDENCE:** low\n**NEEDS_HUMAN:**\n- the retry count: base says 3, branch says 5\n- check the copy\n"),
    { confidence: "low", needsHuman: ["the retry count: base says 3, branch says 5", "check the copy"] });
  assert.deepEqual(parseMergeReport("CONFIDENCE: high\nNEEDS_HUMAN: whether the flag should default on"),
    { confidence: "high", needsHuman: ["whether the flag should default on"] });
  assert.equal(parseMergeReport("").confidence, "unknown");
  // A confident report with nothing flagged, a passing check and nothing extra is the only quiet case.
  assert.deepEqual(reviewReasons(parseMergeReport("CONFIDENCE: high\nNEEDS_HUMAN: none"), [], [], true), []);
  assert.equal(reviewReasons(parseMergeReport(""), [], [], true).length, 1);
  assert.match(reviewReasons(parseMergeReport("CONFIDENCE: high\nNEEDS_HUMAN: none"), [], ["src/x.ts"], true)[0], /x\.ts/);
  assert.match(reviewReasons(parseMergeReport("CONFIDENCE: high\nNEEDS_HUMAN: none"), [], [], null)[0], /no local check/);
});

test("unmerged paths from git status -z, renames included", () => {
  assert.deepEqual(git.parseConflicts("UU src/a.ts\0M  ok.ts\0R  new.ts\0old.ts\0UD gone.ts\0AA two words.md\0"), [
    { path: "src/a.ts", code: "UU", kind: "both modified" },
    { path: "gone.ts", code: "UD", kind: "changed in this branch, deleted in the base" },
    { path: "two words.md", code: "AA", kind: "both added" },
  ]);
});

test("GitHub's mergeability, in one word", () => {
  assert.equal(mergeability({ mergeable: false, mergeable_state: "dirty" }), "conflicts");
  assert.equal(mergeability({ mergeable: null, mergeable_state: "unknown" }), "unknown");
  assert.equal(mergeability({ mergeable: true, mergeable_state: "behind" }), "behind");
  assert.equal(mergeability({ mergeable: true, mergeable_state: "blocked" }), "ok");
  assert.equal(mergeability({}), "unknown");
});

test("merge config, queue order, and the round count", () => {
  assert.deepEqual(parseConfig(DEFAULT_TOML).merge, { watch: true, fix: true, behind: false, maxRounds: 2, maxFiles: 15, humanPaths: [] });
  assert.deepEqual(parseConfig(`[merge]\nhuman_paths = ["db/**"]\nmax_rounds = 0`).merge.humanPaths, ["db/**"]);
  assert.throws(() => parseConfig(`[merge]\nhuman_paths = "db/**"`), /merge.human_paths/);
  assert.throws(() => parseConfig(`[merge]\nbehind = 1`), /merge.behind/);
  assert.ok(PRIORITY.merge < PRIORITY.ci && PRIORITY.merge > PRIORITY.restart);
  assert.ok(AGENT_KINDS.includes("merge"));
  // Only runs that spent tokens are rounds: a clean merge (no agent) or a hand-over doesn't use one up.
  const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), "prd-")), "t.db")));
  const a = store.enqueue({ repo: "o/r", kind: "merge", number: 7, trigger_key: "merge:o/r#7:aaa" })!;
  store.enqueue({ repo: "o/r", kind: "merge", number: 7, trigger_key: "merge:o/r#7:bbb" });
  assert.equal(store.countAgentRuns("o/r", "merge", 7), 0);
  store.update(a, { tokens: 1000 });
  assert.equal(store.countAgentRuns("o/r", "merge", 7), 1);
  assert.equal(store.countAgentRuns("o/r", "merge", 7, a), 0);
});

// ---------------------------------------------------------------- real git
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** An origin with main, a clone on a feature branch, and main moved on with the given change. */
function repoWith(branchEdit: string, mainEdit: string): { wt: string; before: string } {
  const root = mkdtempSync(join(tmpdir(), "prd-merge-"));
  const origin = join(root, "origin.git"), wt = join(root, "wt");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, wt], { stdio: "ignore" });
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) sh(wt, "config", k, v);
  writeFileSync(join(wt, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(wt, "b.txt"), "b\n");
  sh(wt, "add", "."); sh(wt, "commit", "-qm", "init"); sh(wt, "push", "-q", "origin", "HEAD:main");
  sh(wt, "checkout", "-qb", "7-feature");
  writeFileSync(join(wt, "a.txt"), branchEdit); sh(wt, "commit", "-qam", "branch");
  const before = sh(wt, "rev-parse", "HEAD");
  // main moves on, from another checkout's point of view
  sh(wt, "checkout", "-q", "main");
  writeFileSync(join(wt, "a.txt"), mainEdit); writeFileSync(join(wt, "c.txt"), "new on main\n");
  sh(wt, "add", "."); sh(wt, "commit", "-qm", "main moves"); sh(wt, "push", "-q", "origin", "main");
  sh(wt, "reset", "-q", "--hard", "HEAD~1"); sh(wt, "checkout", "-q", "7-feature");
  return { wt, before };
}

test("a clean merge is committed with both parents", async () => {
  const { wt, before } = repoWith("one\ntwo\nthree\nfour\n", "zero\none\ntwo\nthree\n");
  const m = await git.startMerge(wt, "main", "7-feature");
  assert.equal(m.clean, true);
  assert.deepEqual(await git.parents(wt), [before, m.baseSha]);
  assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "zero\none\ntwo\nthree\nfour\n");
  assert.deepEqual(await git.changedFiles(wt, m.mergeBase, m.baseSha), ["a.txt", "c.txt"]);
  assert.equal((await git.startMerge(wt, "main", "7-feature")).upToDate, true);
});

test("a conflict is left in progress, resolved, committed; or thrown away", async () => {
  const { wt, before } = repoWith("one\nTWO (branch)\nthree\n", "one\nTWO (main)\nthree\n");
  const m = await git.startMerge(wt, "main", "7-feature");
  assert.equal(m.clean, false);
  assert.deepEqual(m.conflicts, [{ path: "a.txt", code: "UU", kind: "both modified", binary: false }]);
  assert.ok(await git.mergeInProgress(wt));
  assert.ok(hasConflictMarkers(readFileSync(join(wt, "a.txt"), "utf8")));
  assert.match(await git.baseLog(wt, m.mergeBase, m.baseSha, ["a.txt"]), /main moves/);

  // Thrown away: back exactly where it was.
  await git.abortMerge(wt, before);
  assert.equal(await git.mergeInProgress(wt), false);
  assert.equal(await git.head(wt), before);
  assert.ok(await git.isClean(wt));

  // Resolved: markers gone, and pr-daemon's commit is a real merge.
  const again = await git.startMerge(wt, "main", "7-feature");
  writeFileSync(join(wt, "a.txt"), "one\nTWO (branch and main)\nthree\n");
  await git.commitMerge(wt);
  assert.deepEqual(await git.parents(wt), [before, again.baseSha]);
  assert.ok(await git.isAncestor(wt, before, "HEAD"));
  assert.equal(readFileSync(join(wt, "c.txt"), "utf8"), "new on main\n");
});
