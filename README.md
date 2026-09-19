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
2. Select HTML, JSON, CSV or ZIP files, or choose a whole report folder.
3. Optionally supply a business project name (e.g. Underwriting) and an execution name (e.g. Release 2.4 regression).
4. Click **Import and normalize**.
5. Review totals by project; filter by execution, open test details, or export the filtered rows as CSV.

Try files under `examples/`. “Explore sample data” displays clearly marked, illustrative data; it does not save sample runs to the database.

The hosted static preview uses the same import adapters but holds data **only in browser memory**. Files stay in the browser. Refreshing clears the preview. Use the Node application for durable storage and automated imports.

## Supported inputs (v1.1)

| Input | What to import | Behavior |
| --- | --- | --- |
| **Playwright HTML** | `playwright-report/index.html` directly, or the report folder/ZIP | Streams the embedded ZIP and reads `report.json`; preserves project, outcome, duration and retry counts |
| Playwright JSON | JSON reporter output | Preserves nested suites, final outcomes, retries, expected failures and errors |
| **Allure 2 HTML report** | Whole `allure-report` folder or ZIP including `index.html` and `data/test-cases/` | Reads test-case metadata and skips UI assets, history, screenshots and traces |
| Allure raw results | `allure-results/*-result.json`, selected together or zipped | Groups attempts by project + historyId, chooses latest result |
| **Custom HTML tables** | HTML containing a header row with test name and status columns | Reads one test per row; accepts Test/Test name/Test case/Scenario/Title and Status/Result/Outcome headers |
| Custom embedded JSON | HTML with `<script type="application/json" id="report-data">` (also `test-results`, `reportData`) | Reads the JSON data without executing scripts; custom JSON mapping applies |
| Custom JSON | Array, or `{ "tests": [...] }`, `results` or `testCases` | Standard fields or custom field mapping |
| Custom CSV | Header row + test rows | Quoted commas, escaped quotes and multiline values |
| ZIP | A report bundle containing HTML/JSON/CSV | Streams selected report entries; does not inflate or retain screenshot/trace entries |

Playwright HTML support covers both current `playwrightReportBase64` template/script payloads and older `window.playwrightReportBase64` assignments. It uses embedded final outcomes and retry counts. HTML summaries do not contain the full error/step history; use JSON if you need those details. Raw source status shows the original HTML outcome (`expected`, `unexpected`, etc.) when per-attempt status is not present. The HTML's declared test count is checked against extracted rows.

An **Allure `index.html` by itself is usually only the UI shell** and contains no test results. Choose the report folder or ZIP it with `data/`. The importer explains missing companion data rather than reporting zero tests. Allure single-file plugins, Cucumber/Extent proprietary HTML layouts, Playwright blob reports and summary-only dashboards are not universally supported. Custom HTML must contain a supported result table or embedded JSON; otherwise a layout-specific adapter is needed. Imported HTML scripts are never executed and external report resources are never fetched.

Import **one raw Allure execution per batch**. Separate report ZIPs and recognizable Allure folders are grouped independently. Do not mix raw and generated Allure records for the same execution. Clear `allure-results` between runs in your test workflow; otherwise older files can be mistaken for retries. Allure project selection is explicit override → `project` label → `parentSuite` label → `Allure`. Parameterized cases need distinct historyIds.

## Large reports and screenshots

The old **50 MB limit has been removed**. Defaults:

| Limit | Default | What is counted |
| --- | --- | --- |
| `MAX_UPLOAD_MB` | **1024 MB (1 GB)** | Combined source files in an import; the server allows a small multipart framing allowance |
| `MAX_METADATA_MB` | **256 MB** | Selected JSON/CSV and custom-table text; skipped image/trace ZIP entries and embedded image markup are excluded |
| Report entry count | 10,000 | Selected report files; ignored screenshot entries are excluded |

The Node UI and CLI send multipart uploads. The server streams them to temporary files, extracts selected metadata, then removes temporary files on success or failure. It never converts a large HTML/ZIP upload into a giant JSON request. Screenshots and attachments are excluded from database storage and final dashboard responses. Upload percentage and extraction progress are shown in the UI.

To allow a 2 GB import, run in **PowerShell** before starting the server:

```powershell
$env:MAX_UPLOAD_MB = "2048"
$env:MAX_METADATA_MB = "256"
npm start
```

Restart the server and reload the dashboard after changing limits. These variables must be in the same terminal that runs `npm start`. Raise the metadata limit only when the extracted test data itself needs it; memory requirements grow with metadata size. Raw JSON containing inline image bodies still counts those bodies as selected JSON. Use HTML/report ZIP imports to skip snapshot payloads efficiently.

Browser-session mode uses the same streaming extraction and the default limits, but remains constrained by the device's available memory. Prefer the Node app for large reports. A reverse proxy may impose its own upload/body/timeout limits independently of this application.

Validation includes an actual Playwright-generated report with two projects, expected failures, retries and skips; a standalone HTML over 60 MB with inline image data; a ZIP containing a 60 MB attachment under a 1 KB selected-metadata cap; multipart persistence and duplicate detection. These checks do not imply that a 1 GB report has been benchmarked.

## Configure Playwright

You can now import the standard HTML report directly. Optionally emit JSON as well for richer failure details:

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  reporter: [
    ['html', { open: 'never' }],
    ['json', { outputFile: 'reports/playwright.json' }],
  ],
});
```

Upload `playwright-report/index.html` or `reports/playwright.json`. Playwright project names are used automatically; use the override to combine browser projects under a business project. A test executed in two Playwright projects remains two test executions.

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
npm run import -- ./playwright-report/index.html --project Underwriting --name "Nightly regression"
npm run import -- ./allure-report.zip --project Claims --name "Integration run"
npm run import -- /path/to/allure-results --project Claims --name "Integration run"
```

The CLI accepts HTML/JSON/CSV/ZIP paths and recursively scans report directories, using file-backed multipart uploads. Custom mappings can also be passed through the JSON API for smaller reports:

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
| `POST /api/import` | Multipart `files` + JSON `options` field, or legacy JSON `{files, options}`; validates and persists atomically |
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
src/normalize.ts      Outcome normalization and fingerprinting
src/import-files.ts   Streaming HTML/ZIP extraction and metadata limits
src/main.tsx          Dashboard, filters, import flow and details
src/style.css         Responsive styling
server/index.ts      Node API, SQLite persistence and static file serving
server/uploads.ts    Multipart streaming, limits and temporary-file cleanup
scripts/import.mjs   CLI for automated ingestion
examples/            Importable report samples
tests/              Normalization regression tests
```

Add a format detector and adapter in `src/normalize.ts`, return `TestCase[]`, and test the actual format's edge cases. Both browser and server consume the same normalizer. To add richer history, store stable source test identities independently from run IDs; do not treat display names as globally unique test keys.

## Operation and scope

Environment variables: `MAX_UPLOAD_MB` (1024), `MAX_METADATA_MB` (256), `PORT` (3100), `HOST` (127.0.0.1), `DATA_DIR` (project's `data/`), `ALLOWED_HOST` (optional exact trusted host with port). The app defaults to loopback, rejects unexpected hosts and cross-origin requests, and has no built-in user accounts. Team deployment requires a trusted authenticated reverse proxy, HTTPS and an explicit host configuration. Do not expose this unauthenticated server directly to the internet.

For backups, stop the app and copy the `data/` directory. Import performance is designed for local/small-team use: all normalized runs load into browser memory, with 30-row display pagination. Database-side filtering and pagination are a future scale improvement. There is no scheduled polling, report URL fetching, attachment viewer, role model or cross-format semantic deduplication in this version.
