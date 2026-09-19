# Report Hub

A Node.js + TypeScript application that normalizes Playwright, Allure and custom test reports into one project dashboard. React + Vite powers the UI; the Node HTTP API saves normalized runs to SQLite. No AI service or API key is needed.

## Run locally

Install Node.js **22.13+** (Node 24 LTS recommended), unzip the project, then:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:3100**. `npm start` serves both the UI and API. Data persists in `data/reports.sqlite`; restarting the application preserves imports. SQLite may print an experimental-feature warning on some Node releases.

1. Choose **Import reports**.
2. Select one or more JSON/CSV files or ZIP archives.
3. Optionally supply a business project name (e.g. Underwriting) and an execution name (e.g. Release 2.4 regression).
4. Click **Import and normalize**.
5. Review totals by project; filter by execution, open test details, or export the filtered rows as CSV.

Try files under `examples/`. “Explore sample data” displays clearly marked, illustrative data; it does not save sample runs to the database.

The hosted static preview uses the same import adapters but holds data **only in browser memory**. Files stay in the browser. Refreshing clears the preview. Use the Node application for durable storage and automated imports.

## Supported inputs

| Input | What to import | Behavior |
| --- | --- | --- |
| Playwright | JSON reporter output | Preserves projects, nested suites, final outcomes, retries, expected failures and errors |
| Allure raw results | `allure-results/*-result.json`, selected together or zipped | Groups attempts by project + historyId, chooses latest result |
| Allure 2 generated test cases | `allure-report/data/test-cases/*.json` | Reads available outcomes and timing; raw result files provide fuller retry detail |
| Custom JSON | Array, or `{ "tests": [...] }`, `results` or `testCases` | Uses standard fields or the import panel's custom field mapping |
| Custom CSV | Header row + test rows | Supports quoted commas, escaped quotes and multiline values |
| ZIP | JSON/CSV report files | Expands in memory; ignores known Allure metadata and attachments |

HTML-only reports, Playwright blob reports, JUnit XML and summary-only dashboards are not supported in this version. Import machine-readable test-level data instead. Arbitrary custom schemas require mapping or another adapter; formats are not guessed from free-form HTML.

Import **one Allure execution per batch**. All selected Allure files are treated as one run. Do not mix raw and generated Allure records for the same execution. Clear `allure-results` between runs in your test workflow; otherwise older files can be mistaken for retries. Allure project selection is explicit override → `project` label → `parentSuite` label → `Allure`. Parameterized cases need distinct historyIds, as produced by a correctly configured Allure adapter.

ZIPs are capped at 50 MB compressed and 50 MB expanded per import; regular input batch bytes are capped at 50 MB. There is a 10,000-file limit. Raw report files, screenshots, traces and attachments are not retained or replayed; only normalized metadata/error text is saved. For very large executions, split batches or extend the storage/query layer.

## Configure Playwright

