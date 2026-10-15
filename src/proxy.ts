// Public preview URLs: https://<branch>.<domain> → that branch's local stack.
//
// pr-daemon owns one Caddy (the `caddy` binary, or a Docker container) and
// keeps its routes equal to the stacks table. Every few seconds it rebuilds
// the whole Caddy config from the stacks and loads it through Caddy's admin
// API when it changed: no incremental state to drift. Caddy handles TLS
// (Let's Encrypt per branch host, or its own local CA for testing).
//
// You route the domain to this machine (DNS + port forwards); pr-daemon does
// the rest.
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, type Config, type RepoConfig } from "./config.ts";
import type { Stack, Store } from "./db.ts";
import { run } from "./util.ts";

const CADDY_DIR = join(HOME, "caddy");
const CONTAINER = "pr-daemon-caddy";
const IMAGE = "caddy:2";
/** How long Caddy lets open connections (HMR websockets, …) finish when it stops or reloads. */
const GRACE = "5s";
/** How long shutdown waits for Caddy to exit. pr-daemon's own exit deadline (cli.ts) must be longer. */
export const STOP_WAIT_MS = 15_000;

// ---------------------------------------------------------------- wildcard certificate
// With [preview] dns set, Caddy gets ONE certificate for *.<domain> through the
// DNS-01 challenge (Let's Encrypt only issues wildcards that way): it writes a
// TXT record through the DNS provider's API. Every branch and service host is
// one label under the domain, so that one certificate covers them all: new
// previews get HTTPS instantly, there are no per-host rate limits, and branch
// names stay out of the public Certificate Transparency logs. Stock Caddy has
// no DNS providers, so the binary needs `caddy add-package`, and Docker mode
// builds its own image.

/** Where the DNS provider's API token comes from: the environment, then a file. */
export const DNS_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
export const DNS_TOKEN_FILE = join(HOME, "cloudflare-token");
export const DNS_MODULE = "github.com/caddy-dns/cloudflare";
const DNS_IMAGE = "pr-daemon-caddy-cloudflare";
const DNS_DOCKERFILE = `FROM caddy:2-builder AS builder
RUN xcaddy build --with ${DNS_MODULE}
FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
`;

/** The DNS API token, or "" when there's none. */
export function dnsToken(): string {
  const env = process.env[DNS_TOKEN_ENV]?.trim();
  if (env) return env;
  try { return readFileSync(DNS_TOKEN_FILE, "utf8").trim(); } catch { return ""; }
}

/** Whether the installed caddy binary has the DNS provider module. */
export async function caddyHasDns(provider: string): Promise<boolean> {
  return (await run("caddy", ["list-modules"])).stdout.includes(`dns.providers.${provider}`);
}

export type ProxyMode = "binary" | "docker";

// A stack is wired for ONE origin. When a domain is set, the app's browser code
// runs on https://<branch>.<domain>, and browsers refuse to let a public page
// call loopback addresses (Local Network Access): so every service the browser
// talks to needs a public host too. Each branch gets a family of hosts, one
// label deep so the single wildcard record covers them all:
//
//   https://<branch>.<domain>             the app
//   https://<branch>--<service>.<domain>  each service `up` declares
//
// A branch label never contains "--" (hostLabel collapses hyphens), so the two
// can't collide. The branch part is capped at 48 characters so the longest
// service name still fits in a 63-character DNS label.

/** Service names a stack may declare: they become part of a DNS label. */
export const SERVICE_NAME = /^[a-z0-9]{1,12}$/;

/** A branch name as a DNS label: lowercase letters, digits and hyphens, at most 48 characters. */
export function hostLabel(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").slice(0, 48).replace(/^-+|-+$/g, "");
}

/** <scheme>://<label>.<domain>[:port], or "" when no domain is configured. */
function origin(cfg: Config, label: string): string {
  const p = cfg.preview;
  if (!p.domain || p.proxy === "off") return "";
  const scheme = p.tls === "off" ? "http" : "https";
  const port = p.publicPort ?? (p.tls === "off" ? p.httpPort : p.httpsPort);
  const standard = (scheme === "https" && port === 443) || (scheme === "http" && port === 80);
  return `${scheme}://${label}.${p.domain}${standard ? "" : `:${port}`}`;
}

