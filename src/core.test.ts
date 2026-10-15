import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAmount, parseDuration, formatAmount } from "./util.ts";
import { DEFAULT_TOML, parseConfig } from "./config.ts";
import { render } from "./pipeline.ts";
import { openDb, Store } from "./db.ts";
import { gate, windowState } from "./budget.ts";

test("human amounts", () => {
  assert.equal(parseAmount("40M"), 40_000_000);
  assert.equal(parseAmount("1.5m"), 1_500_000);
  assert.equal(parseAmount("500k"), 500_000);
  assert.equal(parseAmount("40,000,000"), 40_000_000);
  assert.equal(parseAmount("2B tokens"), 2_000_000_000);
  assert.equal(parseAmount(""), null);
  assert.throws(() => parseAmount("lots"));
  assert.equal(formatAmount(2_734_000), "2.73M");
});

test("durations", () => {
  assert.equal(parseDuration("5h"), 5 * 3600e3);
  assert.equal(parseDuration("1h30m"), 90 * 60e3);
  assert.equal(parseDuration(60), 60e3);
  assert.throws(() => parseDuration("soon"));
  assert.throws(() => parseDuration("5h later"));
});

test("render is single-pass", () => {
  assert.equal(render("a {{X}} b {{Y}} {{1X}}", { X: "{{Y}}", Y: "y" }), "a {{Y}} b y {{1X}}");
  assert.equal(render("{{MISSING}}!", {}), "!");
  assert.equal(render("$& $1 \\", {}), "$& $1 \\");
  assert.equal(render("{{X}}", { X: "$& $1" }), "$& $1");
});

test("default config parses, with no limits", () => {
  const c = parseConfig(DEFAULT_TOML);
  assert.equal(c.label, "agent");
  assert.equal(c.budget.tokens, null);
  assert.equal(c.budget.windowMs, 5 * 3600e3);
  assert.equal(c.repos.length, 0);
});

test("config validation gives readable errors", () => {
  assert.throws(() => parseConfig(`[budget]\ntokens = "heaps"`), /budget.tokens/);
  assert.throws(() => parseConfig(`[[repos]]\nname = "nope"`), /owner\/repo/);
  assert.throws(() => parseConfig(`poll = "1s"`), /at least 10s/);
  assert.throws(() => parseConfig(`port = `), /TOML syntax/);
  const c = parseConfig(`[budget]\ntokens = "40M"\nper_issue = "5M"\n[[repos]]\nname = "o/r"\ncheck = ""`);
  assert.equal(c.budget.tokens, 40e6);
  assert.equal(c.repos[0].up, "just pr-daemon-up");
  assert.equal(c.repos[0].check, "");
});

test("the repos list: several blocks, and the mistakes people make with TOML", () => {
  const c = parseConfig(`[[repos]]\nname = "o/api"\n\n[[repos]]\nname = "o/web"\ncheck = "just test"`);
  assert.deepEqual(c.repos.map((r) => r.name), ["o/api", "o/web"]);
  assert.equal(c.repos[0].check, "just pr-daemon-check");   // settings belong to their own block
  assert.equal(c.repos[1].check, "just test");
  assert.throws(() => parseConfig(`[repos]\nname = "o/r"`), /DOUBLE brackets/);        // single brackets
  assert.throws(() => parseConfig(`repos = ["o/r"]`), /block of settings/);            // a bare list
  assert.throws(() => parseConfig(`[[repos]]\ncheck = ""`), /has no name/);
  assert.throws(() => parseConfig(`[[repos]]\nname = "your-org/your-repo"`), /replace the example/);
  assert.throws(() => parseConfig(`[[repos]]\nname = "o/r"\n[[repos]]\nname = "o/r"`), /two \[\[repos\]\] blocks/);
});

