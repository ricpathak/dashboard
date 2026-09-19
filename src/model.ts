export const statuses = [
  "passed",
  "failed",
  "flaky",
  "skipped",
  "broken",
  "interrupted",
  "unknown",
] as const;
export type Status = (typeof statuses)[number];
export interface TestCase {
  id: string;
  name: string;
  project: string;
  suite: string;
  status: Status;
  rawStatus: string;
  expectedStatus?: string;
  durationMs: number;
  attempts: number;
  error: string;
  file: string;
}
export interface Run {
  id: string;
  fingerprint: string;
  name: string;
  source: string;
  importedAt: string;
  startedAt: string;
  tests: TestCase[];
  warnings: string[];
  files: string[];
}
export interface InputFile {
  name: string;
  text: string;
  kind?: "playwright-html" | "custom-html" | "html-shell";
  group?: string;
  warning?: string;
}
export interface Mapping {
  root?: string;
  name?: string;
  status?: string;
  project?: string;
  suite?: string;
  duration?: string;
  error?: string;
  durationUnit?: "ms" | "s";
}
export interface ImportOptions {
  project?: string;
  name?: string;
  mapping?: Mapping;
}
export function summary(tests: TestCase[]) {
  const counts = Object.fromEntries(statuses.map((s) => [s, 0])) as Record<
    Status,
    number
  >;
  for (const t of tests) counts[t.status]++;
  const executed = tests.length - counts.skipped - counts.unknown;
  return {
    ...counts,
    total: tests.length,
    executed,
    passRate: executed
      ? Math.round(((counts.passed + counts.flaky) / executed) * 1000) / 10
      : null,
    attempts: tests.reduce((s, t) => s + t.attempts, 0),
    durationMs: tests.reduce((s, t) => s + t.durationMs, 0),
  };
}
