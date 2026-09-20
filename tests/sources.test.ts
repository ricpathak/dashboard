import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SourceManager } from "../server/sources/manager.ts";
import {
  folderReader,
  graphReader,
  restReader,
} from "../server/sources/readers.ts";
import { discover } from "../server/sources/discovery.ts";
import { defaultImportLimits } from "../src/import-files.ts";
import type { SourceConfig, SourceEntry } from "../server/sources/types.ts";
const report = JSON.stringify({
  tests: [{ name: "checkout", status: "passed", project: "Shop" }],
});
const config = (path: string): SourceConfig => ({
  id: "local",
  label: "Local",
  type: "folder",
  path,
  settleSeconds: 0,
  pollSeconds: 0,
});
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE runs(id TEXT PRIMARY KEY,fingerprint TEXT UNIQUE,payload TEXT)",
  );
  return db;
}
test("folder imports, isolates errors, groups Allure, ignores symlinks, preserves history and deduplicates after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sources-"));
  const db = database();
  let manager = new SourceManager(db, [config(dir)], defaultImportLimits);
  try {
    await mkdir(join(dir, "build1"));
    await writeFile(join(dir, "build1", "report.json"), report);
    await writeFile(join(dir, "bad.html"), "<html>unknown reporter</html>");
    await symlink(join(dir, "build1"), join(dir, "link"), "junction");
    await mkdir(join(dir, "allure", "data", "test-cases"), { recursive: true });
    await writeFile(
      join(dir, "allure", "index.html"),
      '<html><script src="app.js"></script></html>',
    );
    await writeFile(
      join(dir, "allure", "data", "test-cases", "1.json"),
      JSON.stringify({
        uid: "1",
        name: "allure case",
        status: "failed",
        time: { start: 1, stop: 2 },
        labels: [],
      }),
    );
    await manager.scan("local");
    assert.equal(db.prepare("SELECT * FROM runs").all().length, 2);
    assert.ok(
      manager
        .statuses()[0]
        .items.some((i: any) => i.key === "bad.html" && i.status === "error"),
    );
    await manager.stop();
    manager = new SourceManager(db, [config(dir)], defaultImportLimits);
    await manager.scan("local");
    assert.equal(db.prepare("SELECT * FROM runs").all().length, 2);
    await utimes(
      join(dir, "build1", "report.json"),
      new Date(),
      new Date(Date.now() + 1000),
    );
    await manager.scan("local");
    assert.equal(db.prepare("SELECT * FROM runs").all().length, 2);
    await mkdir(join(dir, "build2"));
    await writeFile(join(dir, "build2", "report.json"), report);
    await manager.scan("local");
    assert.equal(db.prepare("SELECT * FROM runs").all().length, 3);
    await writeFile(
      join(dir, "build1", "report.json"),
      report.replace("passed", "failed"),
    );
    await manager.scan("local");
    assert.equal(db.prepare("SELECT * FROM runs").all().length, 4);
  } finally {
    await manager.stop();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("settling, completion markers and changes during parsing prevent partial imports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settle-"));
  const db = database();
  try {
    await writeFile(join(dir, "report.json"), report);
    const c = { ...config(dir), settleSeconds: 30 };
    let m = new SourceManager(db, [c], defaultImportLimits);
    await m.scan("local");
    assert.equal(m.statuses()[0].pending, 1);
    db.prepare("UPDATE source_items SET observed_at=?").run(Date.now() - 31000);
    await m.scan("local");
    assert.equal(db.prepare("SELECT * FROM runs").all().length, 1);
    await m.stop();
    db.exec("DELETE FROM runs;DELETE FROM source_items");
    c.completionMarker = ".complete";
    m = new SourceManager(db, [c], defaultImportLimits);
    await m.scan("local");
    assert.equal(m.statuses()[0].pending, 1);
    await writeFile(join(dir, ".complete"), "");
    await m.scan("local");
    assert.equal(db.prepare("SELECT * FROM runs").all().length, 1);
    await m.stop();
    db.exec("DELETE FROM runs;DELETE FROM source_items");
    m = new SourceManager(db, [c], defaultImportLimits, (s) => ({
      ...folderReader(s),
      unchanged: async () => false,
    }));
    await m.scan("local");
    assert.equal(db.prepare("SELECT * FROM runs").all().length, 0);
    assert.match(String(m.statuses()[0].items[0].error), /changed/);
    await m.stop();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("Allure bundles stay separate across builds and include globs retain companions", () => {
  const names = [
    "A/1/index.html",
    "A/1/data/test-cases/a.json",
    "A/1/data/test-cases/b.json",
    "B/2/a-result.json",
    "B/2/b-result.json",
    "ignored.json",
  ];
  const entries = names.map((name) => ({
    name,
    version: "1",
    size: 1,
    modifiedAt: 0,
    locator: name,
  }));
  const bundles = discover(entries, {
    ...config("."),
    include: ["**/index.html", "**/*-result.json"],
    projectFromFolder: true,
  });
  assert.equal(bundles.length, 2);
  assert.equal(bundles[0].files.length, 3);
  assert.equal(bundles[0].options.project, "A");
  assert.equal(bundles[1].files.length, 2);
});
test("Graph pagination, redirect downloads and version checks do not forward tokens to storage", async () => {
  process.env.TEST_GRAPH_TOKEN = "private-token";
  const calls: { url: string; init?: RequestInit }[] = [];
  const entry = {
    id: "f",
    name: "report.json",
    file: {},
    size: report.length,
    eTag: '"v1"',
    lastModifiedDateTime: "2026-01-01",
    webUrl: "https://tenant.sharepoint.com/report.json",
  };
  const runtime = {
    fetch: (async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/content"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://storage.example/report" },
        });
      if (url.startsWith("https://storage.example"))
        return new Response(report);
      if (url.includes("page=2")) return Response.json({ value: [entry] });
      if (url.includes("/children"))
        return Response.json({
          value: [],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/page=2",
        });
      return Response.json(entry);
    }) as typeof fetch,
  };
  const r = graphReader(
    {
      id: "g",
      label: "Graph",
      type: "sharepoint-online",
      driveId: "drive",
      folderId: "folder",
      accessTokenEnv: "TEST_GRAPH_TOKEN",
    },
    runtime,
  );
  const files = await r.list();
  assert.equal(files.length, 1);
  assert.equal(await new Response(await r.open(files[0])).text(), report);
  assert.equal(
    calls.find((c) => c.url.startsWith("https://storage.example"))?.init
      ?.headers,
    undefined,
  );
  assert.equal(await r.unchanged(files), true);
  delete process.env.TEST_GRAPH_TOKEN;
});
test("Graph rejects untrusted pagination and does not expose authentication response bodies", async () => {
  process.env.TEST_GRAPH_TOKEN = "private-token";
  const s: SourceConfig = {
    id: "g",
    label: "Graph",
    type: "sharepoint-online",
    driveId: "d",
    folderId: "f",
    accessTokenEnv: "TEST_GRAPH_TOKEN",
  };
  const r = graphReader(s, {
    fetch: (async () =>
      Response.json({
        value: [],
        "@odata.nextLink": "https://evil.example/page",
      })) as typeof fetch,
  });
  await assert.rejects(r.list(), /unexpected URL/);
  const denied = graphReader(s, {
    fetch: (async () =>
      new Response("secret response", { status: 403 })) as typeof fetch,
  });
  await assert.rejects(
    denied.list(),
    (e) => /HTTP 403/.test(String(e)) && !String(e).includes("secret response"),
  );
  delete process.env.TEST_GRAPH_TOKEN;
});
test("SharePoint REST reads bearer-authenticated folders and validates versions", async () => {
  process.env.TEST_REST_TOKEN = "rest-token";
  const c: SourceConfig = {
    id: "r",
    label: "REST",
    type: "sharepoint-rest",
    siteUrl: "https://sp.example/sites/qa",
    folderServerRelativeUrl: "/sites/qa/Reports team's",
    accessTokenEnv: "TEST_REST_TOKEN",
  };
  const d = {
    Name: "report.json",
    ServerRelativeUrl: "/sites/qa/Reports/report.json",
    Length: report.length,
    TimeLastModified: "2026-01-01",
    ETag: '"1"',
  };
  let quoted = false;
  const r = restReader(c, {
    fetch: (async (input: any, init?: RequestInit) => {
      const url = String(input);
      assert.equal((init?.headers as any).Authorization, "Bearer rest-token");
      if (url.includes("team%27%27s")) quoted = true;
      if (url.includes("/Files?")) return Response.json({ value: [d] });
      if (url.includes("/Folders?")) return Response.json({ value: [] });
      if (url.endsWith("/$value")) return new Response(report);
      return Response.json(d);
    }) as typeof fetch,
  });
  const files = await r.list();
  assert.ok(quoted);
  assert.equal(files.length, 1);
  assert.equal(await new Response(await r.open(files[0])).text(), report);
  assert.equal(await r.unchanged(files), true);
  delete process.env.TEST_REST_TOKEN;
});

