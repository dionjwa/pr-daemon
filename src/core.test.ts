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
  assert.equal(c.repos[0].up, "just pr-demon-up");
  assert.equal(c.repos[0].check, "");
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
