import type { Run, Status } from "./model";
export function demoRuns(): Run[] {
  const names = [
    "Create a new application",
    "Validate mandatory fields",
    "Retrieve customer profile",
    "Calculate premium",
    "Submit underwriting decision",
    "Upload supporting documents",
    "Match applicant identity",
    "Review policy exclusions",
    "Approve standard risk",
    "Decline invalid application",
    "Check payment details",
    "Generate policy document",
  ];
  return [
    ["Underwriting", "Playwright", 42, 3, 2, 1],
    ["Claims", "Allure", 31, 2, 1, 2],
    ["Customer portal", "Custom JSON", 26, 1, 0, 1],
  ].map((v, k) => {
    const [project, source, passed, failed, flaky, skipped] = v as [
      string,
      string,
      number,
      number,
      number,
      number,
    ];
    const statuses: Status[] = [
      ...Array(passed).fill("passed"),
      ...Array(failed).fill("failed"),
      ...Array(flaky).fill("flaky"),
      ...Array(skipped).fill("skipped"),
    ];
    return {
      id: `demo-${k}`,
      fingerprint: `demo-${k}`,
      name: `${project} · regression`,
      source,
      importedAt: new Date().toISOString(),
      startedAt: new Date(Date.now() - k * 3600000).toISOString(),
      files: ["Sample data"],
      warnings: [],
      tests: statuses.map((status, i) => ({
        id: `demo-${k}-${i}`,
        name:
          names[i % names.length] +
          (i >= names.length
            ? ` · variant ${Math.floor(i / names.length) + 1}`
            : ""),
        project,
        suite: i % 2 ? "API validation" : "End-to-end",
        status,
        rawStatus: status,
        durationMs: 1200 + ((i * 347) % 25000),
        attempts: status === "flaky" ? 2 : 1,
        error:
          status === "failed"
            ? "Expected response status 200, received 422.\nAssertion failed at tests/application.spec.ts:42"
            : status === "flaky"
              ? "First attempt: Timeout waiting for confirmation. Retry passed."
              : "",
        file: `tests/${project.toLowerCase().replace(/ /g, "-")}.spec.ts`,
      })),
    };
  });
}