/** The public URL for a branch, or "" when no domain is configured. */
export function publicUrl(cfg: Config, branch: string): string {
  return origin(cfg, hostLabel(branch));
}

/** The public URL of one of a branch's services, e.g. https://42-x--auth.<domain>. */
export function serviceUrl(cfg: Config, branch: string, service: string): string {
  return origin(cfg, `${hostLabel(branch)}--${service}`);
}

/** What `up` is told about its public addresses. All empty when no domain is set. */
export function publicEnv(cfg: Config, branch: string): Record<string, string> {
  const url = publicUrl(cfg, branch);
  return {
    PR_DAEMON_PUBLIC_URL: url,
    PR_DAEMON_PUBLIC_HOST: url ? new URL(url).host : "",
    // Put a service name in place of {service}: "${PR_DAEMON_SERVICE_URL_TEMPLATE/\{service\}/auth}"
    PR_DAEMON_SERVICE_URL_TEMPLATE: url ? serviceUrl(cfg, branch, "{service}") : "",
  };
}

/** A stack's declared services (name → local URL), from the stacks table's JSON column. */
export function stackRoutes(s: Pick<Stack, "routes">): Record<string, string> {
  try { return s.routes ? JSON.parse(s.routes) : {}; } catch { return {}; }
}

/** pr-daemon.<domain> is answered by Caddy itself, no stack needed: it proves DNS, port forwards and TLS on their own. */
export const CHECK_LABEL = "pr-daemon";

/** The body served there; `doctor` looks for it. */
export const CHECK_BODY = "pr-daemon: the preview proxy is working.\n";

/** Caddy JSON config for these stacks. Pure: unit-tested. */
export function caddyConfig(cfg: Config, stacks: Stack[], mode: ProxyMode): object {
  const p = cfg.preview;
  const routes: object[] = [];
  for (const s of stacks) {
    const repo: RepoConfig | undefined = cfg.repos.find((r) => r.name === s.repo);
    const app = s.url ? proxyTo(s.url, mode, (repo?.proxyHost ?? "public") === "upstream") : null;
    if (app) routes.push({ match: [{ host: [`${hostLabel(s.branch)}.${p.domain}`] }], handle: [app], terminal: true });
    // Services always get their local Host: they usually sit behind a gateway
    // that routes on it (nhost's local.<svc>.local.nhost.run, a Traefik, …).
    for (const [name, url] of Object.entries(stackRoutes(s))) {
      const handler = SERVICE_NAME.test(name) ? proxyTo(url, mode, true) : null;
      if (handler) routes.push({ match: [{ host: [`${hostLabel(s.branch)}--${name}.${p.domain}`] }], handle: [handler], terminal: true });
    }
  }
  // The proxy's own page, so routing can be checked before any preview exists.
  routes.push({ match: [{ host: [`${CHECK_LABEL}.${p.domain}`] }], handle: [{ handler: "static_response", status_code: 200, body: CHECK_BODY }], terminal: true });
  // Anything else on the domain: a plain 404 instead of a connection error.
  routes.push({ handle: [{ handler: "static_response", status_code: 404, body: "pr-daemon: no preview is running for this address.\n" }] });

  const listen = p.tls === "off" ? [`:${p.httpPort}`] : [`:${p.httpsPort}`];
  const tls: Record<string, unknown> = {};
  const acme = { module: "acme", ...(p.email ? { email: p.email } : {}) };
  const wildcard = p.tls === "auto" && !!p.dns;
  if (p.tls === "internal") tls.automation = { policies: [{ issuers: [{ module: "internal" }] }] };
  else if (wildcard) {
    // The token stays out of caddy.json: Caddy reads it from its environment.
    // Propagation is checked against a public resolver, not this machine's
    // (which may be a VPN's, or have cached the name's absence).
    const dns = { provider: { name: p.dns, api_token: `{env.${DNS_TOKEN_ENV}}` }, resolvers: ["1.1.1.1:53"] };
    tls.automation = { policies: [{ subjects: [`*.${p.domain}`], issuers: [{ ...acme, challenges: { dns } }] }, { issuers: [acme] }] };
    tls.certificates = { automate: [`*.${p.domain}`] };
  } else if (p.tls === "auto" && p.email) tls.automation = { policies: [{ issuers: [acme] }] };

  return {
    // Inside Docker the admin API must listen on all interfaces (it's published
    // to 127.0.0.1 only). pr-daemon always sends Origin = the admin address.
    admin: { listen: mode === "docker" ? `0.0.0.0:${adminPort(cfg)}` : p.admin, origins: [p.admin] },
    ...(mode === "binary" ? { storage: { module: "file_system", root: join(CADDY_DIR, "data") } } : {}),
    apps: {
      http: {
        http_port: p.httpPort, https_port: p.httpsPort,
        // Without one Caddy waits forever for open connections, and a dev
        // server's websocket would keep it from ever stopping.
        grace_period: GRACE,
        // Caddy ≥ 2.10 serves hosts covered by a managed wildcard from it rather than getting their own.
        servers: { previews: { listen, routes, ...(p.tls === "off" ? { automatic_https: { disable: true } } : {}) } },
      },
      ...(Object.keys(tls).length ? { tls } : {}),
      // Never try to install Caddy's local CA into the system trust store (it would prompt for sudo).
      pki: { certificate_authorities: { local: { install_trust: false } } },
    },
  };
}

