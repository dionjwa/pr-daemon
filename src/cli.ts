// pr-daemon command line.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, HOME, loadConfig } from "./config.ts";
import { Daemon } from "./daemon.ts";
import type { JobKind } from "./db.ts";
import { setupDoc } from "./setup.ts";
import { run } from "./util.ts";
import { serve } from "./web.ts";

const HELP = `pr-daemon — label an issue, get a pull request.

  pr-daemon serve                         run the process: poll GitHub, run agents, serve the status page
  pr-daemon status                        what's running, queued and paused
  pr-daemon stop                          shut it down (and stop the service, if one is installed)
  pr-daemon doctor                        check tools, logins and config
  pr-daemon setup                         print what a project must do to take part (also at /setup)
  pr-daemon run <kind> <owner/repo> <n> [feedback]
                                         run one job now, in this terminal (kind: build|review|revise|teardown|restart)
  pr-daemon install-service               start pr-daemon at login (macOS launchd / Linux systemd --user)
  pr-daemon uninstall-service

Config: ${CONFIG_PATH}   (also editable on the status page)`;

const SRC = dirname(fileURLToPath(import.meta.url));
const LABEL = "pr-daemon";

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "serve": {
      const d = new Daemon();
      // A stray GitHub/network error must never take the whole process down.
      process.on("unhandledRejection", (e) => d.store.event(`unexpected error: ${(e as Error)?.message ?? e}`, null, "error"));
      // Ctrl-C, launchctl/systemctl stop: take Caddy down with us, but never
      // hang (launchd SIGKILLs a process that ignores SIGTERM for too long).
      let quitting = false;
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => {
          if (quitting) process.exit(1);
          quitting = true;
          const done = (): never => process.exit(0);
          setTimeout(done, 10_000).unref();
          d.shutdown().then(done, done);
        });
      }
      serve(d);
      d.start();
      return new Promise(() => {}); // run forever
    }
    case "status": return status();
    case "stop": return stop();
    case "doctor": return doctor();
    case "setup": console.log(setupDoc(loadConfig(), "/pr-daemon")); return;
    case "run": {
      const [kind, repo, n, ...rest] = args;
      if (!["build", "review", "revise", "teardown", "restart"].includes(kind) || !repo || !Number(n)) throw new Error("usage: pr-daemon run <kind> <owner/repo> <number> [feedback]");
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
  catch { console.log(`pr-daemon isn't running (start it: pr-daemon serve, or pr-daemon install-service)`); return; }
  console.log(`${s.paused ? "PAUSED" : "running"} · budget ${s.budget.usedText} / ${s.budget.limitText} in last ${s.budget.window} · http://localhost:${cfg.port}`);
  for (const j of s.jobs.filter((x: any) => ["running", "queued", "paused"].includes(x.state)))
    console.log(`  ${j.state.padEnd(8)} ${j.kind.padEnd(8)} ${j.repo}#${j.number}  ${j.tokensText}  ${j.reason}`);
  for (const st of s.stacks) console.log(`  stack   ${st.branch.padEnd(40)} ${st.url}`);
}

/**
 * Shut the process down, however it was started. A service is stopped first:
 * launchd's KeepAlive would otherwise restart it the moment it exits. Then
 * whatever still answers on the status port is asked to quit.
 */
async function stop(): Promise<void> {
  const cfg = loadConfig();
  const url = `http://localhost:${cfg.port}`;
  if (process.platform === "darwin" && existsSync(plistPath)) {
    await run("launchctl", ["bootout", `gui/${process.getuid!()}/${LABEL}`]);
    console.log("Stopped the service. It starts again at login, or now with: pr-daemon install-service");
  } else if (process.platform !== "darwin" && existsSync(unitPath)) {
    await run("systemctl", ["--user", "stop", LABEL]);
    console.log(`Stopped the service. Start it again with: systemctl --user start ${LABEL}`);
  }

  const who = await listener(cfg.port);
  if (!who && !(await alive(cfg.port))) return console.log(`Nothing is listening on ${url}: it isn't running.`);

  // Ask politely first: a clean exit stops Caddy and re-queues running jobs.
  await fetch(`${url}/api/shutdown`, { method: "POST", headers: { "x-pr-daemon": "1" }, signal: AbortSignal.timeout(3000) }).catch(() => {});
  if (await gone(cfg.port)) return console.log(stopped());

  // Still there. An older build (or anything wedged) won't answer that
  // request, so fall back to the process holding the port — but only if its
  // command line is our entrypoint. Being in a pr-daemon directory isn't
  // enough: an editor or a shell sitting there would match that.
  if (!who) return console.log(`${url} is still answering but nothing holds the port. Stop it where you started it.`);
  if (!/(cli\.ts|bin\/pr-da?emon)\s+serve\b/.test(who.command)) {
    return console.log(`Something else is on ${url} — pid ${who.pid}, left alone:\n  ${who.command}`);
  }
  try { process.kill(who.pid, "SIGTERM"); } catch { /* already gone */ }
  console.log(await gone(cfg.port)
    ? `${stopped()}\n(It didn't answer the shutdown request, so pid ${who.pid} was asked to quit instead.)`
    : `pid ${who.pid} is still holding ${url}. Stop it where it was started, or: kill -9 ${who.pid}`);
}

