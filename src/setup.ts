// Where everything lives on this machine, and the project-setup contract
// (docs/setup.md) with this machine's real paths and settings filled in.
// Served as plain text at GET /setup, and printed by `pr-daemon setup`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, HOME, type Config } from "./config.ts";
import { render } from "./pipeline.ts";

const DOC = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "setup.md");

/** The runtime directories, for the status page, /setup and `doctor`. */
export function paths(): Record<string, string> {
  return {
    home: HOME,
    config: CONFIG_PATH,
    repos: join(HOME, "repos"),
    worktrees: join(HOME, "worktrees"),
    out: join(HOME, "out"),
    log: join(HOME, "pr-daemon.log"),
  };
}

/** docs/setup.md, filled in from the live config. */
export function setupDoc(cfg: Config, command: string): string {
  const p = paths(), r = cfg.repos[0], pv = cfg.preview;
  return render(readFileSync(DOC, "utf8"), {
    STATUS_URL: `http://localhost:${cfg.port}/`, CONFIG_PATH: p.config, LABEL: cfg.label, COMMAND: command,
    UP: r?.up ?? "just pr-daemon-up", DOWN: r?.down ?? "just pr-daemon-down", CHECK: r?.check || "just pr-daemon-check",
    HOME: p.home, REPOS: p.repos, WORKTREES: p.worktrees, OUT: p.out,
    MAX_ATTEMPTS: cfg.agent.maxAttempts,
    CI_ROUNDS: cfg.checks.watch && cfg.checks.fix ? cfg.checks.maxRounds : 0,
    PREVIEW: pv.domain && pv.proxy !== "off" ? `*.${pv.domain}` : "none, so those variables are empty",
  });
}
