// Small shared helpers: human-readable amounts/durations, child processes, logging.
import { execFileSync, spawn } from "node:child_process";

// ---------- human amounts: "40M", "1.5m", "500k", "2B", "40,000,000" ----------
const AMOUNT_SUFFIX: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9 };

export function parseAmount(input: string | number | undefined | null): number | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input === "number") return input;
  const s = input.trim().toLowerCase().replace(/[,_\s]/g, "").replace(/tokens?$/, "");
  const m = /^(\d+(?:\.\d+)?)(k|m|b)?$/.exec(s);
  if (!m) throw new Error(`not an amount: "${input}" (try "40M", "500k", "1.5m")`);
  return Math.round(parseFloat(m[1]) * AMOUNT_SUFFIX[m[2] ?? ""]);
}

export function formatAmount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// ---------- durations: "5h", "30m", "90s", "1h30m", "7d" ----------
const DURATION_UNIT: Record<string, number> = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };

export function parseDuration(input: string | number): number {
  if (typeof input === "number") return input * 1000; // bare numbers are seconds
  const s = input.trim().toLowerCase().replace(/\s/g, "");
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0, consumed = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) { total += parseFloat(m[1]) * DURATION_UNIT[m[2]]; consumed += m[0].length; }
  if (!s || consumed !== s.length) throw new Error(`not a duration: "${input}" (try "5h", "30m", "1h30m")`);
  return total;
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ---------- child processes ----------
// The agent and the stack must behave as if a developer were at a terminal:
// drop CI=… (projects switch into "CI mode") and the markers of an enclosing
// Claude Code session (pr-daemon may be started from one; the agent must not
// think it's nested inside it). The DNS token is only for Caddy: agents and
// project commands never need it.
const DROP_ENV = new Set(["CI", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLOUDFLARE_API_TOKEN"]);

export function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP_ENV.has(k)) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

export interface RunResult { code: number; stdout: string; stderr: string }

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  timeoutMs?: number;
  /** Own process group: background children (a preview stack) survive pr-daemon restarting. */
  detached?: boolean;
}

/** Run a command to completion, capturing output. Never throws on non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd, env: opts.env ?? cleanEnv(), shell: opts.shell ?? false, detached: opts.detached ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    if (opts.input !== undefined) child.stdin.end(opts.input); else child.stdin.end();
  });
}

/** Run a shell command line (a project's up/down/check) in a directory. */
export function sh(line: string, cwd: string, o: { timeoutMs?: number; detached?: boolean; env?: Record<string, string> } = {}): Promise<RunResult> {
  return run("bash", ["-lc", line], { cwd, timeoutMs: o.timeoutMs, detached: o.detached, env: cleanEnv(o.env) });
}

/** Like run() but throws with stderr on failure and returns trimmed stdout. */
export async function must(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")}… failed: ${(r.stderr || r.stdout).trim().slice(-800)}`);
  return r.stdout.trim();
}

export function tail(s: string, lines: number): string {
  return s.split("\n").slice(-lines).join("\n").trim();
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .split("-").slice(0, 5).join("-").slice(0, 40).replace(/-+$/, "");
}

/**
 * A desktop notification, best effort: terminal-notifier (clicking opens the
 * URL) or osascript on macOS, notify-send on Linux. Never throws.
 */
export function notify(title: string, body: string, url = ""): void {
  const fire = (cmd: string, args: string[], fallback?: () => void) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => fallback?.());
    child.unref();
  };
  if (process.platform === "darwin") {
    // osascript reads the text from argv, so nothing needs escaping.
    const osascript = () => fire("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, url ? `${body}\n${url}` : body]);
    // One group per link (a PR, or a job on the status page): a newer notice about it replaces the older.
    fire("terminal-notifier", ["-title", title, "-message", body, "-group", notifyGroup(title, url), ...(url ? ["-open", url] : [])], osascript);
  } else if (process.platform === "linux") {
    fire("notify-send", ["--app-name=pr-daemon", title, url ? `${body}\n${url}` : body]);
  }
}

const notifyGroup = (title: string, url: string) => `pr-daemon:${url || title}`;

/**
 * Take notifications off the desktop, best effort: terminal-notifier only
 * (osascript and notify-send can't remove what they showed). Never throws.
 */
export function unnotify(notices: { title: string; url: string }[]): void {
  if (process.platform !== "darwin") return;
  for (const g of new Set(notices.map((n) => notifyGroup(n.title, n.url)))) {
    const child = spawn("terminal-notifier", ["-remove", g], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  }
}

let notifierCache = { at: 0, name: "" };
/**
 * What notify() will use on this machine: terminal-notifier, osascript (macOS
 * without it: shown as "Script Editor", no click-to-open, often dropped when
 * run as a service), notify-send, or "" for nothing. Re-checked every 30s, so
 * installing one shows up without a restart.
 */
export function notifier(): string {
  if (Date.now() - notifierCache.at < 30_000) return notifierCache.name;
  const has = (cmd: string) => { try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; } };
  const name = process.platform === "darwin" ? (has("terminal-notifier") ? "terminal-notifier" : "osascript")
    : process.platform === "linux" && has("notify-send") ? "notify-send" : "";
  notifierCache = { at: Date.now(), name };
  return name;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(msg: string): void {
  process.stderr.write(`[pr-daemon ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}