test("Graph client credentials reuse token and traverse project folders", async () => {
  process.env.TEST_TENANT = "tenant";
  process.env.TEST_CLIENT = "client";
  process.env.TEST_SECRET = "secret";
  let tokens = 0;
  const reader = graphReader(
    {
      id: "g",
      label: "g",
      type: "sharepoint-online",
      driveId: "d",
      folderId: "root",
      tenantIdEnv: "TEST_TENANT",
      clientIdEnv: "TEST_CLIENT",
      clientSecretEnv: "TEST_SECRET",
    },
    {
      fetch: (async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("login.microsoftonline.com")) {
          tokens++;
          assert.equal(
            (init?.body as URLSearchParams).get("grant_type"),
            "client_credentials",
          );
          return Response.json({
            access_token: "test-token",
            expires_in: 3600,
          });
        }
        assert.equal((init?.headers as any).Authorization, "Bearer test-token");
        return Response.json({
          value: url.includes("/root/")
            ? [{ id: "project", name: "Payments", folder: {} }]
            : [
                {
                  id: "f",
                  name: "index.html",
                  file: {},
                  size: 10,
                  eTag: '"1"',
                },
              ],
        });
      }) as typeof fetch,
    },
  );
  try {
    assert.equal((await reader.list())[0].name, "Payments/index.html");
    await reader.list();
    assert.equal(tokens, 1);
  } finally {
    delete process.env.TEST_TENANT;
    delete process.env.TEST_CLIENT;
    delete process.env.TEST_SECRET;
  }
});
