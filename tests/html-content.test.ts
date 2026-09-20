import { test } from "node:test";
import assert from "node:assert/strict";
import { expandFiles, normalize } from "../src/normalize.ts";
async function parse(html: string) {
  return normalize(
    await expandFiles([
      {
        name: "execution.html",
        size: Buffer.byteLength(html),
        stream: () =>
          new ReadableStream({
            start(c) {
              for (let i = 0; i < html.length; i += 7)
                c.enqueue(new TextEncoder().encode(html.slice(i, i + 7)));
              c.close();
            },
          }),
      },
    ]),
  );
}
test("standalone cards preserve names and projects and exclude step outcomes", async () => {
  const [r] = await parse(
    '<html><div class="test-case" data-project="Payments"><h3 class="test-name">Checkout works</h3><div class="step"><span class="status">failed</span></div><span class="status">passed</span></div><li class="test" data-test-name="Refund" data-status="failed"></li></html>',
  );
  assert.equal(r.tests.length, 2);
  assert.equal(r.tests[0].name, "Checkout works");
  assert.equal(r.tests[0].project, "Payments");
  assert.equal(r.tests[0].status, "passed");
  assert.equal(r.tests[1].status, "failed");
  assert.match(r.warnings.join(), /Verify totals/);
});
test("JSON script IDs and JSON variable assignments work without executing scripts", async () => {
  for (const code of [
    '<script type="application/json" id="custom">{"results":[{"title":"Checkout","status":"passed"}]}</script>',
    '<script>const reportData = {"tests":[{"name":"Checkout","status":"passed"}]};</script>',
  ]) {
    const [r] = await parse(code);
    assert.equal(r.tests.length, 1);
    assert.equal(r.tests[0].name, "Checkout");
  }
  await assert.rejects(
    parse("<script>window.reportData = runDangerousCode();</script>"),
  );
});
test("nested test containers are not double counted and summary counts are not invented tests", async () => {
  const [r] = await parse(
    '<div class="test"><h2 class="test-name">Suite</h2><div class="test-case" data-test-name="Case" data-status="passed"></div></div>',
  );
  assert.equal(r.tests.length, 1);
  await assert.rejects(
    parse("<html><div>Total: 30 Passed: 29 Failed: 1</div></html>"),
    /Only summary counts/,
  );
  await assert.rejects(
    parse(
      '<div class="test-case" hidden data-test-name="template" data-status="passed"></div>',
    ),
  );
});
