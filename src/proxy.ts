// Public preview URLs: https://<branch>.<domain> → that branch's local stack.
//
// pr-demon owns one Caddy (the `caddy` binary, or a Docker container) and
// keeps its routes equal to the stacks table. Every few seconds it rebuilds
// the whole Caddy config from the stacks and loads it through Caddy's admin
// API when it changed: no incremental state to drift. Caddy handles TLS
// (Let's Encrypt per branch host, or its own local CA for testing).
//
// You route the domain to this machine (DNS + port forwards); pr-demon does
// the rest.
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, type Config, type RepoConfig } from "./config.ts";
import type { Stack, Store } from "./db.ts";
import { run } from "./util.ts";

const CADDY_DIR = join(HOME, "caddy");
const CONTAINER = "pr-demon-caddy";
const IMAGE = "caddy:2";

export type ProxyMode = "binary" | "docker";

/** A branch name as a DNS label: lowercase letters, digits and hyphens, at most 63 characters. */
export function hostLabel(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").slice(0, 63).replace(/^-+|-+$/g, "");
}

/** The public URL for a branch, or "" when no domain is configured. */
export function publicUrl(cfg: Config, branch: string): string {
  const p = cfg.preview;
  if (!p.domain || p.proxy === "off") return "";
  const scheme = p.tls === "off" ? "http" : "https";
  const port = p.publicPort ?? (p.tls === "off" ? p.httpPort : p.httpsPort);
  const standard = (scheme === "https" && port === 443) || (scheme === "http" && port === 80);
  return `${scheme}://${hostLabel(branch)}.${p.domain}${standard ? "" : `:${port}`}`;
}

/** Caddy JSON config for these stacks. Pure: unit-tested. */
export function caddyConfig(cfg: Config, stacks: Stack[], mode: ProxyMode): object {
  const p = cfg.preview;
  const routes: object[] = [];
  for (const s of stacks) {
    if (!s.url) continue;
    let up: URL;
    try { up = new URL(s.url); } catch { continue; }
    const repo: RepoConfig | undefined = cfg.repos.find((r) => r.name === s.repo);
    const port = up.port || (up.protocol === "https:" ? "443" : "80");
    // Local dev hosts (*.localhost, 127.0.0.1) are dialed by address; from inside
    // Docker the host machine is host.docker.internal.
    const local = /(^|\.)localhost$/.test(up.hostname) || up.hostname === "127.0.0.1";
    const host = local ? (mode === "docker" ? "host.docker.internal" : "127.0.0.1") : up.hostname;
    const handler: Record<string, unknown> = { handler: "reverse_proxy", upstreams: [{ dial: `${host}:${port}` }] };
    if (up.protocol === "https:") {
      // Local stacks use self-signed (mkcert) certs: skip verification, keep the SNI they expect.
      handler.transport = { protocol: "http", tls: { insecure_skip_verify: true, server_name: up.hostname } };
    }
    if ((repo?.proxyHost ?? "public") === "upstream") {
      // The app sees the Host it's used to locally (e.g. a dev server that rejects unknown hosts).
      handler.headers = { request: { set: { Host: [up.host] } } };
    }
    routes.push({ match: [{ host: [`${hostLabel(s.branch)}.${p.domain}`] }], handle: [handler], terminal: true });
  }
  // Anything else on the domain: a plain 404 instead of a connection error.
  routes.push({ handle: [{ handler: "static_response", status_code: 404, body: "pr-demon: no preview is running for this address.\n" }] });

  const listen = p.tls === "off" ? [`:${p.httpPort}`] : [`:${p.httpsPort}`];
  const tls: Record<string, unknown> = {};
  if (p.tls === "internal") tls.automation = { policies: [{ issuers: [{ module: "internal" }] }] };
  else if (p.tls === "auto" && p.email) tls.automation = { policies: [{ issuers: [{ module: "acme", email: p.email }] }] };

  return {
    // Inside Docker the admin API must listen on all interfaces (it's published
    // to 127.0.0.1 only). pr-demon always sends Origin = the admin address.
    admin: { listen: mode === "docker" ? `0.0.0.0:${adminPort(cfg)}` : p.admin, origins: [p.admin] },
    ...(mode === "binary" ? { storage: { module: "file_system", root: join(CADDY_DIR, "data") } } : {}),
    apps: {
      http: {
        http_port: p.httpPort, https_port: p.httpsPort,
        servers: { previews: { listen, routes, ...(p.tls === "off" ? { automatic_https: { disable: true } } : {}) } },
      },
      ...(Object.keys(tls).length ? { tls } : {}),
      // Never try to install Caddy's local CA into the system trust store (it would prompt for sudo).
      pki: { certificate_authorities: { local: { install_trust: false } } },
    },
  };
}

function adminPort(cfg: Config): string {
  return cfg.preview.admin.split(":").pop() ?? "2019";
}

export interface ProxyStatus {
  enabled: boolean;
  mode: ProxyMode | null;
  running: boolean;
  routes: number;
  error: string;
  domain: string;
}

export class Proxy {
  private store: Store;
  private cfg: () => Config;
  private child: ChildProcess | null = null;
  private lastHash = "";
  private busy = false;
  status: ProxyStatus = { enabled: false, mode: null, running: false, routes: 0, error: "", domain: "" };

  constructor(store: Store, cfg: () => Config) { this.store = store; this.cfg = cfg; }

  start(): void {
    void this.tick();
    setInterval(() => void this.tick(), 5000).unref?.();
  }

  private adminUrl(path: string): string {
    return `http://${this.cfg().preview.admin}${path}`;
  }

