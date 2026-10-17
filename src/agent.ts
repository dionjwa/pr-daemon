// One headless Claude Code run, supervised: live token accounting, stall
// detection, and a kill switch the scheduler pulls when a budget runs out.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { cleanEnv } from "./util.ts";

export interface Usage { input: number; output: number; cache_create: number; cache_read: number }
export const zeroUsage = (): Usage => ({ input: 0, output: 0, cache_create: 0, cache_read: 0 });

export type AgentEnd =
  | { kind: "ok"; result: string }
  | { kind: "error"; result: string }
  | { kind: "rate_limited"; resetAt: number | null; result: string }
  | { kind: "killed"; why: string }
  | { kind: "stalled" };

export interface AgentRun {
  sessionId: string;
  done: Promise<{ end: AgentEnd; usage: Usage; cost: number; turns: number }>;
  kill(why: string): void;
}

export interface AgentOptions {
  cwd: string;
  prompt: string;
  logFile: string;
  /** Resume this Claude session instead of starting a new one. */
  resume?: string;
  model?: string;
  maxTurns: number;
  stallMs: number;
  /** Called with each new chunk of usage as it streams in. */
  onUsage?: (delta: Usage) => void;
  /** Called with each tool the agent uses (for the status page). */
  onActivity?: (line: string) => void;
}

// Claude reports "usage limit reached" with an epoch reset time in a few shapes.
function rateLimit(text: string): { hit: boolean; resetAt: number | null } {
  if (!/usage limit|rate limit|limit reached|too many requests|\b429\b/i.test(text)) return { hit: false, resetAt: null };
  const epoch = /\|(\d{10})\b/.exec(text) ?? /resets? (?:at )?(\d{10})\b/i.exec(text);
  return { hit: true, resetAt: epoch ? Number(epoch[1]) * 1000 : null };
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const arg = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? "";
  return `${name}: ${String(arg).replace(/\s+/g, " ").slice(0, 140)}`;
}

/**
 * The Claude processes in `ps -axww -o pid=,command=` output that run one of
 * these sessions: what a hard-killed pr-daemon leaves behind (they keep
 * working when nobody reads their output).
 */
export function agentPids(ps: string, sessions: string[]): { pid: number; session: string }[] {
  const out: { pid: number; session: string }[] = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\S*\bclaude\s+-p\s.*)$/.exec(line);
    const s = m && /--(?:session-id|resume)\s+([0-9a-f-]{36})(?:\s|$)/.exec(m[2]);
    if (s && sessions.includes(s[1])) out.push({ pid: Number(m![1]), session: s[1] });
  }
  return out;
}

export function startAgent(o: AgentOptions): AgentRun {
  const sessionId = o.resume ?? randomUUID();
  const args = ["-p", o.prompt, "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose",
    "--max-turns", String(o.maxTurns)];
  args.push(...(o.resume ? ["--resume", o.resume] : ["--session-id", sessionId]));
  if (o.model) args.push("--model", o.model);

  const child = spawn("claude", args, { cwd: o.cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const log = createWriteStream(o.logFile, { flags: "a" });
  // Claude doesn't log the prompt it was given: record it, and where each run starts.
  log.write(JSON.stringify({ type: "pr-daemon", subtype: "start", at: Date.now(), prompt: o.prompt, resume: !!o.resume }) + "\n");
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 20_000) stderr = stderr.slice(-10_000); });

  // Each assistant message's usage arrives once per content block: count each message once.
  const seen = new Map<string, Usage>();
  const total = zeroUsage();
  let lastOutput = Date.now(), killedWhy = "", stalled = false, resultMsg: Record<string, unknown> | null = null;

  const stallTimer = setInterval(() => {
    if (Date.now() - lastOutput > o.stallMs) { stalled = true; child.kill("SIGTERM"); }
  }, 15_000);

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    lastOutput = Date.now();
    log.write(line + "\n");
    let msg: Record<string, any>;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "assistant" && msg.message?.usage) {
      const id = String(msg.message.id ?? randomUUID());
      const u = msg.message.usage;
      const now: Usage = {
        input: u.input_tokens ?? 0, output: u.output_tokens ?? 0,
        cache_create: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0,
      };
      const prev = seen.get(id) ?? zeroUsage();
      const delta: Usage = {
        input: Math.max(0, now.input - prev.input), output: Math.max(0, now.output - prev.output),
        cache_create: Math.max(0, now.cache_create - prev.cache_create), cache_read: Math.max(0, now.cache_read - prev.cache_read),
      };
      seen.set(id, { input: Math.max(prev.input, now.input), output: Math.max(prev.output, now.output),
        cache_create: Math.max(prev.cache_create, now.cache_create), cache_read: Math.max(prev.cache_read, now.cache_read) });
      if (delta.input + delta.output + delta.cache_create + delta.cache_read > 0) {
        total.input += delta.input; total.output += delta.output;
        total.cache_create += delta.cache_create; total.cache_read += delta.cache_read;
        o.onUsage?.(delta);
      }
      for (const c of msg.message.content ?? []) {
        if (c.type === "tool_use") o.onActivity?.(describeTool(c.name, c.input ?? {}));
      }
    }
    if (msg.type === "result") resultMsg = msg;
  });

  const done = new Promise<{ end: AgentEnd; usage: Usage; cost: number; turns: number }>((resolve) => {
    child.on("close", (code) => {
      clearInterval(stallTimer);
      log.end();
      const r = resultMsg as Record<string, any> | null;
      const text = String(r?.result ?? "");
      const cost = Number(r?.total_cost_usd ?? 0), turns = Number(r?.num_turns ?? 0);
      let end: AgentEnd;
      if (killedWhy) end = { kind: "killed", why: killedWhy };
      else if (stalled) end = { kind: "stalled" };
      else {
        const rl2 = rateLimit(`${r?.is_error ? text : ""}\n${code !== 0 ? stderr : ""}`);
        if (rl2.hit) end = { kind: "rate_limited", resetAt: rl2.resetAt, result: text || stderr.slice(-500) };
        else if (code === 0 && r && !r.is_error) end = { kind: "ok", result: text };
        else end = { kind: "error", result: text || stderr.slice(-2000) || `claude exited ${code}` };
      }
      resolve({ end, usage: total, cost, turns });
    });
  });

  return {
    sessionId,
    done,
    kill(why: string) {
      if (killedWhy) return;
      killedWhy = why;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    },
  };
}
