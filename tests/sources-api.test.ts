import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
test("source API scans dropped files, publishes provenance, and persists observations after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "source-api-"));
  const inbox = join(dir, "inbox");
  await mkdir(inbox);
  const config = join(dir, "sources.json");
  await writeFile(
    config,
    JSON.stringify({
      sources: [
        {
          id: "inbox",
          label: "Inbox",
          type: "folder",
          path: inbox,
          pollSeconds: 0,
          settleSeconds: 0,
        },
      ],
    }),
  );
  let child: ChildProcess | undefined;
  const base = "http://127.0.0.1:3202";
  async function start() {
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      env: {
        ...process.env,
        PORT: "3202",
        DATA_DIR: dir,
        SOURCES_CONFIG: config,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Startup timeout")), 10000);
      child!.stdout!.on("data", (d) => {
        if (String(d).includes("Test Report Hub:")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child!.once("exit", () => {
        clearTimeout(timer);
        reject(Error("Server exited"));
      });
    });
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const done = once(child, "exit");
      child.kill("SIGTERM");
      await done;
    }
  }
  async function idle() {
    for (let i = 0; i < 100; i++) {
      const source = (await (await fetch(base + "/api/sources")).json())[0];
      if (!source.scanning) return source;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("Scan timed out");
  }
  try {
    await start();
    await idle();
    await writeFile(
      join(inbox, "run.json"),
      JSON.stringify({ tests: [{ name: "A", status: "passed" }] }),
    );
    assert.equal(
      (await fetch(base + "/api/sources/inbox/scan", { method: "POST" }))
        .status,
      202,
    );
    assert.equal((await idle()).added, 1);
    let runs = await (await fetch(base + "/api/runs")).json();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].sourceLabel, "Inbox");
    assert.equal(runs[0].sourceItem, "run.json");
    assert.equal(
      (await fetch(base + "/api/sources/missing/scan", { method: "POST" }))
        .status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/api/sources/inbox/scan", {
          method: "POST",
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    await stop();
    await start();
    const status = await idle();
    assert.equal(status.unchanged, 1);
    runs = await (await fetch(base + "/api/runs")).json();
    assert.equal(runs.length, 1);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