const stopped = () => "Stopped. Preview stacks keep running; Caddy stopped with it. Start again: pr-daemon serve (or just start).";

/** Wait up to 10s for the port to go quiet. */
async function gone(port: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!(await alive(port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !(await alive(port));
}

const alive = async (port: number): Promise<boolean> => {
  try { await fetch(`http://localhost:${port}/api/status`, { signal: AbortSignal.timeout(1500) }); return true; }
  catch { return false; }
};

/** The process listening on a port, with its command line, so we can see whose it is. */
async function listener(port: number): Promise<{ pid: number; command: string } | null> {
  const r = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeoutMs: 5000 });
  const pid = Number(r.stdout.split("\n")[0]?.trim());
  if (!pid) return null;
  const ps = await run("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs: 5000 });
  return { pid, command: ps.stdout.trim() };
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
  if (docker.code === 0) await dockerNetworks(ok);
  try {
    const cfg = loadConfig();
    ok(true, `config is valid (${CONFIG_PATH})`);
    ok(cfg.repos.length > 0, cfg.repos.length ? `${cfg.repos.length} repo(s) configured: ${cfg.repos.map((r) => r.name).join(", ")}` : "no repositories configured yet",
      `add one block per repo to ${CONFIG_PATH} (the double brackets make it a list):\n\n      [[repos]]\n      name = "your-org/your-repo"\n`);
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

/**
 * Docker's default address pool fits roughly 31 bridge networks, and each
 * preview stack takes one or two. Leftovers from branches that are long gone
 * fill it up, and then every `up` fails with "all predefined address pools
 * have been fully subnetted". pr-daemon removes the networks it created when
 * it tears a stack down; this counts what's there, and never deletes anything.
 */
async function dockerNetworks(ok: (good: boolean, what: string, fix?: string) => void): Promise<void> {
  const ids = (await run("docker", ["network", "ls", "-q", "--filter", "driver=bridge"], { timeoutMs: 20_000 }))
    .stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!ids.length) return;
  const info = await run("docker", ["network", "inspect", ...ids, "--format", "{{.Name}} {{len .Containers}}"], { timeoutMs: 30_000 });
  const lines = info.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const idle = lines.filter((l) => l.endsWith(" 0"));
  const crowded = ids.length >= 24;    // the pool runs out at about 31
  ok(!crowded, `docker bridge networks: ${ids.length}, ${idle.length} with nothing attached`,
    `the address pool is nearly full; the next preview may fail to start.\n      Empty ones to consider removing (docker network rm <name>):\n      ${
      idle.slice(0, 12).map((l) => l.replace(/ 0$/, "")).join("\n      ")}`);
}

// ---------- service ----------
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const unitPath = join(homedir(), ".config", "systemd", "user", `${LABEL}.service`);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function installService(): Promise<void> {
  mkdirSync(HOME, { recursive: true });
  const args = [process.execPath, "--no-warnings=ExperimentalWarning", join(SRC, "cli.ts"), "serve"];
  const logFile = join(HOME, "pr-daemon.log");
  if (process.platform === "darwin") {
    // AbandonProcessGroup: preview stacks started by pr-daemon survive it restarting.
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
    writeFileSync(unitPath, `[Unit]\nDescription=pr-daemon\n\n[Service]\nExecStart=${args.join(" ")}\nEnvironment=PATH=${process.env.PATH}\nRestart=always\nKillMode=process\nStandardOutput=append:${logFile}\nStandardError=append:${logFile}\n\n[Install]\nWantedBy=default.target\n`);
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
  console.log("Stopped and removed. Caddy stopped with it, so the public preview URLs are down.\nPreview stacks keep running on their local ports; tear them down from the status page before uninstalling if you want them gone.");
}

main(process.argv.slice(2)).catch((e) => { console.error(`pr-daemon: ${(e as Error).message}`); process.exit(1); });
