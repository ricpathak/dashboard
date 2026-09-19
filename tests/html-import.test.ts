import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  open,
  readdir,
} from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { resolve, join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { zipSync, strToU8 } from "fflate";
import { expandFiles, defaultImportLimits } from "../src/import-files.ts";
import { normalize } from "../src/normalize.ts";
import { summary } from "../src/model.ts";

const jsonSummary = {
  files: [
    {
      fileId: "a",
      fileName: "a.spec.ts",
      tests: [
        {
          testId: "a",
          title: "A",
          path: ["Suite"],
          projectName: "Chromium",
          outcome: "expected",
          duration: 12,
          results: [{ attachments: [] }],
        },
      ],
    },
  ],
  stats: { total: 1 },
  startTime: 1700000000000,
};
const encoded = Buffer.from(
  zipSync({ "report.json": strToU8(JSON.stringify(jsonSummary)) }),
).toString("base64");
const html = `<!doctype html><title>Playwright Test Report</title><template id="playwrightReportBase64">data:application/zip;base64,${encoded}</template>`;
function source(name: string, body: string | Uint8Array, chunkSize = 1007) {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  let offset = 0;
  return {
    name,
    size: bytes.length,
    stream: () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (offset >= bytes.length) {
            c.close();
            return;
          }
          c.enqueue(bytes.subarray(offset, (offset += chunkSize)));
        },
      }),
  };
}

test("Playwright HTML template and legacy assignment survive chunk boundaries", async () => {
  for (const body of [
    html,
    `<script>window.playwrightReportBase64 = "data:application/zip;base64,${encoded}";</script>`,
    `<script id="playwrightReportBase64" type="application/zip">data:application/zip;base64,${encoded}</script>`,
  ]) {
    const files = await expandFiles([source("index.html", body, 13)]);
    const [r] = await normalize(files);
    assert.equal(r.source, "Playwright HTML");
    assert.equal(r.tests.length, 1);
    assert.equal(r.tests[0].project, "Chromium");
    assert.equal(r.tests[0].status, "passed");
  }
});

test("Custom HTML table imports visible rows without executing scripts or loading images", async () => {
  const [r] = await normalize(
    await expandFiles([
      source(
        "custom.html",
        '<script>throw new Error("must not execute");</script><table><tr><th>Test name</th><th>Status</th><th>Project</th></tr><tr><td>A &amp; B<img src="https://example.invalid/image.png"></td><td><b>PASS</b></td><td>Claims</td></tr><tr><td>C</td><td>FAIL</td><td>Claims</td></tr></table>',
      ),
    ]),
  );
  assert.equal(r.source, "Custom HTML");
  assert.equal(r.tests[0].name, "A & B");
  assert.equal(summary(r.tests).failed, 1);
});

test("Allure report ZIP resolves HTML shell with companion data and skips large attachments", async () => {
  const zip = zipSync(
    {
      "allure-report/index.html": strToU8(
        '<title>Allure Report</title><script src="app.js"></script>',
      ),
      "allure-report/data/test-cases/1.json": strToU8(
        JSON.stringify({
          uid: "1",
          name: "Claim",
          status: "passed",
          time: { duration: 4 },
          labels: [{ name: "project", value: "Claims" }],
        }),
      ),
      "allure-report/data/attachments/huge.json": new Uint8Array(
        60 * 1024 ** 2,
      ),
    },
    { level: 0 },
  );
  assert.ok(zip.length > 50 * 1024 ** 2);
  const [r] = await normalize(
    await expandFiles([source("allure.zip", zip, 64 * 1024)], {
      ...defaultImportLimits,
      maxMetadataBytes: 1024,
    }),
  );
  assert.equal(r.tests.length, 1);
  assert.equal(r.tests[0].project, "Claims");
  await assert.rejects(
    () =>
      normalize([{ name: "index.html", text: "<title>Allure Report</title>" }]),
    /whole report folder/,
  );
  await assert.rejects(
    () =>
      normalize([
        { name: "custom.html", text: "<h1>No data</h1>" },
        {
          name: "1-result.json",
          text: '{"uuid":"a","name":"Test","status":"passed"}',
        },
      ]),
    /custom.html/,
  );
});

test("Selected metadata limits are enforced independently from raw upload sizes", async () => {
  await assert.rejects(
    () =>
      expandFiles([source("index.html", html)], {
        ...defaultImportLimits,
        maxMetadataBytes: 10,
      }),
    /test data|report data/,
  );
  await assert.rejects(
    () =>
      expandFiles([source("index.html", html)], {
        ...defaultImportLimits,
        maxUploadBytes: 10,
      }),
    /Selected files exceed/,
  );
  const zip = zipSync(
    {
      "report.json": strToU8(
        JSON.stringify({ tests: [{ name: "A", status: "passed" }] }),
      ),
      "attachments/pic.png": new Uint8Array(2 * 1024 ** 2),
    },
    { level: 9 },
  );
  const input = await expandFiles([source("compressed.zip", zip)], {
    ...defaultImportLimits,
    maxMetadataBytes: 1024,
  });
  assert.equal(input.length, 1);
});

