// A project's preview stack, driven by its own commands (default: just recipes).
import { run, sh, tail } from "./util.ts";

const UP_TIMEOUT = 30 * 60e3;
const CHECK_TIMEOUT = 30 * 60e3;

/** `just foo` where recipe foo doesn't exist → treat as "not configured". */
async function missingRecipe(cmd: string, wt: string): Promise<boolean> {
  const m = /^just\s+([\w-]+)\s*$/.exec(cmd.trim());
  if (!m) return false;
  return (await run("just", ["--show", m[1]], { cwd: wt })).code !== 0;
}

/**
 * Start the stack (idempotent). The last line of output that looks like a URL
 * is the local URL. The command gets the branch's public URL (when a preview
 * domain is set) so the app can use it as its origin.
 */
export async function up(cmd: string, wt: string, publicUrl = ""): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (await missingRecipe(cmd, wt)) return { ok: false, error: `\`${cmd}\`: no such recipe in this project` };
  const env = { PR_DEMON_PUBLIC_URL: publicUrl, PR_DEMON_PUBLIC_HOST: publicUrl ? new URL(publicUrl).host : "" };
  const r = await sh(cmd, wt, { timeoutMs: UP_TIMEOUT, detached: true, env });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) return { ok: false, error: tail(out, 60) };
  const url = r.stdout.split("\n").map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l)).pop() ?? "";
  return { ok: true, url };
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
