// Which names reach a preview from inside the container.
//
// A preview stack is started through the Docker socket, so its containers are
// pr-daemon's siblings and their ports are published on the *host*. From in
// here, then, neither address a preview answers on resolves to the right
// place: the stack's own URL is the host's localhost (not ours), and the
// public `https://<branch>.<domain>` goes out to public DNS and back to a
// router that may not hairpin. pr-daemon's own probes can say `curl --resolve`
// (stack.probe), but the agents, Playwright and the project's own commands
// can't be given a flag.
//
// So pr-daemon keeps a block in the container's own /etc/hosts pointing every
// name a stack answers on at the host gateway, rebuilt from the stacks table
// like the Caddy routes. The host's /etc/hosts is never touched: this is the
// file Docker mounts into this container alone.
//
// Two gotchas: the file is a bind mount, so it must be written in place (a
// rename over it fails with EBUSY), and it is root-owned at container start,
// so docker/entrypoint.sh chowns it before dropping privileges. Without that
// permission the block is simply not written — local URLs still work through
// viaHost(), and only the public ones are unreachable from inside.
import { readFileSync, writeFileSync } from "node:fs";
import type { Config } from "./config.ts";
import type { Stack } from "./db.ts";
import { CHECK_LABEL, hostLabel, stackRoutes } from "./proxy.ts";
import { LOCAL_HOST, localHostIp, log } from "./util.ts";

const HOSTS = "/etc/hosts";
const BEGIN = "# >>> pr-daemon previews (rebuilt from the stacks table)";
const END = "# <<< pr-daemon previews";

/**
 * Every name a running stack answers on, from this container's point of view:
 * the hostnames in its own URL and in its declared service routes, plus the
 * public preview hosts when a domain is set.
 *
 * `localhost` and `127.0.0.1` themselves are left out, and only those two: the
 * container's own loopback is where the status page listens, and redirecting it
 * would break pr-daemon talking to itself. A *name under* localhost is a
 * different thing and belongs here — `app.localhost` is a stack on the host,
 * and `[preview] domain = "pr-daemon.localhost"` is the documented way to test
 * previews without a real domain. Pure: unit-tested.
 */
export function stackNames(cfg: Config, stacks: Stack[]): string[] {
  const names = new Set<string>();
  const add = (url: string): void => {
    try {
      const h = new URL(url).hostname;
      if (h && h !== "127.0.0.1" && h !== "localhost") names.add(h);
    } catch { /* not a URL */ }
  };
  const domain = cfg.preview.domain;
  if (domain && cfg.preview.proxy !== "off") names.add(`${CHECK_LABEL}.${domain}`);
  for (const s of stacks) {
    if (s.stopped_at) continue;
    add(s.url);
    const services = Object.keys(stackRoutes(s));
    for (const url of Object.values(stackRoutes(s))) add(url);
    if (!domain || cfg.preview.proxy === "off") continue;
    names.add(`${hostLabel(s.branch)}.${domain}`);
    for (const name of services) names.add(`${hostLabel(s.branch)}--${name}.${domain}`);
  }
  return [...names].sort();
}

/**
 * `existing` with pr-daemon's block replaced by one line per name. No names
 * means no block at all, so an empty stacks table leaves the file as it came.
 * Pure: unit-tested.
 */
export function hostsBlock(existing: string, names: string[], ip: string): string {
  // The markers are literal text, not a pattern: BEGIN has brackets in it.
  const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const without = existing.replace(new RegExp(`\\n*${quote(BEGIN)}[\\s\\S]*?${quote(END)}\\n*`), "\n");
  if (!names.length || !ip) return without;
  return `${without.replace(/\n+$/, "")}\n\n${BEGIN}\n${names.map((n) => `${ip} ${n}`).join("\n")}\n${END}\n`;
}

let warned = false;

/**
 * Keep the block equal to the stacks table. Does nothing outside a container.
 * Never throws: a /etc/hosts it may not write is a warning once, not a
 * failure, because everything else still works.
 */
export async function syncHosts(cfg: Config, stacks: Stack[]): Promise<void> {
  if (!LOCAL_HOST) return;
  const ip = await localHostIp();
  if (!ip) return;
  try {
    const before = readFileSync(HOSTS, "utf8");
    const after = hostsBlock(before, stackNames(cfg, stacks), ip);
    if (after !== before) writeFileSync(HOSTS, after);     // in place: a rename over a bind mount fails
  } catch (e) {
    if (warned) return;
    warned = true;
    log(`cannot keep the preview names in ${HOSTS} (${(e as Error).message}). Public preview URLs won't resolve inside the container.`);
  }
}