test("docker networks: what a stack owns, and the pool-exhaustion hint", () => {
  // Remembered across several `up`s, deduped, and empty when nothing was created.
  assert.equal(withNetworks("", ["a", "b"]), "a b");
  assert.equal(withNetworks("a b", ["b", "c"]), "a b c");
  assert.equal(withNetworks(undefined, []), "");

  const real = "failed to create network app_default: Error response from daemon: " +
    "could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network";
  assert.match(poolHint(real), /Docker has no address space left/);
  assert.match(poolHint("all predefined address pools have been fully subnetted"), /docker network ls/);
  assert.equal(poolHint("just: command not found"), "");
});

test("budget window, per-issue cap, and when it frees up", () => {
  const dir = mkdtempSync(join(tmpdir(), "prd-"));
  const store = new Store(openDb(join(dir, "t.db")));
  const cfg = parseConfig(`[budget]\nwindow = "5h"\ntokens = "1M"\nper_issue = "700k"\ncount_cache_reads = false`);
  const id = store.enqueue({ repo: "o/r", kind: "build", number: 1, trigger_key: "k" })!;
  const job = store.job(id)!;
  const now = Date.now();
  const add = (at: number, n: number, cacheRead = 0) => store.db.prepare(
    "INSERT INTO usage(job_id, repo, issue, at, input, output, cache_create, cache_read) VALUES(?, 'o/r', ?, ?, ?, 0, 0, ?)")
    .run(job.id, 1, at, n, cacheRead);
  add(now - 4 * 3600e3, 400_000, 9_000_000);   // cache reads not counted
  assert.deepEqual(gate(store, cfg, "o/r", 1, now), { ok: true });
  add(now - 3600e3, 400_000);
  const g = gate(store, cfg, "o/r", 1, now);        // 800k on issue 1 > 700k cap
  assert.equal(g.ok, false);
  assert.equal(!g.ok && g.needsHuman, true);
  assert.equal(gate(store, cfg, "o/r", 2, now).ok, true);   // other issues are fine
  store.db.prepare("INSERT INTO usage(job_id, repo, issue, at, input, output, cache_create, cache_read) VALUES(?, 'o/r', 2, ?, 300000, 0, 0, 0)").run(job.id, now - 60e3);
  const w = windowState(store, cfg, now);
  assert.equal(w.used, 1_100_000);
  assert.equal(w.freesAt, now - 4 * 3600e3 + 5 * 3600e3);  // when the oldest 400k ages out
  const g2 = gate(store, cfg, "o/r", 2, now);
  assert.equal(!g2.ok && g2.needsHuman, false);
});

import { caddyConfig, CHECK_BODY, hostLabel, publicEnv, publicUrl, serviceUrl } from "./proxy.ts";
import { parseUp, poolHint } from "./stack.ts";
import { stackWhere, withNetworks } from "./pipeline.ts";
import type { Stack } from "./db.ts";

const stackOf = (branch: string, url: string, repo = "o/r", routes: Record<string, string> = {}): Stack => ({
  repo, branch, issue: Number(branch.split("-")[0]), worktree: "/w", url, pr: null, builder_session: "", healthy: 1, error: "", networks: "",
  routes: JSON.stringify(routes), checked_at: null, created_at: 0,
});

test("branch → DNS label", () => {
  assert.equal(hostLabel("94-my-new-feature"), "94-my-new-feature");
  assert.equal(hostLabel("94-My_New.Feature"), "94-my-new-feature");
  assert.equal(hostLabel("x".repeat(80)).length, 48);   // leaves room for "--<service>" in 63
  assert.equal(hostLabel("--a--"), "a");
});

