// A project's preview stack, driven by its own commands. Each is an arbitrary
// shell command line (see sh()); the `just pr-daemon-*` defaults are only a
// convention, and the one just-aware bit is missingRecipe() below.
import { SERVICE_NAME } from "./proxy.ts";
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

export type UpResult = ({ ok: true; url: string; routes: Record<string, string> } | { ok: false; error: string }) & { networks: string[] };

/**
 * What `up` printed: the last line that is nothing but a URL is the app's
 * local URL, and each `PR_DAEMON_ROUTE <service> <local-url>` line declares a
 * service the browser talks to, published as <branch>--<service>.<domain>.
 * Exported for the test.
 */
export function parseUp(stdout: string): { url: string; routes: Record<string, string> } | { error: string } {
  const lines = stdout.split("\n").map((l) => l.trim());
  const routes: Record<string, string> = {};
  for (const l of lines.filter((l) => l.startsWith("PR_DAEMON_ROUTE"))) {
    const m = /^PR_DAEMON_ROUTE\s+(\S+)\s+(https?:\/\/\S+)$/.exec(l);
    if (!m || !SERVICE_NAME.test(m[1])) {
      return { error: `bad route line: "${l}"\nexpected: PR_DAEMON_ROUTE <service> <local-url>, the service 1-12 lowercase letters or digits` };
    }
    routes[m[1]] = m[2];
  }
  return { url: lines.filter((l) => /^https?:\/\/\S+$/.test(l)).pop() ?? "", routes };
}

/**
 * Start the stack (idempotent). `env` says where it is served publicly (see
 * publicEnv()): when a domain is set the app must use those addresses as its
 * origin and for every service its browser code calls.
 */
export async function up(cmd: string, wt: string, env: Record<string, string>): Promise<UpResult> {
  if (await missingRecipe(cmd, wt)) return { ok: false, error: `\`${cmd}\`: no such recipe in this project`, networks: [] };
  const before = await networkIds();
  const r = await sh(cmd, wt, { timeoutMs: UP_TIMEOUT, detached: true, env });
  // What this `up` added, so teardown can take exactly those away again.
  const networks = before ? ((await networkIds()) ?? []).filter((id) => !before.includes(id)) : [];
  const out = `${r.stdout}\n${r.stderr}`;
  // All of it, not a tail: a project's `up` often ends by dumping container
  // logs, and a tail of those hid the line that said which step had failed.
  if (r.code !== 0) return { ok: false, error: out.trim() + poolHint(out), networks };
  const parsed = parseUp(r.stdout);
  if ("error" in parsed) return { ok: false, error: parsed.error, networks };
  return { ok: true, ...parsed, networks };
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

// ---------------------------------------------------------------- health
// Two addresses, two different questions. The stack's own address answers "is
// the app running at all" — anything below 500 means a server is there, and a
// 404 from it is the app's own answer, not a fault. The public preview URL
// answers "can a person use this", and there a 404 is the classic symptom:
// Caddy has no route for the host, or the upstream rejects the public Host
// (see proxy_host). So probe both and compare them.

/** One HTTP probe: the status code, or 0 when nothing answered. Local certs are self-signed, hence -k. */
export async function probe(url: string): Promise<number> {
  if (!url) return 0;
  const r = await run("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", url]);
  return Number(r.stdout.trim()) || 0;
}

export type HealthState = "up" | "degraded" | "down";

/** A stack row's state in one word, for the page, `status` and `doctor`. */
export function stackState(s: { healthy: number; public_ok: number }): HealthState | "unknown" {
  return s.healthy === -1 ? "unknown" : s.healthy === 0 ? "down" : s.public_ok === 0 ? "degraded" : "up";
}

export interface Health {
  state: HealthState;
  /** Which fact made it that: used to write the message, and to decide whether a restart could help. */
  reason: "ok" | "no-answer" | "server-error" | "preview-no-answer" | "preview-rejected";
}

/**
 * What the two probes mean together. `local` and `pub` are status codes (0 =
 * nothing answered); `pub` is null when there is no public URL to try.
 *
 * - down: the stack itself isn't serving. A restart can help.
 * - degraded: the stack serves, but the address people use doesn't give them
 *   the app. A restart cannot help; it's the proxy, DNS or the Host.
 *
 * Identical codes count as up: a proxy that faithfully relays the app's own
 * 404 is working, and an app whose "/" is a 404 must not read as broken.
 *
 * Pure: unit-tested.
 */
export function previewHealth(local: number, pub: number | null): Health {
  if (!local) return { state: "down", reason: "no-answer" };
  if (local >= 500) return { state: "down", reason: "server-error" };
  if (pub === null || pub === local || (pub >= 200 && pub < 400)) return { state: "up", reason: "ok" };
  if (!pub) return { state: "degraded", reason: "preview-no-answer" };
  return { state: "degraded", reason: "preview-rejected" };
}

/**
 * What to show on the row, and what to do about it. The `preview-rejected`
 * case is worth spelling out: the stack is fine and the proxy is running, so
 * what's left is the Host the app receives — the gotcha `proxy_host` exists
 * for. Pure: unit-tested.
 */
export function healthMessage(h: Health, o: { url: string; pub: string; repo: string; local: number; publicCode: number | null }): string {
  const host = (u: string, part: "host" | "domain"): string => {
    try { const h = new URL(u); return part === "host" ? h.host : h.hostname.split(".").slice(1).join("."); }
    catch { return u; }
  };
  switch (h.reason) {
    case "ok": return "";
    case "no-answer": return `nothing answered at ${o.url}`;
    case "server-error": return `${o.url} answered ${o.local}`;
    case "preview-no-answer":
      return `the stack answers at ${o.url} (${o.local}), but nothing answered at ${o.pub}. ` +
        `Check the preview proxy below, and that *.${host(o.pub, "domain")} points at this machine.`;
    case "preview-rejected":
      return `the stack answers at ${o.url} (${o.local}), but ${o.pub} answers ${o.publicCode}. ` +
        `The app is given the public Host and doesn't recognise it: set proxy_host = "upstream" for ${o.repo} ` +
        `in the config to send it its own Host instead, or teach the app to accept ${host(o.pub, "host")}.`;
  }
}
