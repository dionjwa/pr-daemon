// A project's preview stack, driven by its own commands. Each is an arbitrary
// shell command line (see sh()); the `just pr-daemon-*` defaults are only a
// convention, and the one just-aware bit is missingRecipe() below.
import { run, sh, tail } from "./util.ts";

const UP_TIMEOUT = 30 * 60e3;
const CHECK_TIMEOUT = 30 * 60e3;
const DOCKER_TIMEOUT = 15e3;

// ---------------------------------------------------------------- docker networks
// A compose stack creates a network (often two) per branch, and Docker's
// default address pool only has room for about 31 of them. Teardown can miss
// them — `down` may be skipped when the worktree is already gone, or do
// nothing when the project has no down command yet — and once the pool is
// full, every later `up` fails with "all predefined address pools have been
// fully subnetted". So remember which networks an `up` created, and remove
// exactly those (and only while nothing is attached) when the stack is torn
// down. Networks pr-daemon didn't create are never touched.

/** Every docker network id, or null when docker isn't usable here. */
async function networkIds(): Promise<string[] | null> {
  const r = await run("docker", ["network", "ls", "-q"], { timeoutMs: DOCKER_TIMEOUT });
  if (r.code !== 0) return null;
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Remove networks by id, skipping any that are gone or still have containers (docker refuses those anyway). */
export async function removeNetworks(ids: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const id of ids) {
    const info = await run("docker", ["network", "inspect", id, "--format", "{{.Name}} {{len .Containers}}"], { timeoutMs: DOCKER_TIMEOUT });
    if (info.code !== 0) continue;                              // already gone
    const [name, containers] = info.stdout.trim().split(" ");
    if (containers !== "0") continue;                           // still in use: leave it alone
    if ((await run("docker", ["network", "rm", id], { timeoutMs: DOCKER_TIMEOUT })).code === 0) removed.push(name || id);
  }
  return removed;
}

/** Docker's address pool is full: the message is unmistakable but the fix isn't. Exported for the test. */
export function poolHint(out: string): string {
  // The two phrasings Docker uses when the default pools are exhausted.
  return /address pools have been fully subnetted|non-overlapping ipv4 address pool/i.test(out)
    ? "\n\npr-daemon: Docker has no address space left for another network. Old preview networks are the usual cause: " +
      "`docker network ls` shows them, and `pr-daemon doctor` counts the ones nothing is attached to. " +
      "Removing the empty leftovers (`docker network rm <id>`) frees the pool."
    : "";
}

/** `just foo` where recipe foo doesn't exist → treat as "not configured". */
async function missingRecipe(cmd: string, wt: string): Promise<boolean> {
  const m = /^just\s+([\w-]+)\s*$/.exec(cmd.trim());
  if (!m) return false;
  return (await run("just", ["--show", m[1]], { cwd: wt })).code !== 0;
}

export type UpResult = ({ ok: true; url: string } | { ok: false; error: string }) & { networks: string[] };

/**
 * Start the stack (idempotent). The last line of output that looks like a URL
 * is the local URL. The command gets the branch's public URL (when a preview
 * domain is set) so the app can use it as its origin.
 */
export async function up(cmd: string, wt: string, publicUrl = ""): Promise<UpResult> {
  if (await missingRecipe(cmd, wt)) return { ok: false, error: `\`${cmd}\`: no such recipe in this project`, networks: [] };
  const env = { PR_DAEMON_PUBLIC_URL: publicUrl, PR_DAEMON_PUBLIC_HOST: publicUrl ? new URL(publicUrl).host : "" };
  const before = await networkIds();
  const r = await sh(cmd, wt, { timeoutMs: UP_TIMEOUT, detached: true, env });
  // What this `up` added, so teardown can take exactly those away again.
  const networks = before ? ((await networkIds()) ?? []).filter((id) => !before.includes(id)) : [];
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) return { ok: false, error: tail(out, 60) + poolHint(out), networks };
  const url = r.stdout.split("\n").map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l)).pop() ?? "";
  return { ok: true, url, networks };
}

export async function down(cmd: string, wt: string): Promise<{ ok: boolean; output: string }> {
  if (await missingRecipe(cmd, wt)) return { ok: true, output: "no down recipe" };
  const r = await sh(cmd, wt, { timeoutMs: 10 * 60e3 });
  return { ok: r.code === 0, output: tail(`${r.stdout}\n${r.stderr}`, 30) };
}

/** The harness's definition of done. No check configured → passes. */
export async function check(cmd: string, wt: string): Promise<{ ok: boolean; output: string; skipped: boolean }> {
  if (!cmd.trim() || (await missingRecipe(cmd, wt))) return { ok: true, output: "", skipped: true };
  const r = await sh(cmd, wt, { timeoutMs: CHECK_TIMEOUT });
  return { ok: r.code === 0, output: tail(`${r.stdout}\n${r.stderr}`, 80), skipped: false };
}

/** Any HTTP answer below 500 counts as up (local certs are self-signed, hence -k). */
export async function healthy(url: string): Promise<boolean> {
  if (!url) return false;
  const r = await run("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", url]);
  const code = Number(r.stdout.trim());
  return code > 0 && code < 500;
}