test(
  "Actual Playwright HTML and >60 MB multipart imports retain project counts and survive server restart",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(resolve(".tmp-html-"));
    let child: ChildProcess | undefined;
    let stderr = "";
    const base = "http://127.0.0.1:3201";
    async function start(upload = "128") {
      child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
        env: {
          ...process.env,
          PORT: "3201",
          DATA_DIR: join(dir, "db"),
          MAX_UPLOAD_MB: upload,
          MAX_METADATA_MB: "2",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr?.on("data", (d) => (stderr += d));
      await new Promise<void>((ok, no) => {
        const timer = setTimeout(
          () => no(Error("Server startup timeout: " + stderr)),
          10000,
        );
        child!.stdout!.on("data", (d) => {
          if (String(d).includes("Test Report Hub:")) {
            clearTimeout(timer);
            ok();
          }
        });
        child!.once("exit", (code) => {
          clearTimeout(timer);
          no(Error(`Server exited ${code}: ${stderr}`));
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
    try {
      await writeFile(
        join(dir, "playwright.config.ts"),
        `export default {testDir:'.', outputDir:${JSON.stringify(join(dir, "results"))}, testMatch:'sample.spec.ts', workers:1,retries:1,projects:[{name:'Chromium'},{name:'Firefox'}],reporter:[['html',{outputFolder:${JSON.stringify(join(dir, "html"))},open:'never'}]]};`,
      );
      await writeFile(
        join(dir, "sample.spec.ts"),
        `import {test,expect} from '@playwright/test'; test('pass',async()=>{expect(1).toBe(1)});test('expected failure',async()=>{test.fail();expect(1).toBe(2)});test('failure',async()=>{expect(1).toBe(2)});test('flaky',async({},info)=>{expect(info.retry).toBe(1)});test.skip('skip',async()=>{});`,
      );
      const run = spawnSync(
        process.execPath,
        [
          "node_modules/@playwright/test/cli.js",
          "test",
          "--config",
          join(dir, "playwright.config.ts"),
        ],
        { encoding: "utf8", env: { ...process.env, CI: "1" }, timeout: 60000 },
      );
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const report = await readFile(join(dir, "html", "index.html"), "utf8");
      const normalized = await normalize(
        await expandFiles([source("index.html", report)]),
      );
      const counts = summary(normalized[0].tests);
      assert.equal(counts.total, 10);
      assert.equal(counts.passed, 4);
      assert.equal(counts.failed, 2);
      assert.equal(counts.flaky, 2);
      assert.equal(counts.skipped, 2);
      assert.equal(counts.passRate, 75);
      assert.deepEqual(
        [...new Set(normalized[0].tests.map((t) => t.project))].sort(),
        ["Chromium", "Firefox"],
      );
      // A single HTML larger than 60 MB, with a large inline screenshot before the report.
      const large = join(dir, "large-report.html");
      const handle = await open(large, "w");
      await handle.write('<img src="data:image/png;base64,');
      for (let i = 0; i < 61; i++) await handle.write("A".repeat(1024 ** 2));
      await handle.write('">' + report);
      await handle.close();
      await start();
      const data = new FormData();
      data.append("files", await openAsBlob(large), "large-report.html");
      let response = await fetch(base + "/api/import", {
        method: "POST",
        body: data,
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).added, 1);
      const repeat = new FormData();
      repeat.append("files", new Blob([report]), "index.html");
      response = await fetch(base + "/api/import", {
        method: "POST",
        body: repeat,
      });
      assert.equal((await response.json()).duplicates, 1);
      // Malformed mixed batches never partially commit.
      const mixed = new FormData();
      mixed.append(
        "files",
        new Blob(['{"tests":[{"name":"new","status":"pass"}]}']),
        "new.json",
      );
      mixed.append(
        "files",
        new Blob(["<title>Allure Report</title>"]),
        "index.html",
      );
      response = await fetch(base + "/api/import", {
        method: "POST",
        body: mixed,
      });
      assert.equal(response.status, 400);
      await stop();
      await start();
      const saved = await (await fetch(base + "/api/runs")).json();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].tests.length, 10);
      // A metadata limit returns 413 rather than disconnecting the client.
      const hugeJson = new FormData();
      hugeJson.append(
        "files",
        new Blob([" ".repeat(3 * 1024 ** 2)]),
        "huge.json",
      );
      response = await fetch(base + "/api/import", {
        method: "POST",
        body: hugeJson,
      });
      assert.equal(response.status, 413);
      await stop();
      await start("1");
      const tooLarge = new FormData();
      tooLarge.append(
        "files",
        new Blob(["A".repeat(2 * 1024 ** 2)]),
        "large.html",
      );
      response = await fetch(base + "/api/import", {
        method: "POST",
        body: tooLarge,
      });
      assert.equal(response.status, 413, await response.clone().text());
    } finally {
      await stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
