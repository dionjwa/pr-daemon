// Configuration: one TOML file (default ~/.pr-daemon/config.toml).
// The web page edits the raw text, so comments survive; every save is parsed
// and validated first, and a bad file is never written.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { parseAmount, parseDuration } from "./util.ts";

export const HOME = process.env.PR_DAEMON_HOME ?? join(homedir(), ".pr-daemon");
export const CONFIG_PATH = process.env.PR_DAEMON_CONFIG ?? join(HOME, "config.toml");

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
  dns: "" | "cloudflare";                 // set = one wildcard certificate via DNS-01, instead of one per host
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
  notify: boolean;          // desktop notification when a preview stack is ready
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
  /** The project's own CI on a PR pr-daemon pushed. */
  checks: {
    watch: boolean;
    everyMs: number;
    fix: boolean;
    maxRounds: number;
  };
  preview: PreviewConfig;
  repos: RepoConfig[];
}

export const DEFAULT_TOML = `# pr-daemon configuration.
# Edit here or in the web page (http://localhost:7377 → Config). Saved as-is.
# Changes apply live either way — pr-daemon watches this file. A file that
# doesn't parse is reported and ignored; it keeps running the last good one.
# Two settings still need a restart: "port" and "prevent_sleep".
#
# Everything pr-daemon keeps is under ~/.pr-daemon (or $PR_DAEMON_HOME), and
# it's all ordinary files you can open and inspect:
#
#   repos/<org>__<repo>/               the cached clone of each repo (fetched once, reused)
#   worktrees/<org>__<repo>/<branch>/  the checkout an agent works in, one per
#                                      branch; up, down and check run from here
#   out/<org>__<repo>/<branch>/        prompts, agent logs (*.jsonl), PR text, screenshots
#   pr-daemon.db                       jobs, token ledger, stacks, events (SQLite)
#   pr-daemon.log                      the service log
#   caddy/                             generated Caddy config and certificates
#
# "just where" prints that with the branches checked out right now.

port = 7377              # status page: http://localhost:<port> (localhost only)
poll = "60s"             # how often to check GitHub
label = "agent"          # add this label to an issue to start a build
allowed_users = []       # who may direct the agent: add the label, write/edit labelled issues, and write
                         # /pr-daemon and PR comments the agent reads. [] = only you (the gh user)
concurrency = 1          # agent runs at the same time
prevent_sleep = true     # macOS: keep the machine awake while pr-daemon runs
notify = true            # desktop notification when a preview stack is ready (macOS; notify-send on Linux)

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
                         # A stack is never stopped on a timer: it goes away when its PR or issue
                         # closes, when the label comes off, or when you press Tear down.

[checks]
# Your repo's own CI (GitHub Actions, or anything that reports a check or a
# commit status). pr-daemon pushes as you, so your normal CI runs on every
# push; this watches the result and puts an agent on it when it goes red.
watch = true             # read each open PR's checks and show them on the status page
every = "2m"             # how often to ask GitHub (only while a PR's preview stack exists)
fix = true               # when a check fails, run an agent to fix it (one round per failing commit)
max_rounds = 2           # automatic fix rounds per PR, then it stops and says so on the PR

[preview]
# Public preview URLs: https://<branch>.<domain>, e.g. https://42-dark-mode.preview.example.com
# You point *.<domain> at this machine (DNS + port forwards for 80 and 443);
# pr-daemon runs Caddy and routes each branch's host to its local stack.
# domain = "preview.example.com"   # unset = local URLs only, no proxy
proxy = "auto"           # auto (caddy binary if installed, else Docker) | binary | docker | off
tls = "auto"             # auto = Let's Encrypt per branch host (needs 80+443 reachable) | internal = Caddy's own CA (testing) | off = plain http
# dns = "cloudflare"               # with tls = "auto": ONE wildcard certificate for *.<domain>, proved through your
#                                  # DNS provider's API: instant HTTPS for new previews, no per-host rate limits,
#                                  # branch names stay out of public certificate logs. Needs an API token
#                                  # (Zone > DNS > Edit) in $CLOUDFLARE_API_TOKEN or ~/.pr-daemon/cloudflare-token,
#                                  # and Caddy with the module: caddy add-package github.com/caddy-dns/cloudflare
# email = "you@example.com"        # for Let's Encrypt expiry notices
http_port = 80
https_port = 443
# public_port = 443                # the port people use, if you forward e.g. 443 → 8443
admin = "127.0.0.1:2019" # Caddy's admin API (stays local)

# ============================================================================
# REPOSITORIES to watch. This is the only part you have to fill in.
#
# Each repo is one [[repos]] block. The DOUBLE brackets mean "another item in
# the list", so to watch more repos, repeat the whole block. Uncomment the two
# lines below (delete the "# ") to start with one:

# [[repos]]
# name = "your-org/your-repo"

# Three repos, with nothing but the defaults, look like this:
#
#   [[repos]]
#   name = "your-org/api"
#
#   [[repos]]
#   name = "your-org/website"
#
#   [[repos]]
#   name = "someone-else/their-repo"
#
# Order doesn't matter, and blank lines between blocks are fine.
#
# Everything except "name" is optional: leave a line out to get the default
# shown below. A block runs until the next [[repos]], so a repo's own settings
# go directly under its "name" — never after the next block's brackets:
#
#   [[repos]]
#   name = "your-org/api"
#   check = "just test"             # belongs to your-org/api
#
#   [[repos]]
#   name = "your-org/website"
#   check = ""                      # belongs to your-org/website
#
# The settings, with their defaults.
#
# up, down and check are ANY shell command: each is run with bash -lc from the
# root of the branch's worktree. "npm run preview", "docker compose up -d
# --wait && echo http://localhost:3000", "make up", "./scripts/up.sh" — all
# fine. The defaults name just recipes only by convention.
#
# What a project's commands have to do (hand this to an agent):
#   pr-daemon setup      or      http://localhost:7377/setup
#
#   base = ""                       # branch to build from; unset = the repo's default branch
#   up = "just pr-daemon-up"        # start the stack in the background; print its URL last
#   down = "just pr-daemon-down"    # stop it and delete its data
#   check = "just pr-daemon-check"  # must pass before a PR opens; "" = trust the agent
#   proxy_host = "public"           # Host header the app gets via the preview URL: "public" (the
#                                   # branch's public host) or "upstream" (its local host, for
#                                   # dev servers that reject unknown hosts)
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
  if (typeof v !== "string" || !options.includes(v as T)) throw new Error(`${name} must be one of: ${options.map((o) => o || '""').join(", ")}`);
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

/** Shown in errors: the shape of the repos list, for people who don't write TOML. */
const REPOS_EXAMPLE = `  [[repos]]
  name = "your-org/api"

  [[repos]]
  name = "your-org/website"`;

/** Parse + validate TOML text. Throws a readable error on any problem. */
export function parseConfig(text: string): Config {
  let raw: Raw;
  try { raw = parse(text) as Raw; }
  catch (e) { throw new Error(`TOML syntax: ${(e as Error).message}`); }
  const b = (raw.budget ?? {}) as Raw, a = (raw.agent ?? {}) as Raw, st = (raw.stacks ?? {}) as Raw, pv = (raw.preview ?? {}) as Raw;
  const ck = (raw.checks ?? {}) as Raw;
  const repos = (raw.repos ?? []) as Raw[];
  if (!Array.isArray(repos)) throw new Error(`repos needs DOUBLE brackets, one block per repository:\n\n${REPOS_EXAMPLE}`);
  const users = raw.allowed_users ?? [];
  if (!Array.isArray(users) || users.some((u) => typeof u !== "string")) throw new Error("allowed_users must be a list of GitHub usernames");

  const cfg: Config = {
    port: num(raw.port, 7377, "port"),
    pollMs: dur(raw.poll, "60s", "poll"),
    label: str(raw.label, "agent"),
    allowedUsers: users as string[],
    concurrency: Math.max(1, num(raw.concurrency, 1, "concurrency")),
    preventSleep: bool(raw.prevent_sleep, true, "prevent_sleep"),
    notify: bool(raw.notify, true, "notify"),
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
    checks: {
      watch: bool(ck.watch, true, "checks.watch"),
      everyMs: dur(ck.every, "2m", "checks.every"),
      fix: bool(ck.fix, true, "checks.fix"),
      maxRounds: Math.max(0, num(ck.max_rounds, 2, "checks.max_rounds")),
    },
    preview: {
      domain: str(pv.domain, "").trim().replace(/^\*?\./, "").toLowerCase(),
      proxy: oneOf(pv.proxy, ["auto", "binary", "docker", "off"], "auto", "preview.proxy"),
      tls: oneOf(pv.tls, ["auto", "internal", "off"], "auto", "preview.tls"),
      dns: oneOf(pv.dns, ["", "cloudflare"], "", "preview.dns"),
      email: str(pv.email, ""),
      httpPort: num(pv.http_port, 80, "preview.http_port"),
      httpsPort: num(pv.https_port, 443, "preview.https_port"),
      publicPort: pv.public_port === undefined ? null : num(pv.public_port, 443, "preview.public_port"),
      admin: str(pv.admin, "127.0.0.1:2019"),
    },
    repos: repos.map((r, i) => {
      const at = `[[repos]] block #${i + 1}`;
      if (typeof r !== "object" || r === null || Array.isArray(r)) throw new Error(`${at} must be a block of settings, not a bare value:\n\n${REPOS_EXAMPLE}`);
      const name = str(r.name, "");
      if (!name) throw new Error(`${at} has no name: add name = "owner/repo" under it`);
      if (name === "your-org/your-repo") throw new Error(`${at}: replace the example name "your-org/your-repo" with your own repository`);
      if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`${at}: name "${name}" must be "owner/repo", the two parts of its GitHub address`);
      return {
        name,
        base: str(r.base, ""),
        up: str(r.up, "just pr-daemon-up"),
        down: str(r.down, "just pr-daemon-down"),
        check: str(r.check, "just pr-daemon-check"),
        proxyHost: oneOf(r.proxy_host, ["public", "upstream"], "public", `${at}: proxy_host`),
      };
    }),
  };
  if (cfg.preview.domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(cfg.preview.domain)) {
    throw new Error(`preview.domain "${cfg.preview.domain}" isn't a domain name (e.g. "preview.example.com")`);
  }
  if (cfg.preview.dns && cfg.preview.tls !== "auto") throw new Error(`preview.dns only applies to tls = "auto" (Let's Encrypt); remove it or set tls = "auto"`);
  if (!/^[\w.[\]:-]+:\d+$/.test(cfg.preview.admin)) throw new Error('preview.admin must be host:port, e.g. "127.0.0.1:2019"');
  if (cfg.pollMs < 10_000) throw new Error("poll must be at least 10s (GitHub rate limits)");
  const dup = cfg.repos.map((r) => r.name).find((n, i, all) => all.indexOf(n) !== i);
  if (dup) throw new Error(`${dup} has two [[repos]] blocks: keep one, with all of its settings under it`);
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