Keep HTML for detailed investigation and emit JSON for this dashboard:

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  reporter: [
    ['html', { open: 'never' }],
    ['json', { outputFile: 'reports/playwright.json' }],
  ],
});
```

Upload `reports/playwright.json`. Playwright project names are used automatically; use the override to combine browser projects under a business project. A test executed in two Playwright projects remains two test executions.

Official format references: [Playwright reporters](https://playwright.dev/docs/test-reporters), [Allure result files](https://allurereport.org/docs/how-it-works-test-result-file/).

## Custom schema

```json
{
  "project": "Underwriting",
  "tests": [
    { "name": "Approve standard risk", "suite": "New business", "status": "passed", "durationMs": 2100 },
    { "name": "Reject invalid application", "status": "failed", "durationMs": 900, "error": "Missing validation message" }
  ]
}
```

Default fields: `name` (aliases `title`, `testName`), `status` (alias `result`), `project`, `suite`, `durationMs` (alias `duration`), `attempts`, `error`, `file`. Durations default to milliseconds; choose seconds when necessary.

For `{ "payload": { "cases": [{ "title": "A", "result": { "outcome": "PASS" }, "elapsed": 2 }] } }`, set:

- Array path: `payload.cases`
- Test name: `title`
- Status: `result.outcome`
- Duration: `elapsed`
- Duration unit: `Seconds`

CSV uses column headers as field names. Leave array path empty. Unknown status strings are preserved as `rawStatus` and classified as `unknown`, never silently converted into passed/failed.

## Counting rules

- **Total**: normalized test cases across selected executions. The same test in different executions is intentionally counted multiple times.
- **Executed**: total minus skipped and unknown; includes interrupted attempts.
- **Passed**: final expected success, including Playwright expected failures marked `test.fail()`.
- **Flaky**: failed and then passed within a run. Counted once, separately from stable passed tests.
- **Failed / broken**: failed + broken + interrupted.
- **Pass rate**: `(passed + flaky) / executed × 100`; no executed tests shows a dash.
- **Attempts**: includes retries. Durations sum attempts, not wall-clock execution time.
- Playwright unexpected passes count as failed. Source and expected statuses are visible in test details.
- Identical file content + project override + mapping is fingerprinted to prevent duplicate imports. Renaming a file or changing the display name does not create a new run. This does **not** deduplicate overlapping shards or the same execution exported in different formats; import only one representation per execution.
- Dashboard execution selection defaults to all imports, not “latest run per project”.

## Automated imports

Start the server first, then from a second terminal:

```sh
npm run import -- ./examples/playwright-report.json --project Underwriting --name "Nightly regression"
npm run import -- /path/to/allure-results --project Claims --name "Integration run"
```

The CLI accepts JSON/CSV paths and recursively scans directories. ZIP import is available through the UI. Custom mappings can also be passed through the API:

```ts
const response = await fetch('http://127.0.0.1:3100/api/import', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    files: [{ name: 'run.json', text: JSON.stringify(report) }],
    options: { project: 'Underwriting', name: 'Nightly', mapping: { root: 'payload.cases', name: 'title', status: 'result.outcome' } },
  }),
});
if (!response.ok) throw new Error(await response.text());
console.log(await response.json()); // { added, duplicates }
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Identify server mode |
| `GET /api/runs` | All normalized runs |
| `POST /api/import` | Validate, normalize and persist a batch atomically |
| `DELETE /api/runs/:id` | Remove a run |

Malformed report batches are rejected before any new run is saved. Report deletion requires UI confirmation. CSV export neutralizes formula-leading cells.

## Development and extension

```sh
npm test
npm run dev
```

`npm run dev` starts a Vite browser-session preview. To verify the complete app with persistent storage, run `npm run build` and `npm start`. `npm run format` formats the TypeScript and UI sources.

```text
src/model.ts          Shared run/test model and metric definitions
src/normalize.ts      Detection, adapters, CSV/ZIP parsing and fingerprinting
src/main.tsx          Dashboard, filters, import flow and details
src/style.css         Responsive styling
server/index.ts      Node API, SQLite persistence and static file serving
scripts/import.mjs   CLI for automated ingestion
examples/            Importable report samples
tests/              Normalization regression tests
```

Add a format detector and adapter in `src/normalize.ts`, return `TestCase[]`, and test the actual format's edge cases. Both browser and server consume the same normalizer. To add richer history, store stable source test identities independently from run IDs; do not treat display names as globally unique test keys.

## Operation and scope

Environment variables: `PORT` (3100), `HOST` (127.0.0.1), `DATA_DIR` (project's `data/`), `ALLOWED_HOST` (optional exact trusted host with port). The app defaults to loopback, rejects unexpected hosts and cross-origin requests, and has no built-in user accounts. Team deployment requires a trusted authenticated reverse proxy, HTTPS and an explicit host configuration. Do not expose this unauthenticated server directly to the internet.

For backups, stop the app and copy the `data/` directory. Import performance is designed for local/small-team use: all normalized runs load into browser memory, with 30-row display pagination. Database-side filtering and pagination are a future scale improvement. There is no scheduled polling, report URL fetching, attachment viewer, role model or cross-format semantic deduplication in this version.