test("public URLs", () => {
  const on = parseConfig(`[preview]\ndomain = "preview.example.com"`);
  assert.equal(publicUrl(on, "94-my-new-feature"), "https://94-my-new-feature.preview.example.com");
  assert.equal(publicUrl(parseConfig(`[preview]\ndomain = "p.test"\nhttps_port = 8443`), "1-a"), "https://1-a.p.test:8443");
  assert.equal(publicUrl(parseConfig(`[preview]\ndomain = "p.test"\nhttps_port = 8443\npublic_port = 443`), "1-a"), "https://1-a.p.test");
  assert.equal(publicUrl(parseConfig(`[preview]\ndomain = "p.test"\ntls = "off"`), "1-a"), "http://1-a.p.test");
  assert.equal(publicUrl(parseConfig(`[preview]\ndomain = "p.test"\nproxy = "off"`), "1-a"), "");
  assert.equal(publicUrl(parseConfig(DEFAULT_TOML), "1-a"), "");
  assert.equal(serviceUrl(on, "94-my-new-feature", "auth"), "https://94-my-new-feature--auth.preview.example.com");
  assert.equal(serviceUrl(parseConfig(`[preview]\ndomain = "p.test"\nhttps_port = 8443`), "1-a", "db"), "https://1-a--db.p.test:8443");
  assert.ok(new URL(serviceUrl(on, "9-" + "x".repeat(80), "abcdefghijkl")).hostname.split(".")[0].length <= 63);
  const env = publicEnv(on, "94-my-new-feature");
  assert.equal(env.PR_DAEMON_PUBLIC_HOST, "94-my-new-feature.preview.example.com");
  assert.equal(env.PR_DAEMON_SERVICE_URL_TEMPLATE.replace("{service}", "auth"), serviceUrl(on, "94-my-new-feature", "auth"));
  assert.deepEqual(Object.values(publicEnv(parseConfig(DEFAULT_TOML), "1-a")), ["", "", ""]);
});

test("preview config validation", () => {
  assert.throws(() => parseConfig(`[preview]\ndomain = "not a domain"`), /preview.domain/);
  assert.throws(() => parseConfig(`[preview]\nproxy = "nginx"`), /preview.proxy must be one of/);
  assert.throws(() => parseConfig(`[[repos]]\nname = "o/r"\nproxy_host = "x"`), /proxy_host/);
  assert.equal(parseConfig(`[preview]\ndomain = "*.Preview.Example.com"`).preview.domain, "preview.example.com");
});

test("up output: the last bare URL, plus PR_DAEMON_ROUTE lines", () => {
  const ok = parseUp("starting…\nPR_DAEMON_ROUTE auth https://local.auth.local.nhost.run:11536\n  PR_DAEMON_ROUTE graphql https://local.graphql.local.nhost.run:11536\nhttps://app.localhost:13536\n");
  assert.deepEqual(ok, { url: "https://app.localhost:13536", routes: { auth: "https://local.auth.local.nhost.run:11536", graphql: "https://local.graphql.local.nhost.run:11536" } });
  assert.deepEqual(parseUp("http://localhost:8080"), { url: "http://localhost:8080", routes: {} });
  assert.match((parseUp("PR_DAEMON_ROUTE Auth-Svc https://x.localhost\nhttp://a") as { error: string }).error, /bad route line/);
  assert.match((parseUp("PR_DAEMON_ROUTE auth\nhttp://a") as { error: string }).error, /bad route line/);
});

test("with a domain the agent is pointed at the public URLs only", () => {
  const cfg = parseConfig(`[preview]\ndomain = "p.example.com"`);
  const up = { ok: true as const, url: "https://app.localhost:1", routes: { auth: "https://a.localhost:2" }, networks: [] };
  const where = stackWhere(cfg, "4-x", up);
  assert.match(where, /^https:\/\/4-x\.p\.example\.com — use ONLY/);
  assert.match(where, /auth → https:\/\/4-x--auth\.p\.example\.com/);
  assert.equal(stackWhere(parseConfig(""), "4-x", up), "https://app.localhost:1");
});

