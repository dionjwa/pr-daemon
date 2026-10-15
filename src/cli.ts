// pr-demon command line.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, HOME, loadConfig } from "./config.ts";
import { Daemon } from "./daemon.ts";
import type { JobKind } from "./db.ts";
import { run } from "./util.ts";
import { serve } from "./web.ts";

const HELP = `pr-demon — label an issue, get a pull request.

  pr-demon serve                         run the process: poll GitHub, run agents, serve the status page
  pr-demon status                        what's running, queued and paused
  pr-demon doctor                        check tools, logins and config
  pr-demon run <kind> <owner/repo> <n> [feedback]
                                         run one job now, in this terminal (kind: build|review|revise|teardown|restart)
  pr-demon install-service               start pr-demon at login (macOS launchd / Linux systemd --user)
  pr-demon uninstall-service

Config: ${CONFIG_PATH}   (also editable on the status page)`;

const SRC = dirname(fileURLToPath(import.meta.url));
const LABEL = "pr-demon";

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "serve": {
      const d = new Daemon();
      // A stray GitHub/network error must never take the whole process down.
      process.on("unhandledRejection", (e) => d.store.event(`unexpected error: ${(e as Error)?.message ?? e}`, null, "error"));
      serve(d);
      d.start();
      return new Promise(() => {}); // run forever
    }
    case "status": return status();
    case "doctor": return doctor();
    case "run": {
      const [kind, repo, n, ...rest] = args;
      if (!["build", "review", "revise", "teardown", "restart"].includes(kind) || !repo || !Number(n)) throw new Error("usage: pr-demon run <kind> <owner/repo> <number> [feedback]");
      const d = new Daemon();
      const id = d.store.enqueue({ repo, kind: kind as JobKind, number: Number(n), trigger_key: `manual:${repo}#${n}:${kind}:${Date.now()}`,
        payload: rest.length ? { feedback: rest.join(" ") } : {} });
      await d.runNow(id!);
      const j = d.store.job(id!)!;
      console.log(`${j.kind} ${j.repo}#${j.number}: ${j.state}${j.reason ? ` (${j.reason})` : ""}${j.pr ? ` → PR #${j.pr}` : ""}`);
      process.exit(j.state === "done" ? 0 : 1);
    }
    case "install-service": return installService();
    case "uninstall-service": return uninstallService();
    case undefined: case "help": case "-h": case "--help": console.log(HELP); return;
    default: throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

async function status(): Promise<void> {
  const cfg = loadConfig();
  let s: any;
  try { s = await (await fetch(`http://localhost:${cfg.port}/api/status`)).json(); }
  catch { console.log(`pr-demon isn't running (start it: pr-demon serve, or pr-demon install-service)`); return; }
  console.log(`${s.paused ? "PAUSED" : "running"} · budget ${s.budget.usedText} / ${s.budget.limitText} in last ${s.budget.window} · http://localhost:${cfg.port}`);
  for (const j of s.jobs.filter((x: any) => ["running", "queued", "paused"].includes(x.state)))
    console.log(`  ${j.state.padEnd(8)} ${j.kind.padEnd(8)} ${j.repo}#${j.number}  ${j.tokensText}  ${j.reason}`);
  for (const st of s.stacks) console.log(`  stack   ${st.branch.padEnd(40)} ${st.url}`);
}

async function doctor(): Promise<void> {
  let bad = 0;
  const ok = (good: boolean, what: string, fix = "") => { console.log(`${good ? "✓" : "✗"} ${what}${good || !fix ? "" : `\n    → ${fix}`}`); if (!good) bad++; };
  for (const t of ["git", "gh", "just", "docker", "claude", "curl"]) ok((await run("which", [t])).code === 0, `${t} installed`);
  const auth = await run("gh", ["auth", "status"]);
  ok(auth.code === 0, "gh is logged in", "gh auth login");
  const c = await run("claude", ["-p", "Reply with exactly: ok", "--max-turns", "1"], { timeoutMs: 90_000 });
  ok(c.code === 0 && /ok/i.test(c.stdout), "claude works headless", c.stdout.trim() || c.stderr.trim() || "claude (log in), or set CLAUDE_CODE_OAUTH_TOKEN");
  const docker = await run("docker", ["info"], { timeoutMs: 20_000 });
  ok(docker.code === 0, "docker is running", "start Docker Desktop");
  try {
    const cfg = loadConfig();
    ok(true, `config is valid (${CONFIG_PATH})`);
    ok(cfg.repos.length > 0, `${cfg.repos.length} repo(s) configured`, `add a [[repos]] block to ${CONFIG_PATH}`);
    for (const r of cfg.repos) {
      const v = await run("gh", ["api", `repos/${r.name}`, "--jq", ".permissions.push"]);
      ok(v.stdout.trim() === "true", `you can push to ${r.name}`);
    }
    const p = cfg.preview;
    if (p.domain && p.proxy !== "off") {
      const hasCaddy = (await run("which", ["caddy"])).code === 0;
      const usable = p.proxy === "binary" ? hasCaddy : p.proxy === "docker" ? docker.code === 0 : hasCaddy || docker.code === 0;
      ok(usable, `preview proxy for *.${p.domain} (${p.proxy}${p.proxy === "auto" ? `: ${hasCaddy ? "caddy binary" : "docker"}` : ""})`,
        "brew install caddy, or start Docker");
      const example = `${cfg.repos[0] ? "42-example" : "x"}.${p.domain}`;
      const dns = await run("dig", ["+short", example]);
      ok(!!dns.stdout.trim() || /\.localhost$/.test(p.domain), `DNS: ${example} resolves${dns.stdout.trim() ? ` (${dns.stdout.trim().split("\n")[0]})` : ""}`,
        `point *.${p.domain} at this machine (a wildcard A record), and forward ports ${p.httpPort} and ${p.httpsPort} to it`);
    } else {
      console.log(`· no preview domain: previews use local URLs (set [preview] domain to get https://<branch>.<domain>)`);
    }
  } catch (e) { ok(false, "config is valid", (e as Error).message); }
  process.exit(bad ? 1 : 0);
}

// ---------- service ----------
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const unitPath = join(homedir(), ".config", "systemd", "user", `${LABEL}.service`);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function installService(): Promise<void> {
  mkdirSync(HOME, { recursive: true });
  const args = [process.execPath, "--no-warnings=ExperimentalWarning", join(SRC, "cli.ts"), "serve"];
  const logFile = join(HOME, "pr-demon.log");
  if (process.platform === "darwin") {
    // AbandonProcessGroup: preview stacks started by pr-demon survive it restarting.
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(process.env.PATH ?? "")}</string>
    <key>HOME</key><string>${xml(homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict></plist>
`);
    const uid = process.getuid!();
    await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    const r = await run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr}`);
    console.log(`Installed and started. Logs: ${logFile}\nStatus page: http://localhost:${loadConfig().port}`);
  } else {
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, `[Unit]\nDescription=pr-demon\n\n[Service]\nExecStart=${args.join(" ")}\nEnvironment=PATH=${process.env.PATH}\nRestart=always\nKillMode=process\nStandardOutput=append:${logFile}\nStandardError=append:${logFile}\n\n[Install]\nWantedBy=default.target\n`);
    await run("systemctl", ["--user", "daemon-reload"]);
    const r = await run("systemctl", ["--user", "enable", "--now", LABEL]);
    if (r.code !== 0) throw new Error(`systemctl failed: ${r.stderr}`);
    console.log(`Installed and started. Logs: ${logFile}`);
  }
}

async function uninstallService(): Promise<void> {
  if (process.platform === "darwin") {
    await run("launchctl", ["bootout", `gui/${process.getuid!()}/${LABEL}`]);
    if (existsSync(plistPath)) (await import("node:fs")).rmSync(plistPath);
  } else {
    await run("systemctl", ["--user", "disable", "--now", LABEL]);
    if (existsSync(unitPath)) (await import("node:fs")).rmSync(unitPath);
  }
  console.log("Stopped and removed. Preview stacks keep running; tear them down from the status page first if you want them gone.");
}

main(process.argv.slice(2)).catch((e) => { console.error(`pr-demon: ${(e as Error).message}`); process.exit(1); });