  /** Caddy's admin API refuses Node's fetch (Sec-Fetch-Mode: cors) unless the Origin is allowed. */
  private admin(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.adminUrl(path), { ...init, headers: { ...(init.headers ?? {}), origin: `http://${this.cfg().preview.admin}` } });
  }

  private async alive(): Promise<boolean> {
    try { return (await this.admin("/config/", { signal: AbortSignal.timeout(2000) })).ok; }
    catch { return false; }
  }

  private async resolveMode(): Promise<ProxyMode | null> {
    const want = this.cfg().preview.proxy;
    if (want === "off") return null;
    if (want === "binary" || want === "docker") return want;
    if ((await run("which", ["caddy"])).code === 0) return "binary";
    if ((await run("docker", ["info"], { timeoutMs: 15_000 })).code === 0) return "docker";
    return null;
  }

  /** Keep Caddy running (or stopped) and its routes equal to the stacks table. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = this.cfg();
      const enabled = !!cfg.preview.domain && cfg.preview.proxy !== "off";
      const managed = this.store.get("proxy:managed") as ProxyMode | undefined;
      const mode = enabled ? await this.resolveMode() : null;
      // What Caddy was started with. Ports and the admin address are fixed at
      // launch (Docker publishes them), so a change means stop + start again.
      const launchKey = mode ? `${mode} ${cfg.preview.httpPort} ${cfg.preview.httpsPort} ${cfg.preview.admin} ${cfg.preview.tls}` : "";
      const launchedWith = this.store.get("proxy:launched") ?? "";

      if (managed && (managed !== mode || (launchedWith && launchedWith !== launchKey))) {
        await this.stop(managed);
        this.store.event(`preview proxy (${managed}) stopped${mode ? " to restart with new settings" : ""}`);
      }
      if (!enabled || !mode) {
        this.status = { enabled, mode, running: false, routes: 0, domain: cfg.preview.domain,
          error: enabled ? "no Caddy available: install it (brew install caddy) or start Docker" : "" };
        return;
      }
      this.status = { ...this.status, enabled, mode, domain: cfg.preview.domain };

      const stacks = this.store.stacks();
      const config = caddyConfig(cfg, stacks, mode);
      const text = JSON.stringify(config);
      const hash = createHash("sha1").update(text).digest("hex");
      mkdirSync(CADDY_DIR, { recursive: true });
      writeFileSync(join(CADDY_DIR, "caddy.json"), JSON.stringify(config, null, 2));

      if (!this.store.get("proxy:managed")) { this.store.set("proxy:managed", mode); this.store.set("proxy:launched", launchKey); }
      if (!(await this.alive())) {
        await this.launch(mode);
        this.store.set("proxy:managed", mode);
        this.store.set("proxy:launched", launchKey);
        this.lastHash = "";
        // The first Docker start may pull the image: give it up to 90s.
        for (let i = 0; i < 180 && !(await this.alive()); i++) await new Promise((r) => setTimeout(r, 500));
        if (!(await this.alive())) throw new Error(`Caddy (${mode}) didn't start; see ${join(CADDY_DIR, "caddy.log")}`);
        this.store.event(`preview proxy started (${mode}) for *.${cfg.preview.domain}`);
      }
      if (hash !== this.lastHash) {
        const r = await this.admin("/load", { method: "POST", headers: { "content-type": "application/json" }, body: text });
        if (!r.ok) throw new Error(`Caddy rejected the config: ${(await r.text()).slice(0, 500)}`);
        this.lastHash = hash;
      }
      this.status = { enabled, mode, running: true, routes: stacks.filter((s) => s.url).length, error: "", domain: cfg.preview.domain };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== this.status.error) this.store.event(`preview proxy: ${msg}`, null, "error");
      this.status = { ...this.status, running: false, error: msg };
    } finally {
      this.busy = false;
    }
  }

  private async launch(mode: ProxyMode): Promise<void> {
    const cfg = this.cfg().preview;
    if (mode === "binary") {
      const log = join(CADDY_DIR, "caddy.log");
      // Its own process group, so it outlives a pr-demon restart; the next
      // pr-demon finds it answering on the admin port and adopts it.
      this.child = spawn("bash", ["-c", `exec caddy run --config "${join(CADDY_DIR, "caddy.json")}" >> "${log}" 2>&1`],
        { detached: true, stdio: "ignore", env: { ...process.env, XDG_DATA_HOME: join(CADDY_DIR, "data") } });
      this.child.unref();
      return;
    }
    await run("docker", ["rm", "-f", CONTAINER]);
    const port = adminPort(this.cfg());
    const ports = cfg.tls === "off" ? [cfg.httpPort] : [cfg.httpPort, cfg.httpsPort];
    const r = await run("docker", ["run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
      "--add-host", "host.docker.internal:host-gateway",
      ...ports.flatMap((p) => ["-p", `${p}:${p}`]), "-p", `127.0.0.1:${port}:${port}`,
      "-v", `${CADDY_DIR}:/etc/pr-demon:ro`, "-v", "pr-demon-caddy-data:/data",
      IMAGE, "caddy", "run", "--config", "/etc/pr-demon/caddy.json"], { timeoutMs: 180_000 });
    if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim().slice(-400)}`);
  }

  async stop(mode: ProxyMode): Promise<void> {
    if (mode === "docker") await run("docker", ["rm", "-f", CONTAINER]);
    else { try { await this.admin("/stop", { method: "POST", signal: AbortSignal.timeout(3000) }); } catch { /* already gone */ } }
    this.store.set("proxy:managed", "");
    this.store.set("proxy:launched", "");
    this.lastHash = "";
    // Wait for the ports to be released before anything starts again.
    for (let i = 0; i < 20 && (await this.alive()); i++) await new Promise((r) => setTimeout(r, 250));
  }
}
