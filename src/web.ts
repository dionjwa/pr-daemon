// The status page + a tiny JSON API, bound to localhost only.
// Writes need an `X-PR-Demon: 1` header: browsers won't send a custom header
// cross-site without a CORS preflight (which we never grant), so other web
// pages can't drive this one. The Host check blocks DNS-rebinding.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Daemon } from "./daemon.ts";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "ui.html");

function send(res: ServerResponse, code: number, body: unknown, type = "application/json"): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const chunk of req) { s += chunk; if (s.length > 1e6) throw new Error("body too large"); }
  return s ? JSON.parse(s) : {};
}

export function serve(d: Daemon): void {
  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return send(res, 403, { error: "localhost only" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = req.method ?? "GET";
      if (m !== "GET" && req.headers["x-pr-demon"] !== "1") return send(res, 403, { error: "missing X-PR-Demon header" });

      if (m === "GET" && url.pathname === "/") return send(res, 200, readFileSync(PAGE, "utf8"), "text/html; charset=utf-8");
      if (m === "GET" && url.pathname === "/api/status") return send(res, 200, d.status());
      if (m === "GET" && url.pathname === "/api/config") return send(res, 200, { text: d.configText() });
      if (m === "PUT" && url.pathname === "/api/config") {
        const { text } = await body(req);
        try { d.saveConfig(String(text ?? "")); return send(res, 200, { ok: true }); }
        catch (e) { return send(res, 400, { error: (e as Error).message }); }
      }
      if (m === "POST" && url.pathname === "/api/pause") { d.setPaused(Boolean((await body(req)).paused)); return send(res, 200, { ok: true }); }
      if (m === "POST" && url.pathname === "/api/poll") { void d.poll(); return send(res, 200, { ok: true }); }

      const job = /^\/api\/jobs\/(\d+)\/(cancel|resume|retry)$/.exec(url.pathname);
      if (m === "POST" && job) { d[job[2] as "cancel" | "resume" | "retry"](Number(job[1])); return send(res, 200, { ok: true }); }

      const st = /^\/api\/stacks\/(teardown|restart)$/.exec(url.pathname);
      if (m === "POST" && st) {
        const { repo, branch } = await body(req);
        if (st[1] === "teardown") d.teardownStack(String(repo), String(branch)); else d.restartStack(String(repo), String(branch));
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
  server.listen(d.cfg.port, "127.0.0.1", () => d.store.event(`status page: http://localhost:${d.cfg.port}`));
}
