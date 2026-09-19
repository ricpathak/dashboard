import { multipartReports, importLimits, validateOptions } from "./uploads.ts";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "../src/normalize.ts";
import type { Run } from "../src/model.ts";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = resolve(process.env.DATA_DIR || resolve(root, "data"));
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(resolve(dataDir, "reports.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)",
);
const insert = db.prepare("INSERT OR IGNORE INTO runs VALUES (?, ?, ?)");
const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || "127.0.0.1";
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  const send = (code: number, data: unknown) => {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  try {
    const url = new URL(req.url || "/", "http://localhost");
    // Reject cross-origin requests, including localhost DNS-rebinding hosts.
    const allowedHosts = new Set(
      [
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        process.env.ALLOWED_HOST,
      ].filter(Boolean),
    );
    if (!allowedHosts.has(req.headers.host)) {
      send(403, {
        error:
          "Host not allowed. Set ALLOWED_HOST for a trusted reverse proxy.",
      });
      return;
    }
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}` &&
      req.headers.origin !== `https://${req.headers.host}`
    ) {
      send(403, { error: "Cross-origin requests are disabled." });
      return;
    }
    if (url.pathname === "/api/health") {
      send(200, { mode: "server", storage: "sqlite", importLimits });
      return;
    }
    if (url.pathname === "/api/runs" && req.method === "GET") {
      send(
        200,
        db
          .prepare("SELECT payload FROM runs ORDER BY rowid DESC")
          .all()
          .map((r) => JSON.parse(String(r.payload))),
      );
      return;
    }
    if (url.pathname === "/api/import" && req.method === "POST") {
      let body;
      if (req.headers["content-type"]?.startsWith("multipart/form-data")) {
        body = await multipartReports(req);
      } else if (req.headers["content-type"]?.startsWith("application/json")) {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > importLimits.maxMetadataBytes) {
            send(413, {
              error:
                "JSON request exceeds MAX_METADATA_MB. Use multipart/form-data for large HTML or ZIP files.",
            });
            return;
          }
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !Array.isArray(body.files) ||
          body.files.length > importLimits.maxFiles ||
          body.files.some(
            (f: any) =>
              typeof f?.name !== "string" || typeof f?.text !== "string",
          )
        )
          throw Error("files must contain {name,text} records.");
        body.options = validateOptions(body.options);
      } else {
        send(415, { error: "Use multipart/form-data or application/json." });
        return;
      }
      const parsed = await normalize(body.files, body.options);
      let added = 0;
      db.exec("BEGIN");
      try {
        for (const r of parsed) {
          const run: Run = {
            ...r,
            id: crypto.randomUUID(),
            importedAt: new Date().toISOString(),
          };
          added += Number(
            insert.run(run.id, run.fingerprint, JSON.stringify(run)).changes,
          );
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      send(200, { added, duplicates: parsed.length - added });
      return;
    }
    if (url.pathname.startsWith("/api/runs/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice(10));
      const result = db.prepare("DELETE FROM runs WHERE id=?").run(id);
      send(result.changes ? 200 : 404, { deleted: !!result.changes });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      send(404, { error: "API route not found." });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(405, { error: "Method not allowed." });
      return;
    }
    const dist = resolve(root, "dist");
    const requested = resolve(dist, "." + decodeURIComponent(url.pathname));
    if (!requested.startsWith(dist + sep) && requested !== dist) {
      send(403, { error: "Invalid path." });
      return;
    }
    const file = url.pathname === "/" ? resolve(dist, "index.html") : requested;
    if (!existsSync(file)) {
      send(404, { error: "Not found. Run npm run build first." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  } catch (e) {
    if (!res.headersSent)
      send((e as { statusCode?: number })?.statusCode || 400, {
        error: e instanceof Error ? e.message : "Invalid request",
      });
    else res.end();
  }
});
server.requestTimeout = 0; // Large local uploads may take longer than Node's five-minute default.
server.listen(port, host, () =>
  console.log(`Test Report Hub: http://${host}:${port} (SQLite: ${dataDir})`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
