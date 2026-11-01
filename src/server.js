// Zero-dependency HTTP server: static UI + three JSON endpoints.
// `node src/server.js` and open http://localhost:5177

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

import * as assets from "./assets.js";
import * as audit from "./audit.js";
import { run } from "./pipeline.js";
import { parseIntent } from "./agent.js";
import { DEFAULT_POLICY, DEMO_POLICY } from "./policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 5177);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _invalid: true }; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/assets" && req.method === "GET") {
      return json(res, 200, { meta: assets.meta(), assets: assets.all() });
    }
    if (url.pathname === "/api/audit" && req.method === "GET") {
      const rows = audit.readAll();
      return json(res, 200, { verify: audit.verify(), policy: DEFAULT_POLICY, rows: rows.slice(-50).reverse() });
    }
    if (url.pathname === "/api/parse" && req.method === "POST") {
      return json(res, 200, parseIntent((await body(req)).text));
    }
    if (url.pathname === "/api/intent" && req.method === "POST") {
      const b = await body(req);
      if (b._invalid) return json(res, 400, { error: "invalid JSON body" });
      if (!b.text) return json(res, 400, { error: "text is required" });
      const result = await run(b.text, { policy: { ...DEMO_POLICY, ...(b.policy ?? {}) }, live: Boolean(b.live) });
      return json(res, result.ok ? 200 : 422, result);
    }
    if (url.pathname === "/api/reset" && req.method === "POST") {
      audit.reset();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/refresh" && req.method === "POST") {
      return json(res, 200, await assets.refresh());
    }

    const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    if (file.includes("..")) return json(res, 400, { error: "bad path" });
    const buf = await readFile(join(PUBLIC, file));
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    return res.end(buf);
  } catch (err) {
    if (err.code === "ENOENT") return json(res, 404, { error: "not found" });
    return json(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`IntentGuard listening on http://localhost:${PORT}`);
  console.log(`assets: ${assets.all().length} (${assets.meta().source})`);
});
