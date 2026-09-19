import busboy from "busboy";
import type { IncomingMessage } from "node:http";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import {
  expandFiles,
  ImportLimitError,
  defaultImportLimits,
  type ImportLimits,
} from "../src/import-files.ts";
import type { ImportOptions, InputFile } from "../src/model.ts";

function positiveMB(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0)
    throw Error(`${name} must be a positive number of MB.`);
  return Math.floor(n * 1024 ** 2);
}
export const importLimits: ImportLimits = {
  ...defaultImportLimits,
  maxUploadBytes: positiveMB(
    "MAX_UPLOAD_MB",
    defaultImportLimits.maxUploadBytes,
  ),
  maxMetadataBytes: positiveMB(
    "MAX_METADATA_MB",
    defaultImportLimits.maxMetadataBytes,
  ),
};
export function validateOptions(options: unknown): ImportOptions {
  if (options === undefined) return {};
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw Error("options must be an object.");
  const o = options as ImportOptions;
  for (const field of ["name", "project"] as const)
    if (o[field] !== undefined && typeof o[field] !== "string")
      throw Error(`${field} must be text.`);
  if (o.mapping !== undefined) {
    if (!o.mapping || typeof o.mapping !== "object" || Array.isArray(o.mapping))
      throw Error("mapping must be an object.");
    for (const [key, value] of Object.entries(o.mapping)) {
      if (typeof value !== "string")
        throw Error(`mapping.${key} must be text.`);
    }
    if (o.mapping.durationUnit && !["ms", "s"].includes(o.mapping.durationUnit))
      throw Error("Invalid duration unit.");
  }
  return o;
}
export async function multipartReports(
  req: IncomingMessage,
): Promise<{ files: InputFile[]; options: ImportOptions }> {
  const dir = await mkdtemp(join(tmpdir(), "report-hub-upload-"));
  const pending: Promise<unknown>[] = [];
  const stored: { path: string; name: string }[] = [];
  let optionText = "{}",
    failure: Error | undefined,
    size = 0;
  try {
    const parser = busboy({
      headers: req.headers,
      preservePath: true,
      limits: {
        fileSize: importLimits.maxUploadBytes,
        files: importLimits.maxFiles,
        fields: 1,
        fieldSize: 64 * 1024,
        parts: importLimits.maxFiles + 1,
      },
    });
    parser.on("field", (name, value, info) => {
      if (name !== "options") {
        failure = Error(`Unexpected field: ${name}`);
        return;
      }
      if (info.valueTruncated)
        failure = new ImportLimitError("Import options are too large.");
      optionText = value;
    });
    parser.on("file", (_field, file, info) => {
      const path = join(dir, String(stored.length));
      stored.push({ path, name: info.filename.replace(/\\/g, "/") });
      file.on("limit", () => {
        failure = new ImportLimitError(
          `File exceeds MAX_UPLOAD_MB (${importLimits.maxUploadBytes / 1024 ** 2} MB).`,
        );
      });
      pending.push(
        pipeline(file, createWriteStream(path, { flags: "wx" })).catch((e) => {
          failure = e;
        }),
      );
    });
    for (const event of ["filesLimit", "fieldsLimit", "partsLimit"])
      parser.on(event, () => {
        failure = new ImportLimitError(
          "Too many files or fields in this import.",
        );
      });
    const meter = new Transform({
      transform(chunk, _encoding, cb) {
        size += chunk.length;
        if (size > importLimits.maxUploadBytes + 1024 ** 2)
          cb(
            new ImportLimitError(
              `Upload exceeds MAX_UPLOAD_MB (${importLimits.maxUploadBytes / 1024 ** 2} MB).`,
            ),
          );
        else cb(null, chunk);
      },
    });
    // Keep req outside pipeline so a limit error can still return an HTTP 413 body.
    req.pipe(meter);
    req.on("aborted", () => meter.destroy(Error("Upload cancelled.")));
    req.on("error", (e) => meter.destroy(e));
    try {
      await pipeline(meter, parser);
    } catch (e) {
      req.unpipe(meter);
      req.resume();
      throw e;
    }
    await Promise.all(pending);
    if (failure) throw failure;
    const options = validateOptions(JSON.parse(optionText));
    const input = [];
    for (const f of stored) {
      const blob = await openAsBlob(f.path);
      input.push({
        name: f.name,
        size: blob.size,
        stream: () => blob.stream(),
      });
    }
    const files = await expandFiles(input, importLimits);
    return { files, options };
  } finally {
    await Promise.all(pending);
    await rm(dir, { recursive: true, force: true });
  }
}