test("preview.dns: one wildcard certificate through DNS-01", () => {
  const cfg = parseConfig(`[preview]\ndomain = "p.example.com"\ndns = "cloudflare"\nemail = "me@example.com"`);
  const c = caddyConfig(cfg, [stackOf("4-x", "http://127.0.0.1:1", "o/r", { auth: "http://127.0.0.1:2" })], "binary") as any;
  assert.deepEqual(c.apps.tls.certificates.automate, ["*.p.example.com"]);
  const [wild, rest] = c.apps.tls.automation.policies;
  assert.deepEqual(wild.subjects, ["*.p.example.com"]);
  assert.equal(wild.issuers[0].email, "me@example.com");
  assert.equal(wild.issuers[0].challenges.dns.provider.name, "cloudflare");
  assert.equal(wild.issuers[0].challenges.dns.provider.api_token, "{env.CLOUDFLARE_API_TOKEN}");  // never the token itself
  assert.equal(rest.subjects, undefined);
  assert.equal(c.apps.http.servers.previews.automatic_https, undefined);   // Caddy ≥ 2.10 prefers the wildcard by itself
  // Without it: per-host certificates, as before.
  const plain = caddyConfig(parseConfig(`[preview]\ndomain = "p.example.com"`), [], "binary") as any;
  assert.equal(plain.apps.tls, undefined);
  assert.throws(() => parseConfig(`[preview]\ndomain = "p.example.com"\ndns = "cloudflare"\ntls = "internal"`), /preview.dns only applies/);
  assert.throws(() => parseConfig(`[preview]\ndns = "route53"`), /preview.dns must be one of: "", cloudflare/);
});

test("caddy config routes each branch host to its local stack", () => {
  const cfg = parseConfig(`[preview]\ndomain = "p.example.com"\nemail = "me@example.com"\n[[repos]]\nname = "o/r"\nproxy_host = "upstream"\n[[repos]]\nname = "o/s"`);
  const c = caddyConfig(cfg, [
    stackOf("94-my-new-feature", "https://framejs-app.localhost:13536", "o/r", { auth: "https://local.auth.local.nhost.run:11536", "bad-name": "http://x.localhost" }),
    stackOf("7-plain", "http://127.0.0.1:8080", "o/s"),
    stackOf("8-no-url", ""),
  ], "binary") as any;
  const server = c.apps.http.servers.previews;
  assert.deepEqual(server.listen, [":443"]);
  assert.equal(server.routes.length, 5); // two stacks + one valid service + the check page + the 404 fallback
  const [a, svc, b, check, fallback] = server.routes;
  // A service: its own host, dialed by name, always with its local Host (gateways route on it).
  assert.deepEqual(svc.match, [{ host: ["94-my-new-feature--auth.p.example.com"] }]);
  assert.equal(svc.handle[0].upstreams[0].dial, "local.auth.local.nhost.run:11536");
  assert.equal(svc.handle[0].transport.tls.server_name, "local.auth.local.nhost.run");
  assert.deepEqual(svc.handle[0].headers.request.set.Host, ["local.auth.local.nhost.run:11536"]);
  assert.deepEqual(a.match, [{ host: ["94-my-new-feature.p.example.com"] }]);
  assert.equal(a.handle[0].upstreams[0].dial, "127.0.0.1:13536");
  assert.equal(a.handle[0].transport.tls.server_name, "framejs-app.localhost");
  assert.deepEqual(a.handle[0].headers.request.set.Host, ["framejs-app.localhost:13536"]);
  assert.equal(b.handle[0].upstreams[0].dial, "127.0.0.1:8080");
  assert.equal(b.handle[0].transport, undefined);
  assert.equal(b.handle[0].headers, undefined);           // proxy_host defaults to public
  assert.deepEqual(check.match, [{ host: ["pr-daemon.p.example.com"] }]);
  assert.equal(check.handle[0].body, CHECK_BODY);
  assert.equal(fallback.handle[0].status_code, 404);
  assert.equal(c.apps.tls.automation.policies[0].issuers[0].email, "me@example.com");
  assert.equal(c.apps.pki.certificate_authorities.local.install_trust, false);
  const d = caddyConfig(cfg, [stackOf("94-x", "https://framejs-app.localhost:13536")], "docker") as any;
  assert.equal(d.apps.http.servers.previews.routes[0].handle[0].upstreams[0].dial, "host.docker.internal:13536");
  assert.match(d.admin.listen, /^0\.0\.0\.0:/);
  assert.deepEqual(d.admin.origins, ["127.0.0.1:2019"]);
});
