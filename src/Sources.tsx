import { useEffect, useState } from "react";
import type { SourceStatus } from "../server/sources/types";
export function Sources({ onImported }: { onImported: () => void }) {
  const [sources, setSources] = useState<SourceStatus[]>([]),
    [error, setError] = useState("");
  async function refresh() {
    try {
      const r = await fetch("/api/sources");
      if (!r.ok) throw Error("Sources require the Node server. Run npm start.");
      setSources(await r.json());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      clearInterval(timer);
      onImported();
    };
  }, []);
  async function scan(id: string) {
    try {
      const r = await fetch(`/api/sources/${id}/scan`, { method: "POST" });
      if (!r.ok) throw Error("Could not start scan.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Report sources</h2>
        <button
          className="button"
          onClick={() => {
            onImported();
            void refresh();
          }}
        >
          Refresh dashboard
        </button>
      </div>
      <p>
        Drop complete reports into report-inbox, or configure shared folders and
        SharePoint in sources.config.json. Sources are read only. New reports
        appear after a completed scan. Dashboard totals refresh every 15
        seconds.
      </p>
      {error && <p className="warning">{error}</p>}
      {sources.map((s) => (
        <article className="source-card" key={s.id}>
          <div className="panel-heading">
            <div>
              <h3>{s.label}</h3>
              <p>
                {s.type} ·{" "}
                {s.enabled
                  ? s.pollSeconds
                    ? `Every ${s.pollSeconds} seconds`
                    : "Manual scans"
                  : "Disabled"}
              </p>
            </div>
            <button
              className="button"
              disabled={!s.enabled || s.scanning}
              onClick={() => void scan(s.id)}
            >
              {s.scanning ? "Scanning…" : "Scan now"}
            </button>
          </div>
          <code className="source-location">{s.location}</code>
          <p>
            Last scan:{" "}
            {s.lastScanAt ? new Date(s.lastScanAt).toLocaleString() : "Not yet"}{" "}
            · {s.added} added · {s.unchanged} unchanged · {s.pending} waiting
            for a complete copy
          </p>
          {s.lastError && <p className="warning">{s.lastError}</p>}
          <details>
            <summary>Recent report status ({s.items.length})</summary>
            {s.items.map((i) => (
              <div className="source-item" key={i.key}>
                <strong>{i.status}</strong> · {i.key}
                {i.error && <p className="warning">{i.error}</p>}
              </div>
            ))}
          </details>
        </article>
      ))}
      {!error && !sources.length && <p>No sources configured.</p>}
      <p className="quiet">
        Allure needs its complete generated folder/ZIP or allure-results folder.
        An unfamiliar custom HTML format may need a reusable reporter adapter;
        unsupported reports are flagged without inventing test counts.
      </p>
    </section>
  );
}