/** A reverse_proxy handler for a local URL, or null if it isn't one. */
function proxyTo(url: string, mode: ProxyMode, keepHost: boolean): Record<string, unknown> | null {
  let up: URL;
  try { up = new URL(url); } catch { return null; }
  const port = up.port || (up.protocol === "https:" ? "443" : "80");
  // Stacks run on this machine: from inside Docker that's host.docker.internal.
  // The binary dials *.localhost and 127.0.0.1 by address, and anything else by
  // name (e.g. local.auth.local.nhost.run, whose public DNS says 127.0.0.1).
  const local = /(^|\.)localhost$/.test(up.hostname) || up.hostname === "127.0.0.1";
  const host = mode === "docker" ? "host.docker.internal" : local ? "127.0.0.1" : up.hostname;
  const handler: Record<string, unknown> = { handler: "reverse_proxy", upstreams: [{ dial: `${host}:${port}` }] };
  if (up.protocol === "https:") {
    // Local stacks use self-signed (mkcert) certs: skip verification, keep the SNI they expect.
    handler.transport = { protocol: "http", tls: { insecure_skip_verify: true, server_name: up.hostname } };
  }
  // The upstream sees the Host it's used to locally (e.g. a dev server that rejects unknown hosts).
  if (keepHost) handler.headers = { request: { set: { Host: [up.host] } } };
  return handler;
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
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  status: ProxyStatus = { enabled: false, mode: null, running: false, routes: 0, error: "", domain: "" };

  constructor(store: Store, cfg: () => Config) { this.store = store; this.cfg = cfg; }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref?.();
  }

  /**
   * Stop the Caddy we manage and don't start another: previews die with
   * pr-daemon. (Preview stacks are separate; they keep running.) Called on
   * SIGINT/SIGTERM, so a `launchctl kickstart` restart means a few seconds
   * of downtime on the preview URLs while the new process starts Caddy again.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (let i = 0; i < 20 && this.busy; i++) await new Promise((r) => setTimeout(r, 100));
    const managed = this.store.get("proxy:managed") as ProxyMode | undefined;
    if (!managed) return;
    this.store.event(`stopping the preview proxy (${managed}): pr-daemon is shutting down`);
    const started = Date.now();
    const gone = await this.stop(managed);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (gone) this.store.event(`preview proxy (${managed}) stopped after ${secs}s`);
    else this.store.event(`preview proxy (${managed}) still running after ${secs}s; the next start adopts it`, null, "warn");
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
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const cfg = this.cfg();
      const enabled = !!cfg.preview.domain && cfg.preview.proxy !== "off";
      const managed = this.store.get("proxy:managed") as ProxyMode | undefined;
      const mode = enabled ? await this.resolveMode() : null;
      // What Caddy was started with. Ports and the admin address are fixed at
      // launch (Docker publishes them), so a change means stop + start again.
      // The DNS token is handed to Caddy at launch, so a new one means a relaunch too (only a fingerprint is stored).
      const token = cfg.preview.dns ? createHash("sha1").update(dnsToken()).digest("hex").slice(0, 8) : "";
      const launchKey = mode ? `${mode} ${cfg.preview.httpPort} ${cfg.preview.httpsPort} ${cfg.preview.admin} ${cfg.preview.tls} ${cfg.preview.dns} ${token}` : "";
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
    const env: NodeJS.ProcessEnv = { ...process.env };
    let image = IMAGE;
    if (cfg.dns) {
      const token = dnsToken();
      if (!token) throw new Error(`preview.dns = "${cfg.dns}" needs an API token (Zone > DNS > Edit): put it in ${DNS_TOKEN_FILE} or $${DNS_TOKEN_ENV}`);
      env[DNS_TOKEN_ENV] = token;
      if (mode === "binary" && !(await caddyHasDns(cfg.dns))) {
        throw new Error(`this caddy has no ${cfg.dns} DNS module: run \`caddy add-package ${DNS_MODULE}\` (redo it after upgrading caddy), or set proxy = "docker"`);
      }
      if (mode === "docker") {
        image = DNS_IMAGE;
        if ((await run("docker", ["image", "inspect", DNS_IMAGE])).code !== 0) {
          this.store.event(`building the ${DNS_IMAGE} Docker image (Caddy with the ${cfg.dns} DNS module); this takes a few minutes once`);
          const b = await run("docker", ["build", "-t", DNS_IMAGE, "-"], { input: DNS_DOCKERFILE, timeoutMs: 15 * 60e3 });
          if (b.code !== 0) throw new Error(`docker build ${DNS_IMAGE} failed: ${b.stderr.trim().slice(-400)}`);
        }
      }
    }
    if (mode === "binary") {
      const log = join(CADDY_DIR, "caddy.log");
      // Its own process group, so a Ctrl-C or a signal to pr-daemon doesn't
      // kill it mid-request: shutdown() asks it to stop through the admin API
      // instead. If pr-daemon dies without that (SIGKILL, a crash), Caddy
      // keeps serving and the next pr-daemon adopts it on the admin port.
      this.child = spawn("bash", ["-c", `exec caddy run --config "${join(CADDY_DIR, "caddy.json")}" >> "${log}" 2>&1`],
        { detached: true, stdio: "ignore", env: { ...env, XDG_DATA_HOME: join(CADDY_DIR, "data") } });
      this.child.unref();
      return;
    }
    await run("docker", ["rm", "-f", CONTAINER]);
    const port = adminPort(this.cfg());
    const ports = cfg.tls === "off" ? [cfg.httpPort] : [cfg.httpPort, cfg.httpsPort];
    const r = await run("docker", ["run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
      "--add-host", "host.docker.internal:host-gateway",
      ...ports.flatMap((p) => ["-p", `${p}:${p}`]), "-p", `127.0.0.1:${port}:${port}`,
      "-v", `${CADDY_DIR}:/etc/pr-daemon:ro`, "-v", "pr-daemon-caddy-data:/data",
      // `-e NAME` alone takes the value from this process's env, so the token isn't on the command line.
      ...(cfg.dns ? ["-e", DNS_TOKEN_ENV] : []),
      image, "caddy", "run", "--config", "/etc/pr-daemon/caddy.json"], { timeoutMs: 180_000, env });
    if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim().slice(-400)}`);
  }

  /** Stop Caddy and wait until it has exited (and released its ports). Returns false if it's still running. */
  async stop(mode: ProxyMode): Promise<boolean> {
    // Its pid, so we can wait for the process itself and not just its admin API.
    const pid = mode === "binary" ? await this.pid() : 0;
    const deadline = Date.now() + STOP_WAIT_MS;
    if (mode === "docker") await run("docker", ["rm", "-f", CONTAINER], { timeoutMs: STOP_WAIT_MS });
    else { try { await this.admin("/stop", { method: "POST", signal: AbortSignal.timeout(3000) }); } catch { /* already gone */ } }
    this.store.set("proxy:managed", "");
    this.store.set("proxy:launched", "");
    this.lastHash = "";
    while (Date.now() < deadline) {
      if (!(await this.alive()) && !(pid && running(pid))) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /** The pid listening on the admin port (ours or an adopted Caddy), or 0. */
  private async pid(): Promise<number> {
    const r = await run("lsof", ["-nP", `-iTCP:${adminPort(this.cfg())}`, "-sTCP:LISTEN", "-t"], { timeoutMs: 5000 });
    return Number(r.stdout.trim().split("\n")[0]) || 0;
  }
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
