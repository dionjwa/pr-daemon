// Configuration: one TOML file (default ~/.pr-demon/config.toml).
// The web page edits the raw text, so comments survive; every save is parsed
// and validated first, and a bad file is never written.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { parseAmount, parseDuration } from "./util.ts";

export const HOME = process.env.PR_DEMON_HOME ?? join(homedir(), ".pr-demon");
export const CONFIG_PATH = process.env.PR_DEMON_CONFIG ?? join(HOME, "config.toml");

export interface RepoConfig {
  name: string;          // owner/repo
  base: string;          // "" = the repo's default branch
  up: string;            // start this branch's stack; last line of output = preview URL
  down: string;          // stop it
  check: string;         // "" = no harness check (trust the agent)
  /** Host header the app receives through the preview proxy: the public one, or its local one. */
  proxyHost: "public" | "upstream";
}

export interface PreviewConfig {
  domain: string;                         // "" = local URLs only
  proxy: "auto" | "binary" | "docker" | "off";
  tls: "auto" | "internal" | "off";
  email: string;
  httpPort: number;
  httpsPort: number;
  publicPort: number | null;              // port in public URLs when you forward e.g. 443 → 8443
  admin: string;                          // Caddy admin API, host:port (local only)
}

export interface Config {
  port: number;
  pollMs: number;
  label: string;
  allowedUsers: string[];   // empty = only the gh-authenticated user
  concurrency: number;      // agent jobs at once
  preventSleep: boolean;
  budget: {
    windowMs: number;
    tokens: number | null;      // per window; null = unlimited
    perIssue: number | null;    // per issue, all runs; null = unlimited
    countCacheReads: boolean;
  };
  agent: {
    model: string;
    maxTurns: number;
    maxAttempts: number;
    autoRevise: boolean;
    stallMs: number;
  };
  stacks: {
    healthEveryMs: number;
    autoRestart: boolean;
  };
  preview: PreviewConfig;
  repos: RepoConfig[];
}

export const DEFAULT_TOML = `# pr-demon configuration.
# Edit here or in the web page (http://localhost:7377 → Config). Saved as-is.

port = 7377              # status page: http://localhost:<port> (localhost only)
poll = "60s"             # how often to check GitHub
label = "agent"          # add this label to an issue to start a build
allowed_users = []       # who may trigger builds and /demon; [] = only you (the gh user)
concurrency = 1          # agent runs at the same time
prevent_sleep = true     # macOS: keep the machine awake while pr-demon runs

[budget]
window = "5h"            # rolling window, e.g. one Claude subscription window
# tokens = "40M"         # max tokens per window; leave unset for no limit
# per_issue = "10M"      # max tokens for one issue across all its runs
count_cache_reads = true # cache reads are ~90% of tokens; false counts only new tokens

[agent]
# model = ""             # Claude model; unset = claude's default
max_turns = 200          # per agent run
max_attempts = 3         # build → check → fix rounds before giving up
auto_revise = true       # let the builder answer the reviewer once, automatically
stall = "30m"            # no agent output for this long = stalled (kill, retry once)

[stacks]
health_every = "5m"      # check each preview URL
auto_restart = true      # restart a preview stack that stopped answering

[preview]
# Public preview URLs: https://<branch>.<domain>, e.g. https://42-dark-mode.preview.example.com
# You point *.<domain> at this machine (DNS + port forwards for 80 and 443);
# pr-demon runs Caddy and routes each branch's host to its local stack.
# domain = "preview.example.com"   # unset = local URLs only, no proxy
proxy = "auto"           # auto (caddy binary if installed, else Docker) | binary | docker | off
tls = "auto"             # auto = Let's Encrypt per branch host (needs 80+443 reachable) | internal = Caddy's own CA (testing) | off = plain http
# email = "you@example.com"        # for Let's Encrypt expiry notices
http_port = 80
https_port = 443
# public_port = 443                # the port people use, if you forward e.g. 443 → 8443
admin = "127.0.0.1:2019" # Caddy's admin API (stays local)

# One block per repository. Commands run from the root of the branch's worktree.
# [[repos]]
# name = "your-org/your-repo"
# base = ""                       # unset = the repo's default branch
# up = "just pr-demon-up"         # start the stack in the background; print its URL last
# down = "just pr-demon-down"     # stop it and delete its data
# check = "just pr-demon-check"   # must pass before a PR opens; "" = trust the agent
# proxy_host = "public"           # Host header the app gets via the preview URL: "public" (the
#                                 # branch's public host) or "upstream" (its local host, for
#                                 # dev servers that reject unknown hosts)
`;

type Raw = Record<string, unknown>;

