import { newId, fingerprint } from "./identity";
import { unzipSync } from "fflate";
import type {
  InputFile,
  ImportOptions,
  Mapping,
  Run,
  Status,
  TestCase,
} from "./model";
type Obj = Record<string, any>;
const obj = (v: any): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: any) => (v == null ? "" : String(v));
const num = (v: any) =>
  Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0;
const arr = (v: any): any[] => (Array.isArray(v) ? v : []);
const get = (o: any, path: string | undefined) =>
  path
    ? path
        .split(".")
        .reduce(
          (v, k) => (v != null && Object.hasOwn(v, k) ? v[k] : undefined),
          o,
        )
    : undefined;
export function statusOf(s: any): Status {
  const v = str(s).toLowerCase().replace(/[ _-]/g, "");
  return (
    (
      {
        pass: "passed",
        passed: "passed",
        success: "passed",
        ok: "passed",
        fail: "failed",
        failed: "failed",
        failure: "failed",
        timedout: "failed",
        timeout: "failed",
        flaky: "flaky",
        skip: "skipped",
        skipped: "skipped",
        pending: "skipped",
        disabled: "skipped",
        broken: "broken",
        error: "broken",
        interrupted: "interrupted",
        cancelled: "interrupted",
        canceled: "interrupted",
        unknown: "unknown",
      } as Record<string, Status>
    )[v] ?? "unknown"
  );
}
function base(v: Partial<TestCase>): TestCase {
  return {
    id: newId(),
    name: "Unnamed test",
    project: "Default",
    suite: "",
    status: "unknown",
    rawStatus: "unknown",
    durationMs: 0,
    attempts: 1,
    error: "",
    file: "",
    ...v,
  };
}
function err(v: any): string {
  if (typeof v === "string") return v;
  return str(v?.message || v?.stack || v?.trace);
}
export function parseCsv(text: string): Obj[] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw Error("Unclosed quote in CSV.");
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const headers = rows.shift()?.map((h) => h.trim()) ?? [];
  if (
    !headers.length ||
    new Set(headers).size !== headers.length ||
    headers.some((h) => !h)
  )
    throw Error("CSV needs unique, non-empty column headers.");
  return rows.map((r, i) => {
    if (r.length !== headers.length)
      throw Error(
        `CSV row ${i + 2} has ${r.length} columns; expected ${headers.length}.`,
      );
    return Object.fromEntries(headers.map((h, j) => [h, r[j]]));
  });
}
function playwright(data: Obj, options: ImportOptions): TestCase[] {
  const out: TestCase[] = [];
  function walk(s: Obj, path: string[]) {
    const next = [...path, str(s.title)].filter(Boolean);
    for (const spec of arr(s.specs)) {
      for (const t of arr(spec.tests)) {
        const results = arr(t.results);
        const last = results.at(-1);
        const raw = str(last?.status || "unknown");
        let status: Status;
        if (t.status === "skipped" || raw === "skipped") status = "skipped";
        else if (!last) status = "unknown";
        else if (t.status === "flaky") status = "flaky";
        else if (t.status === "unexpected")
          status = raw === "interrupted" ? "interrupted" : "failed";
        else if (t.status === "expected") status = "passed";
        else status = statusOf(raw);
        out.push(
          base({
            name: str(spec.title),
            project:
              options.project?.trim() ||
              str(t.projectName || t.projectId) ||
              "Default",
            suite: next.join(" › "),
            file: str(spec.file || s.file),
            status,
            rawStatus: raw,
            expectedStatus: str(t.expectedStatus || "passed"),
            durationMs: results.reduce((s, r) => s + num(r.duration), 0),
            attempts: results.length,
            error: results
              .map((r) => err(r.error) || arr(r.errors).map(err).join("\n"))
              .filter(Boolean)
              .join("\n\n"),
          }),
        );
      }
    }
    for (const child of arr(s.suites)) walk(child, next);
  }
  for (const s of arr(data.suites)) walk(s, []);
  return out;
}
function custom(data: any, m: Mapping = {}, project?: string): TestCase[] {
  const records = m.root
    ? get(data, m.root)
    : Array.isArray(data)
      ? data
      : (data.tests ?? data.testCases ?? data.results);
  if (!Array.isArray(records))
    throw Error(
      "Custom report must be an array, or contain tests/results/testCases. Set the array path for another schema.",
    );
  return records.map((r, i) => {
    if (!obj(r)) throw Error(`Test row ${i + 1} must be an object.`);
    const name = get(r, m.name || "name") ?? r.title ?? r.testName;
    const raw = get(r, m.status || "status") ?? r.result;
    if (!str(name).trim() || raw == null)
      throw Error(
        `Test row ${i + 1} needs a name and status. Check custom field mapping.`,
      );
    return base({
      name: str(name),
      status: statusOf(raw),
      rawStatus: str(raw),
      project:
        project?.trim() ||
        str(get(r, m.project || "project") || data.project) ||
        "Default",
      suite: str(get(r, m.suite || "suite")),
      durationMs:
        num(get(r, m.duration || "durationMs") ?? r.duration) *
        (m.durationUnit === "s" ? 1000 : 1),
      attempts: Math.max(1, num(r.attempts) || 1),
      error: err(get(r, m.error || "error")),
      file: str(r.file),
    });
  });
}
function allure(records: Obj[], options: ImportOptions): TestCase[] {
  const groups = new Map<string, Obj[]>();
  for (const r of records) {
    const labels = arr(r.labels);
    const label = (n: string) => str(labels.find((l) => l.name === n)?.value);
    const project =
      options.project?.trim() ||
      label("project") ||
      label("parentSuite") ||
      "Allure";
    const key = JSON.stringify([
      project,
      r.historyId || r.uuid || r.uid || newId(),
    ]);
    const group = groups.get(key) || [];
    group.push({ ...r, _project: project });
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    group.sort(
      (a, b) => num(a.start ?? a.time?.start) - num(b.start ?? b.time?.start),
    );
    const r = group.at(-1)!;
    const label = (n: string) =>
      str(arr(r.labels).find((l) => l.name === n)?.value);
    let status = statusOf(r.status);
    if (
      status === "passed" &&
      (group
        .slice(0, -1)
        .some((v) => ["failed", "broken"].includes(v.status)) ||
        r.statusDetails?.flaky)
    )
      status = "flaky";
    return base({
      name: str(r.name || r.fullName),
      project: r._project,
      suite: [label("suite"), label("subSuite")].filter(Boolean).join(" › "),
      status,
      rawStatus: str(r.status),
      durationMs: group.reduce(
        (s, r) => s + num(r.time?.duration ?? num(r.stop) - num(r.start)),
        0,
      ),
      attempts: group.length,
      error: group
        .map((v) => err(v.statusDetails) || str(v.statusMessage))
        .filter(Boolean)
        .join("\n\n"),
      file: str(r.fullName),
    });
  });
}
export async function expandFiles(
  files: { name: string; arrayBuffer: () => Promise<ArrayBuffer> }[],
): Promise<InputFile[]> {
  const output: InputFile[] = [];
  let bytes = 0;
  let expandedBytes = 0;
  const max = 50 * 1024 * 1024;
  for (const file of files) {
    const b = new Uint8Array(await file.arrayBuffer());
    bytes += b.length;
    if (bytes > max)
      throw Error("Import exceeds 50 MB. Split the report batch.");
    if (/\.zip$/i.test(file.name)) {
      const entries = unzipSync(b, {
        filter: (e) => {
          expandedBytes += e.originalSize;
          if (expandedBytes > max) throw Error("Expanded ZIP exceeds 50 MB.");
          return (
            /\.(json|csv)$/i.test(e.name) &&
            !/(^|\/)(history|widgets|attachments)\//.test(e.name)
          );
        },
      });
      for (const [name, data] of Object.entries(entries)) {
        output.push({ name, text: new TextDecoder().decode(data) });
      }
    } else {
      expandedBytes += b.length;
      if (expandedBytes > max) throw Error("Expanded import exceeds 50 MB.");
      output.push({ name: file.name, text: new TextDecoder().decode(b) });
    }
    if (output.length > 10000)
      throw Error("Maximum 10,000 report files per import.");
  }
  return output;
}
export async function normalize(
  files: InputFile[],
  options: ImportOptions = {},
): Promise<Omit<Run, "id" | "importedAt">[]> {
  if (!files.length) throw Error("Select at least one report.");
  const reports: {
    name: string;
    source: string;
    tests: TestCase[];
    files: InputFile[];
    warnings: string[];
    startedAt: string;
  }[] = [];
  const allures: { file: InputFile; data: Obj }[] = [];
  const ignored: string[] = [];
  for (const file of files) {
    if (
      /-(container|attachment)\.json$/.test(file.name) ||
      /(^|\/)(categories|executor|environment)\.json$/.test(file.name)
    ) {
      ignored.push(file.name);
      continue;
    }
    if (/\.html?$/i.test(file.name))
      throw Error(
        "HTML is a presentation format. Import Playwright JSON, allure-results/*-result.json, or Allure 2 data/test-cases JSON instead.",
      );
    let data: any;
    try {
      data = /\.csv$/i.test(file.name)
        ? parseCsv(file.text)
        : JSON.parse(file.text.replace(/^\uFEFF/, ""));
    } catch (e) {
      throw Error(
        `${file.name}: ${e instanceof Error ? e.message : "Invalid report"}`,
      );
    }
    if (
      obj(data) &&
      (data.uuid || data.uid) &&
      data.name &&
      "status" in data &&
      !Array.isArray(data.tests)
    ) {
      allures.push({ file, data });
      continue;
    }
    if (obj(data) && Array.isArray(data.suites)) {
      reports.push({
        name: file.name,
        source: "Playwright",
        tests: playwright(data, options),
        files: [file],
        warnings: arr(data.errors).map(err).filter(Boolean),
        startedAt: str(data.stats?.startTime),
      });
      continue;
    }
    // Generated Allure report ZIP contains metadata; only data/test-cases are authoritative.
    if (
      /(^|\/)(data\/)?(suites|behaviors|packages|timeline|categories|summary|history-trend|duration-trend|retry-trend|status-chart)\.json$/.test(
        file.name,
      )
    ) {
      ignored.push(file.name);
      continue;
    }
    try {
      reports.push({
        name: file.name,
        source: /\.csv$/i.test(file.name) ? "Custom CSV" : "Custom JSON",
        tests: custom(data, options.mapping, options.project),
        files: [file],
        warnings: [],
        startedAt: str(data.startedAt),
      });
    } catch (e) {
      throw Error(`${file.name}: ${(e as Error).message}`);
    }
  }
  if (allures.length)
    reports.push({
      name: "Allure execution",
      source: "Allure",
      tests: allure(
        allures.map((x) => x.data),
        options,
      ),
      files: allures.map((x) => x.file),
      warnings: [
        "Allure files in this import are treated as one execution. Import different executions separately.",
      ],
      startedAt: (() => {
        const times = allures
          .map((x) => num(x.data.start ?? x.data.time?.start))
          .filter(Boolean);
        return times.length ? new Date(Math.min(...times)).toISOString() : "";
      })(),
    });
  if (!reports.length)
    throw Error(
      "No supported test records found. Import Allure result files, Playwright JSON or custom JSON/CSV.",
    );
  return Promise.all(
    reports.map(async (r) => {
      if (!r.tests.length) r.warnings.push("This report contains no tests.");
      const unknown = r.tests.filter((t) => t.status === "unknown").length;
      if (unknown)
        r.warnings.push(
          `${unknown} tests have unknown status and are excluded from executed totals.`,
        );
      if (ignored.length)
        r.warnings.push(`Ignored ${ignored.length} metadata files.`);
      const content = JSON.stringify({
        source: r.source,
        project: options.project || "",
        mapping: options.mapping || {},
        files: r.files.map((f) => f.text).sort(),
      });
      return {
        name: options.name?.trim()
          ? reports.length > 1
            ? `${options.name.trim()} · ${r.name}`
            : options.name.trim()
          : r.name,
        source: r.source,
        tests: r.tests,
        warnings: r.warnings,
        startedAt: r.startedAt,
        files: r.files.map((f) => f.name),
        fingerprint: fingerprint(content),
      };
    }),
  );
}
