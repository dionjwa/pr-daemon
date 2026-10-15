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

import { caddyConfig, hostLabel, publicUrl } from "./proxy.ts";
import { poolHint } from "./stack.ts";
import { withNetworks } from "./pipeline.ts";
import type { Stack } from "./db.ts";

const stackOf = (branch: string, url: string, repo = "o/r"): Stack => ({
  repo, branch, issue: Number(branch.split("-")[0]), worktree: "/w", url, pr: null, builder_session: "", healthy: 1, error: "", networks: "", checked_at: null, created_at: 0,
});

test("branch → DNS label", () => {
  assert.equal(hostLabel("94-my-new-feature"), "94-my-new-feature");
  assert.equal(hostLabel("94-My_New.Feature"), "94-my-new-feature");
  assert.equal(hostLabel("x".repeat(80)).length, 63);
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
});

test("preview config validation", () => {
  assert.throws(() => parseConfig(`[preview]\ndomain = "not a domain"`), /preview.domain/);
  assert.throws(() => parseConfig(`[preview]\nproxy = "nginx"`), /preview.proxy must be one of/);
  assert.throws(() => parseConfig(`[[repos]]\nname = "o/r"\nproxy_host = "x"`), /proxy_host/);
  assert.equal(parseConfig(`[preview]\ndomain = "*.Preview.Example.com"`).preview.domain, "preview.example.com");
});

test("caddy config routes each branch host to its local stack", () => {
  const cfg = parseConfig(`[preview]\ndomain = "p.example.com"\nemail = "me@example.com"\n[[repos]]\nname = "o/r"\nproxy_host = "upstream"\n[[repos]]\nname = "o/s"`);
  const c = caddyConfig(cfg, [
    stackOf("94-my-new-feature", "https://framejs-app.localhost:13536"),
    stackOf("7-plain", "http://127.0.0.1:8080", "o/s"),
    stackOf("8-no-url", ""),
  ], "binary") as any;
  const server = c.apps.http.servers.previews;
  assert.deepEqual(server.listen, [":443"]);
  assert.equal(server.routes.length, 3); // two stacks + the 404 fallback
  const [a, b, fallback] = server.routes;
  assert.deepEqual(a.match, [{ host: ["94-my-new-feature.p.example.com"] }]);
  assert.equal(a.handle[0].upstreams[0].dial, "127.0.0.1:13536");
  assert.equal(a.handle[0].transport.tls.server_name, "framejs-app.localhost");
  assert.deepEqual(a.handle[0].headers.request.set.Host, ["framejs-app.localhost:13536"]);
  assert.equal(b.handle[0].upstreams[0].dial, "127.0.0.1:8080");
  assert.equal(b.handle[0].transport, undefined);
  assert.equal(b.handle[0].headers, undefined);           // proxy_host defaults to public
  assert.equal(fallback.handle[0].status_code, 404);
  assert.equal(c.apps.tls.automation.policies[0].issuers[0].email, "me@example.com");
  assert.equal(c.apps.pki.certificate_authorities.local.install_trust, false);
  const d = caddyConfig(cfg, [stackOf("94-x", "https://framejs-app.localhost:13536")], "docker") as any;
  assert.equal(d.apps.http.servers.previews.routes[0].handle[0].upstreams[0].dial, "host.docker.internal:13536");
  assert.match(d.admin.listen, /^0\.0\.0\.0:/);
  assert.deepEqual(d.admin.origins, ["127.0.0.1:2019"]);
});
