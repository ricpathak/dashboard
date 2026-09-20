import { htmlContent, embeddedReport } from "./html-content";
import { Parser } from "htmlparser2";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import type { InputFile } from "./model";

export interface ImportLimits {
  maxUploadBytes: number;
  maxMetadataBytes: number;
  maxFiles: number;
}
export const defaultImportLimits: ImportLimits = {
  maxUploadBytes: 1024 ** 3,
  maxMetadataBytes: 256 * 1024 ** 2,
  maxFiles: 10000,
};
export interface ReportFile {
  name: string;
  size?: number;
  stream?: () => ReadableStream<Uint8Array>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}
export interface ImportProgress {
  bytesRead: number;
  totalBytes: number;
  file: string;
}
export class ImportLimitError extends Error {
  statusCode = 413;
}
const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;
export function ignored(name: string) {
  return (
    /(^|\/)export\/mail\.html$/i.test(name) ||
    /(^|\/)(attachments|history|widgets|trace|traces|node_modules|plugins)\//i.test(
      name,
    ) ||
    /-(container|attachment)\.json$/i.test(name) ||
    /(^|\/)(categories|executor|environment|suites|behaviors|packages|timeline|summary|history-trend|duration-trend|retry-trend|status-chart)\.json$/i.test(
      name,
    )
  );
}
function groupFor(name: string, origin: string) {
  const n = name.replace(/\\/g, "/");
  const match = n.match(/^(.*?)\/(?:data\/test-cases|allure-results)\//);
  return match ? `${origin}::${match[1]}` : origin;
}
interface Sink {
  push: (chunk: Uint8Array) => void;
  end: () => void;
}
class Context {
  output: InputFile[] = [];
  metadataBytes = 0;
  entries = 0;
  bytesRead = 0;
  totalBytes = 0;
  constructor(
    readonly limits: ImportLimits,
    readonly progress?: (p: ImportProgress) => void,
  ) {}
  metadata(n: number) {
    this.metadataBytes += n;
    if (this.metadataBytes > this.limits.maxMetadataBytes)
      throw new ImportLimitError(
        `Extracted test data exceeds ${mb(this.limits.maxMetadataBytes)}. Screenshots are excluded. Increase MAX_METADATA_MB on the Node server if necessary.`,
      );
  }
  entry() {
    if (++this.entries > this.limits.maxFiles)
      throw new ImportLimitError(
        `Import exceeds ${this.limits.maxFiles} report entries.`,
      );
  }
  add(file: InputFile) {
    this.output.push(file);
  }
}
function textSink(ctx: Context, done: (text: string) => void): Sink {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  return {
    push(b) {
      ctx.metadata(b.length);
      parts.push(decoder.decode(b, { stream: true }));
    },
    end() {
      parts.push(decoder.decode());
      done(parts.join(""));
    },
  };
}
function archiveSink(
  ctx: Context,
  origin: string,
  depth = 0,
  playwright = false,
): Sink {
  if (depth > 3)
    throw Error(
      "Report archives are nested too deeply. Extract the outer archive first.",
    );
  let selected = 0;
  let failure: Error | undefined;
  const unzip = new Unzip((entry) => {
    const name = entry.name.replace(/\\/g, "/");
    if (
      playwright
        ? name !== "report.json"
        : ignored(name) || !/\.(json|csv|html?)$/i.test(name)
    ) {
      // fflate buffers entries that are never started. Consume ignored compressed
      // bytes with a no-op decoder so attachments are neither retained nor inflated.
      class Discard {
        static compression = entry.compression;
        ondata: any;
        push(_chunk: Uint8Array, final: boolean) {
          if (final) this.ondata(null, new Uint8Array(), true);
        }
      }
      unzip.register(Discard);
      entry.ondata = () => {};
      entry.start();
      return;
    }
    ctx.entry();
    if (entry.compression !== 0 && entry.compression !== 8)
      throw Error(
        `${origin}: unsupported ZIP compression for ${name}. Use a standard deflate ZIP.`,
      );
    unzip.register(entry.compression === 0 ? UnzipPassThrough : UnzipInflate);
    selected++;
    const sink = playwright
      ? textSink(ctx, (text) => {
          let data: any;
          try {
            data = JSON.parse(text);
          } catch {
            throw Error(`${origin}: invalid embedded Playwright report.json.`);
          }
          if (!Array.isArray(data.files))
            throw Error(`${origin}: unsupported Playwright HTML data schema.`);
          ctx.add({
            name: origin,
            text: JSON.stringify(data),
            kind: "playwright-html",
          });
        })
      : reportSink(ctx, name, origin, depth + 1);
    // The declared size is only applied to selected JSON/CSV, never screenshots.
    if (
      !/\.html?$/i.test(name) &&
      entry.originalSize !== undefined &&
      entry.originalSize > ctx.limits.maxMetadataBytes
    )
      throw new ImportLimitError(
        `Selected report data ${name} exceeds ${mb(ctx.limits.maxMetadataBytes)}.`,
      );
    entry.ondata = (error, data, final) => {
      if (error) {
        failure = error;
        return;
      }
      try {
        sink.push(data);
        if (final) sink.end();
      } catch (e) {
        failure = e as Error;
        entry.terminate();
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  return {
    push(data) {
      unzip.push(data, false);
      if (failure) throw failure;
    },
    end() {
      unzip.push(new Uint8Array(), true);
      if (failure) throw failure;
      if (!selected)
        throw Error(`${origin}: ZIP contains no supported report data.`);
    },
  };
}
// Incremental base64 decoding keeps embedded screenshots out of a full-file string.
function base64Sink(zip: Sink): {
  write: (s: string) => void;
  end: () => void;
} {
  let prefix = "",
    started = false,
    remainder = "",
    closed = false;
  return {
    write(s) {
      if (closed) return;
      if (!started) {
        prefix += s;
        const marker = "data:application/zip;base64,";
        const i = prefix.indexOf(marker);
        if (i < 0) {
          prefix = prefix.slice(-marker.length);
          return;
        }
        s = prefix.slice(i + marker.length);
        prefix = "";
        started = true;
      }
      const end = s.search(/[^A-Za-z0-9+/=\s]/);
      if (end >= 0) {
        s = s.slice(0, end);
        closed = true;
      }
      remainder += s.replace(/\s/g, "");
      const count = remainder.length - (remainder.length % 4);
      if (count) {
        const binary = atob(remainder.slice(0, count));
        zip.push(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
        remainder = remainder.slice(count);
      }
    },
    end() {
      if (!started) throw Error("Playwright HTML has no embedded ZIP payload.");
      if (remainder.length)
        throw Error("Playwright HTML contains a truncated base64 payload.");
      zip.end();
    },
  };
}
function htmlSink(
  ctx: Context,
  name: string,
  origin: string,
  depth: number,
): Sink {
  const decoder = new TextDecoder();
  let specialDepth = 0,
    tagDepth = 0,
    specialTag = "",
    candidate = false,
    scriptTail = "",
    payload: ReturnType<typeof base64Sink> | undefined;
  let id = "",
    type = "",
    tag = "",
    jsonParts: string[] | undefined,
    allure = false,
    tableDepth = 0,
    headers: string[] | undefined,
    row: string[] = [],
    cell: string | undefined,
    cellTag = "",
    cellDepth = 0,
    ignoredDepth = 0;
  const content = htmlContent();
  let attributes: Record<string, string> = {},
    scriptContent = "",
    scriptOversize = false;
  const rows: Record<string, string>[] = [];
  let foundPlaywright = false,
    foundJson = false;
  const aliases: Record<string, string> = {
    name: "name",
    test: "name",
    testname: "name",
    testcase: "name",
    testcasename: "name",
    scenario: "name",
    title: "name",
    status: "status",
    result: "status",
    outcome: "status",
    project: "project",
    projectname: "project",
    suite: "suite",
    duration: "durationMs",
    durationms: "durationMs",
    durationmilliseconds: "durationMs",
    error: "error",
    message: "error",
  };
  function finishRow() {
    if (!row.length) return;
    const mapped = row.map(
      (v) => aliases[v.toLowerCase().replace(/[^a-z]/g, "")] || "",
    );
    if (mapped.includes("name") && mapped.includes("status")) {
      headers = mapped;
      return;
    }
    if (headers) {
      const r: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (h) r[h] = row[i] || "";
      });
      if (r.name?.trim() && r.status?.trim()) rows.push(r);
    }
    row = [];
  }
  const parser = new Parser(
    {
      onopentagname(n) {
        tagDepth++;
        attributes = {};
        tag = n;
        id = "";
        type = "";
      },
      onattribute(n, value) {
        if (
          [
            "class",
            "data-test-name",
            "data-status",
            "data-project",
            "status",
            "hidden",
            "aria-hidden",
          ].includes(n)
        )
          attributes[n] = value.slice(0, 4096);
        if (n === "id") id = value;
        if (n === "type") type = value;
      },
      onopentag(n) {
        content.open(n, attributes);
        if (
          (n === "template" || n === "script") &&
          id === "playwrightReportBase64"
        ) {
          specialDepth = tagDepth;
          specialTag = n;
          payload = base64Sink(archiveSink(ctx, name, depth + 1, true));
          foundPlaywright = true;
          return;
        }
        if (n === "script") {
          specialDepth = tagDepth;
          specialTag = n;
          candidate = true;
          scriptTail = "";
          scriptContent = "";
          scriptOversize = false;
          if (
            type === "application/json" &&
            ["report-data", "test-results", "reportData"].includes(id)
          )
            jsonParts = [];
          return;
        }
        if (n === "table") {
          tableDepth++;
          if (tableDepth === 1) headers = undefined;
        }
        if (tableDepth === 1 && n === "tr") row = [];
        if (tableDepth === 1 && (n === "td" || n === "th")) {
          cell = "";
          cellTag = n;
          cellDepth = tagDepth;
        }
        if (["style", "svg"].includes(n)) ignoredDepth = tagDepth;
      },
      ontext(s) {
        if (payload) {
          payload.write(s);
          return;
        }
        if (specialTag === "script") {
          if (!jsonParts && !scriptOversize) {
            if (
              scriptContent.length + s.length <=
              Math.min(ctx.limits.maxMetadataBytes, 2 * 1024 ** 2)
            )
              scriptContent += s;
            else {
              scriptContent = "";
              scriptOversize = true;
            }
          }
          if (jsonParts) {
            ctx.metadata(new TextEncoder().encode(s).length);
            jsonParts.push(s);
            return;
          }
          if (candidate) {
            scriptTail = scriptTail + s;
            const match = scriptTail.match(
              /(?:window\.)?playwrightReportBase64\s*=/,
            );
            if (match) {
              payload = base64Sink(archiveSink(ctx, name, depth + 1, true));
              foundPlaywright = true;
              payload.write(scriptTail.slice(match.index));
              candidate = false;
            } else scriptTail = scriptTail.slice(-128);
          }
          return;
        }
        content.text(s);
        if (s.toLowerCase().includes("allure")) allure = true;
        if (cell !== undefined && !ignoredDepth) {
          ctx.metadata(new TextEncoder().encode(s).length);
          cell += s;
        }
      },
      onclosetag(n) {
        content.close();
        if (specialDepth === tagDepth && n === specialTag) {
          if (payload) {
            payload.end();
            payload = undefined;
          }
          if (!jsonParts && !foundPlaywright && !foundJson && !scriptOversize) {
            const data = embeddedReport(scriptContent);
            if (data) {
              ctx.add({
                name,
                text: JSON.stringify(data),
                kind: "custom-html",
                warning:
                  "Extracted embedded JSON without executing report scripts.",
              });
              foundJson = true;
            }
          }
          scriptContent = "";
          if (jsonParts) {
            ctx.add({ name, text: jsonParts.join(""), kind: "custom-html" });
            foundJson = true;
            jsonParts = undefined;
          }
          specialTag = "";
          specialDepth = 0;
          candidate = false;
        }
        if (cell !== undefined && cellDepth === tagDepth && n === cellTag) {
          row.push(cell.replace(/\s+/g, " ").trim());
          cell = undefined;
        }
        if (n === "tr" && tableDepth === 1) finishRow();
        if (n === "table") tableDepth--;
        if (ignoredDepth === tagDepth) ignoredDepth = 0;
        tagDepth--;
      },
    },
    { decodeEntities: true },
  );
  return {
    push(b) {
      parser.write(decoder.decode(b, { stream: true }));
    },
    end() {
      parser.end(decoder.decode());
      if (foundPlaywright || foundJson) return;
      if (rows.length) {
        ctx.add({
          name,
          text: JSON.stringify({ tests: rows }),
          kind: "custom-html",
        });
        return;
      }
      const extracted = content.result();
      if (extracted.tests.length) {
        ctx.add({
          name,
          text: JSON.stringify({ tests: extracted.tests }),
          kind: "custom-html",
          warning:
            "Detected test records from HTML attributes/classes. Verify totals against the original report; unrecognized layouts may omit records.",
        });
        return;
      }
      // Allure's UI shell is resolved against companion test-case files after extraction.
      ctx.add({
        name,
        text: "",
        kind: "html-shell",
        group: name.includes("/")
          ? `${origin}::${name.slice(0, name.lastIndexOf("/"))}`
          : origin,
        warning: allure
          ? "Allure HTML requires its data/test-cases folder."
          : extracted.summaryOnly
            ? "Only summary counts were detected; individual test outcomes could not be verified."
            : "No supported embedded data, named test cards/lists, or test-result table found.",
      });
    },
  };
}
function reportSink(
  ctx: Context,
  name: string,
  origin: string,
  depth = 0,
): Sink {
  if (/\.zip$/i.test(name)) return archiveSink(ctx, origin, depth);
  if (/\.html?$/i.test(name)) return htmlSink(ctx, name, origin, depth);
  return textSink(ctx, (text) =>
    ctx.add({ name, text, group: groupFor(name, origin) }),
  );
}
export async function expandFiles(
  files: ReportFile[],
  limits: ImportLimits = defaultImportLimits,
  progress?: (p: ImportProgress) => void,
): Promise<InputFile[]> {
  files = files.filter(
    (f) => !ignored(f.name) && /\.(json|csv|html?|zip)$/i.test(f.name),
  );
  const ctx = new Context(limits, progress);
  ctx.totalBytes = files.reduce((n, f) => n + (f.size || 0), 0);
  if (ctx.totalBytes > limits.maxUploadBytes)
    throw new ImportLimitError(
      `Selected files exceed ${mb(limits.maxUploadBytes)}. Increase MAX_UPLOAD_MB on the Node server if needed.`,
    );
  for (const file of files) {
    if (ignored(file.name) || !/\.(json|csv|html?|zip)$/i.test(file.name))
      continue;
    ctx.entry();
    const origin = /\.zip$/i.test(file.name) ? file.name : "selected-files";
    const sink = reportSink(ctx, file.name, origin);
    const push = (b: Uint8Array) => {
      ctx.bytesRead += b.length;
      if (ctx.bytesRead > limits.maxUploadBytes)
        throw new ImportLimitError(
          `Import exceeds ${mb(limits.maxUploadBytes)}.`,
        );
      sink.push(b);
      progress?.({
        bytesRead: ctx.bytesRead,
        totalBytes: ctx.totalBytes,
        file: file.name,
      });
    };
    if (file.stream) {
      const reader = file.stream().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          push(value);
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      } finally {
        reader.releaseLock();
      }
    } else if (file.arrayBuffer) push(new Uint8Array(await file.arrayBuffer()));
    else throw Error(`Cannot read ${file.name}.`);
    sink.end();
  }
  return ctx.output;
}
