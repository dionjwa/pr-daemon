// Keeping a PR mergeable with its base: the decisions, kept pure so they can
// be unit-tested. The git side is in git.ts, the job in pipeline.ts (merge).
//
// The rule throughout: automate the routine, and hand anything risky or
// uncertain to a human — loudly, on the PR, on the status page and as a
// desktop notification — rather than pushing a guess.
import type { Conflict } from "./git.ts";

/** A glob as a path test: `*` stays within a directory, `**` crosses them, a trailing `/` means everything under it. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.endsWith("/") ? `${glob}**` : glob;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export interface Assessment {
  /** Reasons an agent must not try: a human resolves these. */
  blockers: string[];
  /** The agent may try, but a human should look at the result before merging. */
  cautions: string[];
}

/**
 * Whether conflicts are an agent's to resolve. Blockers:
 * - more conflicted files than `maxFiles` (too big a change to hand over),
 * - a binary file (there is nothing to merge, only a side to pick),
 * - a path in `humanPaths`, the owner's list of things to decide themselves,
 * - `.github/workflows/`: pr-daemon can't push those, so a resolution can't land,
 * - the base changed workflow files and the gh login can't push them (`workflowsBlocked`).
 * Cautions: conflicts that aren't about lines (one side deleted or added the
 * file), where "keep both" has no obvious meaning.
 */
export function assessConflicts(conflicts: Conflict[], o: { maxFiles: number; humanPaths: string[]; workflowsBlocked: boolean }): Assessment {
  const blockers: string[] = [], cautions: string[] = [];
  const list = (cs: Conflict[]) => cs.map((c) => `\`${c.path}\``).join(", ");
  if (conflicts.length > o.maxFiles) blockers.push(`${conflicts.length} files conflict, more than \`merge.max_files = ${o.maxFiles}\``);
  const binary = conflicts.filter((c) => c.binary);
  if (binary.length) blockers.push(`binary file(s) conflict, so one side has to be picked: ${list(binary)}`);
  const pats = o.humanPaths.map((p) => [p, globToRegExp(p)] as const);
  const human = conflicts.filter((c) => pats.some(([, re]) => re.test(c.path)));
  if (human.length) blockers.push(`conflicts in paths \`merge.human_paths\` reserves for you: ${list(human)}`);
  const wf = conflicts.filter((c) => c.path.startsWith(".github/workflows/"));
  if (wf.length) blockers.push(`workflow file(s) conflict, and pr-daemon never edits .github/workflows/: ${list(wf)}`);
  else if (o.workflowsBlocked) blockers.push("the base changed .github/workflows/ and your gh login lacks the `workflow` scope, so GitHub would refuse the merge commit");
  const structural = conflicts.filter((c) => !["UU", "AA"].includes(c.code) && !c.binary);
  if (structural.length) cautions.push(`not a line conflict, so check the choice made: ${structural.map((c) => `\`${c.path}\` (${c.kind})`).join(", ")}`);
  return { blockers, cautions };
}

/** Lines git writes into a conflicted file. `=======` alone is too common (setext headings) to count. */
const MARKER = /^(<{7}|>{7}|\|{7})(?: |$)/m;
export const hasConflictMarkers = (text: string): boolean => MARKER.test(text);

export interface MergeReport { confidence: "high" | "low" | "unknown"; needsHuman: string[] }

/**
 * The agent ends merge-report.md with `CONFIDENCE: high|low` and
 * `NEEDS_HUMAN: none` (or one item per line after it). Anything missing or
 * unreadable counts as uncertain: a report we can't read isn't a "high".
 */
export function parseMergeReport(text: string): MergeReport {
  const conf = /^\s*\**CONFIDENCE\**\s*:\s*\**\s*(high|low)\b/im.exec(text)?.[1]?.toLowerCase();
  const at = text.search(/^\s*\**NEEDS_HUMAN\**\s*:/im);
  let needsHuman: string[] = [];
  if (at >= 0) {
    const [first, ...rest] = text.slice(at).split("\n");
    const inline = first.replace(/^\s*\**NEEDS_HUMAN\**\s*:\s*\**/i, "").trim();
    const items = [inline, ...rest.map((l) => l.trim()).filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, ""))];
    needsHuman = items.filter((l) => l && !/^(none|nothing|n\/a|-)\.?$/i.test(l));
  }
  return { confidence: conf === "high" || conf === "low" ? conf : "unknown", needsHuman };
}

/** Why a human should look at a pushed resolution before merging. Empty: nothing beyond the usual review. */
export function reviewReasons(r: MergeReport, cautions: string[], extraFiles: string[], checkOk: boolean | null): string[] {
  return [
    ...(r.confidence === "low" ? ["the agent wasn't confident in its resolution"] : []),
    ...(r.confidence === "unknown" ? ["the agent's report gave no confidence, so treat it as low"] : []),
    ...r.needsHuman.map((s) => `the agent flagged: ${s}`),
    ...cautions,
    ...(extraFiles.length ? [`it also changed file(s) neither side's conflict touched: ${extraFiles.map((f) => `\`${f}\``).join(", ")}`] : []),
    ...(checkOk === null ? ["there is no local check, so nothing ran the merged code before it was pushed"] : []),
  ];
}

/** What the poll knows about a PR when deciding whether to catch it up with its base. */
export interface CatchUpState {
  /** gh.mergeability(): only "ok" and "behind" can be caught up. */
  mergeable: string;
  /** Whether the repo's CI is watched at all (`checks.watch`). */
  checksWatched: boolean;
  /** The last checks verdict the poll stored, and the head commit it was for. */
  checksState: string;
  checksSha: string;
  headSha: string;
  /** The newest job on the branch that actually ran (not ignored), if any. */
  lastJob?: { state: string };
  /** A pushed merge is marked "needs your review" (merge_level = warn). */
  needsReview: boolean;
  /** The PR head hasn't moved since a failure or a review flag was first seen. */
  held: boolean;
}

/**
 * Why an idle PR shouldn't be caught up with its base right now, or null when
 * it should. "Idle" is the caller's part (nothing queued, running or paused on
 * the branch); this is the rest: it merges, its own CI isn't red on the
 * current head (still running is fine), and nothing is waiting on a person. A failure or a "needs your review"
 * holds only until the PR head moves, which is what a person fixing it does.
 */
export function catchUpBlocker(s: CatchUpState): string | null {
  if (s.mergeable !== "ok" && s.mergeable !== "behind") return s.mergeable === "unknown" ? "GitHub hasn't worked out mergeability yet" : `mergeability is ${s.mergeable}`;
  // Only a red verdict on the current head blocks. Pending (or not reported
  // yet) doesn't: those checks run on a head that's about to be replaced by
  // the merge, so waiting for them only means running them twice.
  if (s.checksWatched && s.checksSha === s.headSha && s.checksState === "failure") return "checks are failing";
  if (s.held && s.lastJob && ["failed", "cancelled"].includes(s.lastJob.state)) return `the last job ${s.lastJob.state}; waiting for a person`;
  if (s.held && s.needsReview) return "a merge is waiting for your review";
  return null;
}
