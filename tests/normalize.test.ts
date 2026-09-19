import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, parseCsv, expandFiles } from "../src/normalize.ts";
import { summary } from "../src/model.ts";
import { zipSync, strToU8 } from "fflate";
const file = (data: unknown, name = "report.json") => ({
  name,
  text: JSON.stringify(data),
});
test("Playwright: nested projects, retries, expected failure, unexpected pass, skips and no results", async () => {
  const tests = [
    {
      projectName: "chromium",
      status: "flaky",
      results: [
        { status: "failed", duration: 4 },
        { status: "passed", duration: 6 },
      ],
    },
    {
      projectName: "firefox",
      status: "expected",
      expectedStatus: "failed",
      results: [{ status: "failed", duration: 5 }],
    },
    {
      projectName: "webkit",
      status: "unexpected",
      expectedStatus: "failed",
      results: [{ status: "passed", duration: 2 }],
    },
    { status: "skipped", results: [{ status: "skipped" }] },
    { results: [] },
  ];
  const [r] = await normalize([
    file({
      suites: [
        {
          title: "outer",
          suites: [{ title: "inner", specs: [{ title: "test", tests }] }],
        },
      ],
    }),
  ]);
  assert.deepEqual(
    r.tests.map((t) => t.status),
    ["flaky", "passed", "failed", "skipped", "unknown"],
  );
  assert.equal(r.tests[0].durationMs, 10);
  assert.equal(r.tests[0].attempts, 2);
  assert.equal(r.tests[0].project, "chromium");
  assert.equal(r.tests[0].suite, "outer › inner");
  assert.equal(summary(r.tests).executed, 3);
  assert.equal(summary(r.tests).passRate, 66.7);
});
test("Allure collapses retries only within project and historyId; latest result wins", async () => {
  const result = (
    uuid: string,
    status: string,
    start: number,
    project = "API",
  ) =>
    file(
      {
        uuid,
        historyId: "same",
        name: "Request",
        status,
        start,
        stop: start + 10,
        labels: [{ name: "project", value: project }],
      },
      `${uuid}-result.json`,
    );
  const [r] = await normalize([
    result("2", "passed", 20),
    result("1", "failed", 1),
    result("3", "broken", 30, "UI"),
  ]);
  assert.equal(r.tests.length, 2);
  assert.equal(r.tests[0].status, "flaky");
  assert.equal(r.tests[0].attempts, 2);
  assert.equal(r.tests[1].status, "broken");
});
test("Custom mapping, seconds and unknown status preserve rows", async () => {
  const [r] = await normalize(
    [
      file({
        payload: {
          cases: [
            { title: "one", result: { outcome: "PASS" }, elapsed: 2 },
            { title: "two", result: { outcome: "new" }, elapsed: 0 },
          ],
        },
      }),
    ],
    {
      project: "Claims",
      mapping: {
        root: "payload.cases",
        name: "title",
        status: "result.outcome",
        duration: "elapsed",
        durationUnit: "s",
      },
    },
  );
  assert.equal(r.tests[0].durationMs, 2000);
  assert.equal(r.tests[0].project, "Claims");
  assert.equal(r.tests[1].status, "unknown");
  assert.equal(summary(r.tests).executed, 1);
});
test("CSV handles escaped quotes, multiline values and CRLF", () => {
  assert.deepEqual(
    parseCsv('name,status,error\r\n"A, B",fail,"line 1\n""quote"""\r\n'),
    [{ name: "A, B", status: "fail", error: 'line 1\n"quote"' }],
  );
  assert.throws(() => parseCsv("name,status\na,pass,extra"));
});
test("Identical contents imported under another file name keep fingerprint", async () => {
  const data = { tests: [{ name: "one", status: "pass" }] };
  const [a] = await normalize([file(data, "a.json")]);
  const [b] = await normalize([file(data, "b.json")]);
  assert.equal(a.fingerprint, b.fingerprint);
});
test("ZIP extracts report files and ignores attachments", async () => {
  const zip = zipSync({
    "report.json": strToU8('{"tests":[{"name":"A","status":"pass"}]}'),
    "attachments/test.json": strToU8("{}"),
  });
  const files = await expandFiles([
    { name: "run.zip", arrayBuffer: async () => zip.buffer as ArrayBuffer },
  ]);
  assert.equal(files.length, 1);
  const [r] = await normalize(files);
  assert.equal(r.tests[0].status, "passed");
});
test("Import is rejected for malformed reports and HTML with actionable errors", async () => {
  await assert.rejects(
    () => normalize([{ name: "report.html", text: "<html/>" }]),
    /JSON/,
  );
  await assert.rejects(
    () => normalize([file({ hello: "world" })]),
    /Custom report/,
  );
  await assert.rejects(
    () => normalize([file({ tests: [{ name: "A" }] })]),
    /status/,
  );
});
