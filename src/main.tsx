import { newId } from "./identity";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { normalize, expandFiles } from "./normalize";
import {
  defaultImportLimits,
  ignored,
  type ImportLimits,
} from "./import-files";
import {
  summary,
  statuses,
  type Run,
  type Mapping,
  type TestCase,
} from "./model";
import { demoRuns } from "./demo";
import "./style.css";
const duration = (ms: number) =>
  ms < 1000
    ? `${Math.round(ms)} ms`
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function App() {
  const [runs, setRuns] = useState<Run[]>([]),
    [mode, setMode] = useState<"loading" | "server" | "session">("loading"),
    [demo, setDemo] = useState(false),
    [project, setProject] = useState("all"),
    [runId, setRunId] = useState("all"),
    [status, setStatus] = useState("all"),
    [query, setQuery] = useState(""),
    [tab, setTab] = useState<"overview" | "tests" | "reports">("overview"),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(0),
    [detail, setDetail] = useState<TestCase | null>(null);
  const [files, setFiles] = useState<File[]>([]),
    [projectOverride, setProjectOverride] = useState(""),
    [runName, setRunName] = useState(""),
    [mapping, setMapping] = useState<Mapping>({}),
    [drag, setDrag] = useState(false);
  const [limits, setLimits] = useState<ImportLimits>(defaultImportLimits);
  const [importProgress, setImportProgress] = useState("");
  const importer = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const reload = async () => {
    const r = await fetch("/api/runs");
    if (!r.ok) throw Error("Could not load reports from the server.");
    setRuns(await r.json());
  };
  useEffect(() => {
    fetch("/api/health")
      .then(async (r) => {
        const health = r.ok ? await r.json() : null;
        if (health?.mode === "server") {
          if (health.importLimits) setLimits(health.importLimits);
          setMode("server");
          await reload();
        } else setMode("session");
      })
      .catch(() => setMode("session"));
  }, []);
  useEffect(() => {
    setPage(0);
  }, [project, runId, status, query, runs]);
  useEffect(() => {
    if (detail) dialog.current?.showModal();
    else dialog.current?.close();
  }, [detail]);
  const projects = useMemo(
    () =>
      [...new Set(runs.flatMap((r) => r.tests.map((t) => t.project)))].sort(),
    [runs],
  );
  const selected = runs.filter((r) => runId === "all" || r.id === runId);
  const scope = selected
    .flatMap((r) =>
      r.tests.map((t) => ({
        ...t,
        runName: r.name,
        source: r.source,
        runId: r.id,
      })),
    )
    .filter((t) => project === "all" || t.project === project);
  const totals = summary(scope);
  const filtered = scope.filter(
    (t) =>
      (status === "all" || t.status === status) &&
      `${t.name} ${t.suite} ${t.project} ${t.error}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const perProject = [...new Set(scope.map((t) => t.project))]
    .sort()
    .map((name) => ({
      name,
      ...summary(scope.filter((t) => t.project === name)),
      reports: new Set(
        scope.filter((t) => t.project === name).map((t) => t.runId),
      ).size,
    }));
  const resetFilters = () => {
    setProject("all");
    setRunId("all");
    setStatus("all");
    setQuery("");
  };
  const chooseFiles = (selected: File[]) => {
    setFiles(
      selected.filter(
        (f) =>
          !ignored(f.webkitRelativePath || f.name) &&
          /\.(html?|json|csv|zip)$/i.test(f.name),
      ),
    );
  };
  async function importReports() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const options = { project: projectOverride, name: runName, mapping };
      let added = 0,
        duplicates = 0;
      if (mode === "server") {
        if (files.reduce((n, f) => n + f.size, 0) > limits.maxUploadBytes)
          throw Error(
            `Selected files exceed ${Math.round(limits.maxUploadBytes / 1024 ** 2)} MB. Increase MAX_UPLOAD_MB on the Node server.`,
          );
        const form = new FormData();
        form.append("options", JSON.stringify(options));
        files.forEach((f) =>
          form.append("files", f, f.webkitRelativePath || f.name),
        );
        const data = await new Promise<{ added: number; duplicates: number }>(
          (resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "/api/import");
            xhr.upload.onprogress = (e) =>
              setImportProgress(
                e.lengthComputable
                  ? `Uploading ${Math.round((e.loaded / e.total) * 100)}%`
                  : "Uploading…",
              );
            xhr.upload.onload = () =>
              setImportProgress("Extracting test results…");
            xhr.onerror = () =>
              reject(Error("Upload failed. Check the Node server and retry."));
            xhr.onload = () => {
              try {
                const result = JSON.parse(xhr.responseText);
                if (xhr.status < 200 || xhr.status >= 300)
                  reject(Error(result.error || "Import failed."));
                else resolve(result);
              } catch {
                reject(Error("Server returned an invalid response."));
              }
            };
            xhr.send(form);
          },
        );
        ({ added, duplicates } = data);
        await reload();
      } else {
        setImportProgress("Reading report metadata…");
        const input = await expandFiles(
          files.map((f) => ({
            name: f.webkitRelativePath || f.name,
            size: f.size,
            stream: () => f.stream(),
          })),
          limits,
          (p) =>
            setImportProgress(
              `Reading ${Math.round((p.bytesRead / Math.max(p.totalBytes, 1)) * 100)}%`,
            ),
        );
        const parsed = await normalize(input, options);
        const current = demo ? [] : runs;
        const known = new Set(current.map((r) => r.fingerprint));
        const fresh: Run[] = [];
        for (const r of parsed) {
          if (known.has(r.fingerprint)) {
            duplicates++;
            continue;
          }
          known.add(r.fingerprint);
          fresh.push({
            ...r,
            id: newId(),
            importedAt: new Date().toISOString(),
          });
        }
        added = fresh.length;
        setRuns([...fresh, ...current]);
      }
      setDemo(false);
      resetFilters();
      setFiles([]);
      setMessage(
        `${added} report${added === 1 ? "" : "s"} imported${duplicates ? `; ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped` : ""}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setImportProgress("");
    }
  }
  async function removeRun(r: Run) {
    if (!confirm(`Remove “${r.name}” from the dashboard?`)) return;
    try {
      if (mode === "server" && !demo) {
        const result = await fetch(`/api/runs/${r.id}`, { method: "DELETE" });
        if (!result.ok) throw Error("Could not delete report.");
      }
      setRuns((v) => v.filter((x) => x.id !== r.id));
      if (runId === r.id) setRunId("all");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function exportCsv() {
    const columns = [
      "project",
      "runName",
      "source",
      "name",
      "suite",
      "status",
      "rawStatus",
      "expectedStatus",
      "durationMs",
      "attempts",
      "error",
    ];
    const safe = (s: unknown) => {
      let v = String(s ?? "");
      if (/^[=+@\-\t\r]/.test(v)) v = "'" + v;
      return '"' + v.replace(/"/g, '""') + '"';
    };
    download(
      "test-results.csv",
      [
        columns.join(","),
        ...filtered.map((t) =>
          columns.map((k) => safe((t as any)[k])).join(","),
        ),
      ].join("\r\n"),
      "text/csv;charset=utf-8",
    );
  }
  useEffect(() => {
    const mc = (document as any).modelContext;
    if (!mc?.registerTool) return;
    const lifecycle = new AbortController();
    Promise.resolve(
      mc.registerTool(
        {
          name: "filter_test_reports",
          description:
            "Filter the displayed test reports by project and normalized status.",
          inputSchema: {
            type: "object",
            properties: {
              project: { type: "string" },
              status: { type: "string", enum: ["all", ...statuses] },
            },
          },
          execute: async (args: any) => {
            if (
              !args ||
              typeof args !== "object" ||
              (args.project !== undefined &&
                typeof args.project !== "string") ||
              (args.status !== undefined &&
                !["all", ...statuses].includes(args.status))
            )
              throw Error("Invalid project or status filter.");
            setProject(args.project || "all");
            setStatus(args.status || "all");
            setTab("tests");
            return {
              content: [{ type: "text", text: "Dashboard filters updated." }],
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, []);
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="#">
          <span className="mark">▥</span>
          <span>
            report<span className="brand-light">hub</span>
            <small>QUALITY WORKSPACE</small>
          </span>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {(
            [
              ["overview", "◫", "Overview"],
              ["tests", "☷", "Test results"],
              ["reports", "▤", "Report library"],
            ] as const
          ).map(([id, icon, label]) => (
            <button
              key={id}
              className={tab === id ? "nav active" : "nav"}
              onClick={() => setTab(id)}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
              {id === "reports" && <b>{runs.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="small-circle">✓</span>
          <strong>One view. Every run.</strong>
          <p>Playwright, Allure and custom reports, brought together.</p>
          <div className="mode">
            {mode === "server"
              ? "SQLite storage"
              : mode === "loading"
                ? "Connecting…"
                : "Browser session"}
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            Workspace <span>/</span> Execution intelligence
          </div>
          <button
            className="button primary"
            onClick={() => {
              importer.current?.scrollIntoView({ behavior: "smooth" });
              document.getElementById("report-files")?.focus();
            }}
          >
            ＋ Import reports
          </button>
        </header>
        <section className="heading">
          <div>
            <div className="eyebrow">TEST EXECUTION</div>
            <h1>
              {tab === "overview"
                ? "Quality at a glance"
                : tab === "tests"
                  ? "Every result, in detail"
                  : "Your report library"}
            </h1>
            <p>Multiple formats. One consistent picture of your projects.</p>
          </div>
          <button
            className="button"
            disabled={!scope.length}
            onClick={exportCsv}
          >
            ↓ Export results
          </button>
        </section>
        <div className="notice">
          {demo ? (
            <>
              <strong>Sample workspace</strong> — illustrative data. Import your
              reports to replace it.
            </>
          ) : mode === "server" ? (
            "Reports are saved on this Node server and available after restart."
          ) : (
            "Session workspace — files are processed in your browser. Refresh clears imported reports; export before leaving."
          )}
          {!runs.length && mode !== "loading" && (
            <button
              onClick={() => {
                setRuns(demoRuns());
                setDemo(true);
                resetFilters();
              }}
            >
              Explore sample data →
            </button>
          )}
        </div>
        {error && (
          <div role="alert" className="alert error">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {message && (
          <div role="status" className="alert success">
            {message}
          </div>
        )}
        <section className="filters" aria-label="Report filters">
          <label>
            Project
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Execution
            <select value={runId} onChange={(e) => setRunId(e.target.value)}>
              <option value="all">All imported reports</option>
              {runs.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div className="scope-note">
            {selected.length} report{selected.length === 1 ? "" : "s"} in scope
            <br />
            <span>Totals across selected executions</span>
          </div>
          <button className="text-button" onClick={resetFilters}>
            Reset filters
          </button>
        </section>
        {tab === "overview" && (
          <>
            <section className="metrics">
              <article>
                <span>Tests executed</span>
                <strong>{totals.executed.toLocaleString()}</strong>
                <small>
                  {totals.total} total · {totals.skipped} skipped ·{" "}
                  {totals.unknown} unknown
                </small>
              </article>
              <article className="pass">
                <span>Passed</span>
                <strong>{totals.passed.toLocaleString()}</strong>
                <small>Passed without a flaky outcome</small>
              </article>
              <article className="fail">
                <span>Failed / broken</span>
                <strong>
                  {totals.failed + totals.broken + totals.interrupted}
                </strong>
                <small>
                  {totals.failed} failed · {totals.broken} broken ·{" "}
                  {totals.interrupted} interrupted
                </small>
              </article>
              <article>
                <span>
                  Pass rate <b className="tag">INCLUDING FLAKY</b>
                </span>
                <strong>
                  {totals.passRate === null ? "—" : `${totals.passRate}%`}
                </strong>
                <small>
                  {totals.flaky} flaky · {totals.attempts} attempts including
                  retries
                </small>
              </article>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Project health</h2>
                  <p>Final outcomes per test, across the selected reports.</p>
                </div>
                <span className="badge">{perProject.length} projects</span>
              </div>
              {!perProject.length ? (
                <div className="empty">
                  <span>▥</span>
                  <h3>Your reports belong together</h3>
                  <p>
                    Import your first execution, or explore sample data to see
                    the dashboard in action.
                  </p>
                  <button
                    className="button"
                    onClick={() => {
                      setRuns(demoRuns());
                      setDemo(true);
                    }}
                  >
                    Explore sample data
                  </button>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th>Outcome distribution</th>
                        <th>Executed</th>
                        <th>Passed</th>
                        <th>Failed*</th>
                        <th>Flaky</th>
                        <th>Pass rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perProject.map((p) => (
                        <tr key={p.name}>
                          <td>
                            <button
                              className="project-name"
                              onClick={() => {
                                setProject(p.name);
                                setTab("tests");
                              }}
                            >
                              {p.name}
                            </button>
                            <small>
                              {p.reports} reports · {p.total} total tests
                            </small>
                          </td>
                          <td className="distribution">
                            <div
                              className="stack"
                              role="img"
                              aria-label={statuses
                                .map((s) => `${s}: ${p[s]}`)
                                .join(", ")}
                            >
                              {statuses.map(
                                (s) =>
                                  p[s] > 0 && (
                                    <span
                                      key={s}
                                      className={s}
                                      style={{
                                        width: `${(p[s] / p.total) * 100}%`,
                                      }}
                                    />
                                  ),
                              )}
                            </div>
                          </td>
                          <td>{p.executed}</td>
                          <td className="green">{p.passed}</td>
                          <td className="red">
                            {p.failed + p.broken + p.interrupted}
                          </td>
                          <td>{p.flaky}</td>
                          <td>
                            <strong>
                              {p.passRate === null ? "—" : `${p.passRate}%`}
                            </strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="legend">
                {statuses.map((s) => (
                  <span key={s}>
                    <i className={s} />
                    {s}
                  </span>
                ))}
                <small>* Includes broken and interrupted.</small>
              </div>
            </section>
            <div className="two-col">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Needs attention</h2>
                    <p>Failures and unstable tests in this selection.</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => {
                      setStatus("failed");
                      setTab("tests");
                    }}
                  >
                    View failures →
                  </button>
                </div>
                {scope
                  .filter((t) =>
                    ["failed", "broken", "flaky", "interrupted"].includes(
                      t.status,
                    ),
                  )
                  .slice(0, 5)
                  .map((t) => (
                    <button
                      className="attention"
                      key={t.id}
                      onClick={() => setDetail(t)}
                    >
                      <span className={`pill ${t.status}`}>{t.status}</span>
                      <span>
                        <strong>{t.name}</strong>
                        <small>
                          {t.project} · {t.runName}
                        </small>
                      </span>
                      <span>↗</span>
                    </button>
                  ))}
                {!scope.some((t) =>
                  ["failed", "broken", "flaky", "interrupted"].includes(
                    t.status,
                  ),
                ) && (
                  <p className="quiet">
                    {scope.length
                      ? "No failures or flaky tests in this selection."
                      : "Import reports to identify failing tests."}
                  </p>
                )}
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Recent imports</h2>
                    <p>Source formats, standardized.</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setTab("reports")}
                  >
                    View all →
                  </button>
                </div>
                {runs.slice(0, 4).map((r) => (
                  <div className="recent" key={r.id}>
                    <span className="file-icon">▤</span>
                    <div>
                      <strong>{r.name}</strong>
                      <small>
                        {r.source} · {r.tests.length} tests
                      </small>
                    </div>
                    <span className="badge">
                      {summary(r.tests).passRate ?? "—"}%
                    </span>
                  </div>
                ))}
                {!runs.length && (
                  <p className="quiet">
                    Your imported executions will appear here.
                  </p>
                )}
              </section>
            </div>
          </>
        )}
        {tab === "tests" && (
          <section className="panel">
            <div className="panel-heading">
              <h2>
                Test results <span className="badge">{filtered.length}</span>
              </h2>
              <div className="test-filters">
                <input
                  aria-label="Search tests"
                  placeholder="Search tests, suites, errors…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  aria-label="Status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="all">All statuses</option>
                  {statuses.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Test / suite</th>
                    <th>Project / report</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(page * 30, (page + 1) * 30).map((t) => (
                    <tr key={t.id}>
                      <td>
                        <button
                          className="test-name"
                          onClick={() => setDetail(t)}
                        >
                          {t.name}
                        </button>
                        <small>{t.suite || "No suite"}</small>
                      </td>
                      <td>
                        {t.project}
                        <small>{t.runName}</small>
                      </td>
                      <td>
                        <span className={`pill ${t.status}`}>{t.status}</span>
                      </td>
                      <td>{duration(t.durationMs)}</td>
                      <td>{t.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <p className="quiet">No tests match this selection.</p>
            )}
            <div className="pagination">
              <button
                className="button"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                Page {page + 1} of{" "}
                {Math.max(1, Math.ceil(filtered.length / 30))}
              </span>
              <button
                className="button"
                disabled={(page + 1) * 30 >= filtered.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </section>
        )}
        {tab === "reports" && (
          <section className="panel">
            <div className="panel-heading">
              <h2>Imported executions</h2>
              <span className="badge">{runs.length} reports</span>
            </div>
            {runs.map((r) => (
              <article className="report-row" key={r.id}>
                <div>
                  <h3>{r.name}</h3>
                  <p>
                    {r.source} · {r.tests.length} tests · imported{" "}
                    {new Date(r.importedAt).toLocaleString()}
                  </p>
                  <small>{r.files.join(", ")}</small>
                  {r.warnings.map((w, i) => (
                    <p className="warning" key={i}>
                      {w}
                    </p>
                  ))}
                </div>
                <div className="report-actions">
                  <button
                    className="button"
                    onClick={() => {
                      setRunId(r.id);
                      setTab("tests");
                    }}
                  >
                    View tests
                  </button>
                  <button
                    className="text-button danger"
                    onClick={() => removeRun(r)}
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))}
            {!runs.length && <p className="quiet">No reports imported yet.</p>}
          </section>
        )}
        <section className="panel import-panel" ref={importer}>
          <div className="panel-heading">
            <div>
              <div className="eyebrow">BRING YOUR OWN REPORTS</div>
              <h2>Import an execution</h2>
              <p>
                Select multiple reports to combine projects in one dashboard.
              </p>
            </div>
            <span className="badge">HTML · JSON · CSV · ZIP</span>
          </div>
          <div className="import-grid">
            <div>
              <label
                className={`drop-zone ${drag ? "drag" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  chooseFiles(Array.from(e.dataTransfer.files));
                }}
              >
                <span className="upload-icon">↥</span>
                <strong>
                  {files.length
                    ? `${files.length} files selected`
                    : "Drop reports here or browse files"}
                </strong>
                <span>
                  Playwright HTML/JSON, Allure ZIPs, custom HTML/JSON/CSV
                </span>
                <input
                  id="report-files"
                  type="file"
                  onClick={(e) => {
                    e.currentTarget.value = "";
                  }}
                  multiple
                  accept=".json,.csv,.zip,.html,.htm"
                  onChange={(e) =>
                    chooseFiles(Array.from(e.target.files || []))
                  }
                />
              </label>
              <label className="folder-picker">
                Or choose a report folder
                <input
                  type="file"
                  multiple
                  {...{ webkitdirectory: "" }}
                  onChange={(e) =>
                    chooseFiles(Array.from(e.target.files || []))
                  }
                />
              </label>
              <p className="import-help">
                Up to {Math.round(limits.maxUploadBytes / 1024 ** 2)} MB per
                import · {Math.round(limits.maxMetadataBytes / 1024 ** 2)} MB
                extracted test data. Images and traces are excluded.
              </p>
              {files.length > 0 && (
                <p className="selected-files">
                  {files
                    .slice(0, 8)
                    .map((f) => f.name)
                    .join(", ")}
                  {files.length > 8 ? ` … and ${files.length - 8} more` : ""}
                </p>
              )}
              <p className="import-help">
                Import Playwright index.html directly. For Allure, choose its
                whole report folder or ZIP including data/. Custom HTML tables
                need test-name and status columns.
              </p>
            </div>
            <div className="import-options">
              <label>
                Report name <span>(optional)</span>
                <input
                  value={runName}
                  onChange={(e) => setRunName(e.target.value)}
                  placeholder="e.g. Release 2.4 · regression"
                />
              </label>
              <label>
                Project override <span>(optional)</span>
                <input
                  value={projectOverride}
                  onChange={(e) => setProjectOverride(e.target.value)}
                  placeholder="Keep projects from report"
                />
              </label>
              <details>
                <summary>Custom JSON / CSV field mapping</summary>
                <div className="mapping-grid">
                  {(
                    [
                      ["root", "Array path", "tests"],
                      ["name", "Test name", "name"],
                      ["status", "Status", "status"],
                      ["project", "Project", "project"],
                      ["suite", "Suite", "suite"],
                      ["duration", "Duration", "durationMs"],
                      ["error", "Error", "error"],
                    ] as const
                  ).map(([key, label, placeholder]) => (
                    <label key={key}>
                      {label}
                      <input
                        placeholder={placeholder}
                        value={mapping[key] || ""}
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [key]: e.target.value }))
                        }
                      />
                    </label>
                  ))}
                  <label>
                    Duration unit
                    <select
                      value={mapping.durationUnit || "ms"}
                      onChange={(e) =>
                        setMapping((m) => ({
                          ...m,
                          durationUnit: e.target.value as "ms" | "s",
                        }))
                      }
                    >
                      <option value="ms">Milliseconds</option>
                      <option value="s">Seconds</option>
                    </select>
                  </label>
                </div>
                <p className="import-help">
                  Use dotted paths for nested fields, e.g. result.status. Leave
                  array path blank for CSV.
                </p>
              </details>
              <button
                className="button primary import-button"
                disabled={!files.length || busy || mode === "loading"}
                onClick={importReports}
              >
                {busy
                  ? importProgress || "Importing…"
                  : "Import and normalize →"}
              </button>
            </div>
          </div>
        </section>
        <footer>
          <span>
            Report Hub <b> / </b> Unified test intelligence
          </span>
          <span>
            Executed excludes skipped & unknown. Pass rate includes flaky tests.
          </span>
        </footer>
      </main>
      <dialog
        ref={dialog}
        onCancel={() => setDetail(null)}
        onClick={(e) => {
          if (e.target === dialog.current) setDetail(null);
        }}
      >
        <div className="dialog-head">
          <h2>Test details</h2>
          <button
            className="button"
            onClick={() => setDetail(null)}
            aria-label="Close test details"
          >
            ×
          </button>
        </div>
        {detail && (
          <>
            <span className={`pill ${detail.status}`}>{detail.status}</span>
            <h3>{detail.name}</h3>
            <dl>
              <dt>Project</dt>
              <dd>{detail.project}</dd>
              <dt>Suite</dt>
              <dd>{detail.suite || "—"}</dd>
              <dt>Source status</dt>
              <dd>{detail.rawStatus}</dd>
              <dt>Expected status</dt>
              <dd>{detail.expectedStatus || "Not supplied"}</dd>
              <dt>Duration / attempts</dt>
              <dd>
                {duration(detail.durationMs)} / {detail.attempts}
              </dd>
              <dt>File</dt>
              <dd>{detail.file || "Not supplied"}</dd>
            </dl>
            <h4>Failure details / retry history</h4>
            <pre>{detail.error || "No error details supplied."}</pre>
          </>
        )}
      </dialog>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
