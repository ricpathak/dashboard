import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { expandFiles, type ImportLimits } from "../../src/import-files.ts";
import { normalize } from "../../src/normalize.ts";
import { createReader } from "./readers.ts";
import { discover } from "./discovery.ts";
import type { SourceConfig, SourceReader, SourceStatus } from "./types.ts";
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class SourceManager {
  private states = new Map<string, SourceStatus>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(
    private db: DatabaseSync,
    private configs: SourceConfig[],
    private limits: ImportLimits,
    private readerFactory: (s: SourceConfig) => SourceReader = createReader,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS source_items (source_id TEXT, item_key TEXT, signature TEXT, observed_at INTEGER, imported_signature TEXT, status TEXT, error TEXT, updated_at TEXT, PRIMARY KEY(source_id,item_key))",
    );
    for (const s of configs)
      this.states.set(s.id, {
        id: s.id,
        label: s.label,
        type: s.type,
        location: s.path || s.siteUrl || `Drive ${s.driveId} / ${s.folderId}`,
        enabled: s.enabled !== false,
        pollSeconds: s.pollSeconds ?? 60,
        settleSeconds: s.settleSeconds ?? 30,
        scanning: false,
        added: 0,
        unchanged: 0,
        pending: 0,
        items: [],
      });
  }
  statuses() {
    return [...this.states.values()].map((s) => ({
      ...s,
      items: this.db
        .prepare(
          "SELECT item_key as key,status,error,updated_at as updatedAt FROM source_items WHERE source_id=? ORDER BY updated_at DESC LIMIT 100",
        )
        .all(s.id),
    }));
  }
  start() {
    for (const s of this.configs)
      if (s.enabled !== false) {
        void this.scan(s.id);
        if ((s.pollSeconds ?? 60) > 0)
          this.timers.push(
            setInterval(
              () => {
                void this.scan(s.id);
              },
              (s.pollSeconds ?? 60) * 1000,
            ),
          );
      }
  }
  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    await this.queue;
  }
  scan(id: string): Promise<void> {
    const s = this.configs.find((s) => s.id === id),
      state = this.states.get(id);
    if (!s || !state || s.enabled === false || this.stopped)
      return Promise.reject(Error("Source is missing or disabled."));
    if (state.scanning) return this.queue;
    state.scanning = true;
    const task = this.queue.then(() => this.execute(s, state));
    this.queue = task.catch(() => {});
    return task;
  }
  private async execute(s: SourceConfig, state: SourceStatus) {
    state.added = state.unchanged = state.pending = 0;
    state.lastError = undefined;
    try {
      const reader = this.readerFactory(s);
      const bundles = discover(await reader.list(), s);
      for (const bundle of bundles) {
        if (this.stopped) break;
        const now = Date.now();
        const signature = hash([
          bundle.options,
          bundle.files.map((e) => [e.name, e.version]),
          bundle.marker?.version,
        ]);
        const old = this.db
          .prepare(
            "SELECT * FROM source_items WHERE source_id=? AND item_key=?",
          )
          .get(s.id, bundle.key);
        const observed =
          old?.signature === signature ? Number(old.observed_at) : now;
        const save = (
          status: string,
          error = "",
          imported = String(old?.imported_signature || ""),
        ) =>
          this.db
            .prepare(
              "INSERT OR REPLACE INTO source_items VALUES (?,?,?,?,?,?,?,?)",
            )
            .run(
              s.id,
              bundle.key,
              signature,
              observed,
              imported,
              status,
              error,
              new Date().toISOString(),
            );
        if (old?.imported_signature === signature) {
          state.unchanged++;
          continue;
        }
        if (
          (s.completionMarker && !bundle.marker) ||
          (!bundle.marker && now - observed < (s.settleSeconds ?? 30) * 1000)
        ) {
          save("pending");
          state.pending++;
          continue;
        }
        try {
          const files = bundle.files.map((e) => ({
            name: e.name,
            size: e.size,
            stream: () => {
              let source: ReadableStreamDefaultReader<Uint8Array> | undefined;
              return new ReadableStream<Uint8Array>({
                async pull(controller) {
                  source ??= (await reader.open(e)).getReader();
                  const r = await source.read();
                  if (r.done) {
                    source.releaseLock();
                    controller.close();
                  } else controller.enqueue(r.value);
                },
                async cancel() {
                  await source?.cancel();
                },
              });
            },
          }));
          const parsed = await normalize(
            await expandFiles(files, this.limits),
            bundle.options,
          );
          if (!parsed.length)
            throw Error(
              "No supported test results found. Supply the complete report folder or ZIP; an unknown reporter needs a reusable adapter.",
            );
          if (
            !(await reader.unchanged([
              ...bundle.files,
              ...(bundle.marker ? [bundle.marker] : []),
            ]))
          )
            throw Error(
              "Report changed during import. Waiting for a stable copy.",
            );
          const latest = discover(await reader.list(), s).find(
            (b) => b.key === bundle.key,
          );
          if (
            !latest ||
            hash([
              latest.options,
              latest.files.map((e) => [e.name, e.version]),
              latest.marker?.version,
            ]) !== signature
          )
            throw Error(
              "Report folder changed during import. Waiting for a stable copy.",
            );
          let added = 0;
          this.db.exec("BEGIN");
          try {
            for (const r of parsed) {
              const run = {
                ...r,
                id: randomUUID(),
                fingerprint: hash([s.id, bundle.key, r.fingerprint]),
                sourceId: s.id,
                sourceLabel: s.label,
                sourceItem: bundle.key,
                sourceUrl: bundle.url,
                importedAt: new Date().toISOString(),
              };
              added += Number(
                this.db
                  .prepare("INSERT OR IGNORE INTO runs VALUES (?,?,?)")
                  .run(run.id, run.fingerprint, JSON.stringify(run)).changes,
              );
            }
            save("imported", "", signature);
            this.db.exec("COMMIT");
            state.added += added;
          } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
          }
        } catch (e) {
          save("error", e instanceof Error ? e.message : "Import failed.");
        }
      }
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : "Source scan failed.";
    } finally {
      state.scanning = false;
      state.lastScanAt = new Date().toISOString();
    }
  }
}
