import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
test("Node API imports, deduplicates, persists across restart, validates, and deletes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "report-hub-test-"));
  let child: ChildProcess | undefined;
  const base = "http://127.0.0.1:3199";
  async function start() {
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      env: { ...process.env, PORT: "3199", DATA_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error("Server startup timed out")),
        10000,
      );
      child!.stdout!.on("data", (d) => {
        if (String(d).includes("Test Report Hub:")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child!.once("exit", (code) => {
        clearTimeout(timeout);
        reject(Error(`Server exited: ${code}`));
      });
    });
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
  try {
    await start();
    assert.equal(
      (await (await fetch(base + "/api/health")).json()).mode,
      "server",
    );
    const files = await Promise.all(
      [
        "custom-report.json",
        "custom-report.csv",
        "playwright-report.json",
        "claim-result.json",
      ].map(async (name) => ({
        name,
        text: await readFile("examples/" + name, "utf8"),
      })),
    );
    const upload = () =>
      fetch(base + "/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
    let response = await upload();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).added, 4);
    response = await upload();
    assert.equal((await response.json()).duplicates, 4);
    await stop();
    await start();
    const runs = await (await fetch(base + "/api/runs")).json();
    assert.equal(runs.length, 4);
    assert.equal(
      runs.reduce((s: number, r: any) => s + r.tests.length, 0),
      9,
    );
    response = await fetch(base + "/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [{ name: "bad.json", text: "broken" }] }),
    });
    assert.equal(response.status, 400);
    response = await fetch(base + "/api/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: "{}",
    });
    assert.equal(response.status, 403);
    for (const r of runs) {
      response = await fetch(base + "/api/runs/" + r.id, { method: "DELETE" });
      assert.equal(response.status, 200);
    }
    assert.equal((await (await fetch(base + "/api/runs")).json()).length, 0);
    assert.equal((await fetch(base + "/")).status, 200);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