function str(v: unknown, d: string): string { return typeof v === "string" ? v : d; }
function num(v: unknown, d: number, name: string): number {
  if (v === undefined) return d;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  return v;
}
function bool(v: unknown, d: boolean, name: string): boolean {
  if (v === undefined) return d;
  if (typeof v !== "boolean") throw new Error(`${name} must be true or false`);
  return v;
}
function oneOf<T extends string>(v: unknown, options: readonly T[], d: T, name: string): T {
  if (v === undefined) return d;
  if (typeof v !== "string" || !options.includes(v as T)) throw new Error(`${name} must be one of: ${options.join(", ")}`);
  return v as T;
}
function dur(v: unknown, d: string, name: string): number {
  try { return parseDuration((v as string | number | undefined) ?? d); }
  catch (e) { throw new Error(`${name}: ${(e as Error).message}`); }
}
function amount(v: unknown, name: string): number | null {
  try { return parseAmount(v as string | number | undefined); }
  catch (e) { throw new Error(`${name}: ${(e as Error).message}`); }
}

/** Parse + validate TOML text. Throws a readable error on any problem. */
export function parseConfig(text: string): Config {
  let raw: Raw;
  try { raw = parse(text) as Raw; }
  catch (e) { throw new Error(`TOML syntax: ${(e as Error).message}`); }
  const b = (raw.budget ?? {}) as Raw, a = (raw.agent ?? {}) as Raw, st = (raw.stacks ?? {}) as Raw, pv = (raw.preview ?? {}) as Raw;
  const repos = (raw.repos ?? []) as Raw[];
  if (!Array.isArray(repos)) throw new Error("repos must be a list of [[repos]] blocks");
  const users = raw.allowed_users ?? [];
  if (!Array.isArray(users) || users.some((u) => typeof u !== "string")) throw new Error("allowed_users must be a list of GitHub usernames");

  const cfg: Config = {
    port: num(raw.port, 7377, "port"),
    pollMs: dur(raw.poll, "60s", "poll"),
    label: str(raw.label, "agent"),
    allowedUsers: users as string[],
    concurrency: Math.max(1, num(raw.concurrency, 1, "concurrency")),
    preventSleep: bool(raw.prevent_sleep, true, "prevent_sleep"),
    budget: {
      windowMs: dur(b.window, "5h", "budget.window"),
      tokens: amount(b.tokens, "budget.tokens"),
      perIssue: amount(b.per_issue, "budget.per_issue"),
      countCacheReads: bool(b.count_cache_reads, true, "budget.count_cache_reads"),
    },
    agent: {
      model: str(a.model, ""),
      maxTurns: num(a.max_turns, 200, "agent.max_turns"),
      maxAttempts: Math.max(1, num(a.max_attempts, 3, "agent.max_attempts")),
      autoRevise: bool(a.auto_revise, true, "agent.auto_revise"),
      stallMs: dur(a.stall, "30m", "agent.stall"),
    },
    stacks: {
      healthEveryMs: dur(st.health_every, "5m", "stacks.health_every"),
      autoRestart: bool(st.auto_restart, true, "stacks.auto_restart"),
    },
    preview: {
      domain: str(pv.domain, "").trim().replace(/^\*?\./, "").toLowerCase(),
      proxy: oneOf(pv.proxy, ["auto", "binary", "docker", "off"], "auto", "preview.proxy"),
      tls: oneOf(pv.tls, ["auto", "internal", "off"], "auto", "preview.tls"),
      email: str(pv.email, ""),
      httpPort: num(pv.http_port, 80, "preview.http_port"),
      httpsPort: num(pv.https_port, 443, "preview.https_port"),
      publicPort: pv.public_port === undefined ? null : num(pv.public_port, 443, "preview.public_port"),
      admin: str(pv.admin, "127.0.0.1:2019"),
    },
    repos: repos.map((r, i) => {
      const name = str(r.name, "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`repos[${i}].name must be "owner/repo"`);
      return {
        name,
        base: str(r.base, ""),
        up: str(r.up, "just pr-demon-up"),
        down: str(r.down, "just pr-demon-down"),
        check: str(r.check, "just pr-demon-check"),
        proxyHost: oneOf(r.proxy_host, ["public", "upstream"], "public", `repos[${i}].proxy_host`),
      };
    }),
  };
  if (cfg.preview.domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(cfg.preview.domain)) {
    throw new Error(`preview.domain "${cfg.preview.domain}" isn't a domain name (e.g. "preview.example.com")`);
  }
  if (!/^[\w.[\]:-]+:\d+$/.test(cfg.preview.admin)) throw new Error('preview.admin must be host:port, e.g. "127.0.0.1:2019"');
  if (cfg.pollMs < 10_000) throw new Error("poll must be at least 10s (GitHub rate limits)");
  if (new Set(cfg.repos.map((r) => r.name)).size !== cfg.repos.length) throw new Error("a repo is listed twice");
  return cfg;
}

export function readConfigText(): string {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, DEFAULT_TOML);
  }
  return readFileSync(CONFIG_PATH, "utf8");
}

export function loadConfig(): Config {
  return parseConfig(readConfigText());
}

/** Validate, then atomically replace the file. Returns the parsed config. */
export function saveConfigText(text: string): Config {
  const cfg = parseConfig(text);
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, CONFIG_PATH);
  return cfg;
}
