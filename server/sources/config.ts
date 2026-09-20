import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { SourceConfig } from "./types.ts";
export function loadSources(root: string): SourceConfig[] {
  const path = resolve(
    process.env.SOURCES_CONFIG || resolve(root, "sources.config.json"),
  );
  let configs: unknown;
  if (existsSync(path)) {
    const value = JSON.parse(readFileSync(path, "utf8"));
    configs = value.sources;
  } else {
    if (process.env.SOURCES_CONFIG)
      throw Error("SOURCES_CONFIG file does not exist.");
    const inbox = process.env.REPORTS_DIR || resolve(root, "report-inbox");
    if (!process.env.REPORTS_DIR) mkdirSync(inbox, { recursive: true });
    configs = [
      {
        id: "local-inbox",
        label: "Local report inbox",
        type: "folder",
        path: inbox,
        pollSeconds: 60,
        settleSeconds: 30,
      },
    ];
  }
  if (!Array.isArray(configs) || configs.length > 50)
    throw Error("sources must be an array with at most 50 entries.");
  const ids = new Set<string>();
  return configs.map((raw) => {
    if (!raw || typeof raw !== "object")
      throw Error("Invalid source configuration.");
    const s = { ...raw } as SourceConfig;
    if (
      typeof s.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(s.id) ||
      ids.has(s.id)
    )
      throw Error("Each source needs a unique alphanumeric id.");
    ids.add(s.id);
    if (typeof s.label !== "string" || !s.label.trim())
      throw Error(`Source ${s.id}: label is required.`);
    if (!["folder", "sharepoint-online", "sharepoint-rest"].includes(s.type))
      throw Error(`Source ${s.id}: unsupported type.`);
    for (const k of ["pollSeconds", "settleSeconds"] as const) {
      const n = s[k] ?? (k === "pollSeconds" ? 60 : 30);
      if (
        !Number.isFinite(n) ||
        n < 0 ||
        (k === "pollSeconds" && n > 0 && n < 10)
      )
        throw Error(
          `${s.id}: ${k} must be non-negative; polling must be zero or at least 10 seconds.`,
        );
      s[k] = n;
    }
    if (
      s.completionMarker !== undefined &&
      (typeof s.completionMarker !== "string" ||
        !s.completionMarker ||
        /[\\/]/.test(s.completionMarker) ||
        [".", ".."].includes(s.completionMarker))
    )
      throw Error(`${s.id}: completionMarker must be a filename.`);
    if (
      s.include !== undefined &&
      (!Array.isArray(s.include) ||
        s.include.some((p) => typeof p !== "string" || p.length > 500))
    )
      throw Error(`${s.id}: include must contain glob strings.`);
    for (const k of [
      "project",
      "path",
      "driveId",
      "folderId",
      "siteUrl",
      "folderServerRelativeUrl",
      "tenantIdEnv",
      "clientIdEnv",
      "clientSecretEnv",
      "accessTokenEnv",
    ] as const)
      if (s[k] !== undefined && typeof s[k] !== "string")
        throw Error(`${s.id}: ${k} must be text.`);
    for (const k of ["enabled", "projectFromFolder"] as const)
      if (s[k] !== undefined && typeof s[k] !== "boolean")
        throw Error(`${s.id}: ${k} must be true or false.`);
    if (s.type === "folder") {
      if (!s.path) throw Error(`${s.id}: folder path is required.`);
      s.path = isAbsolute(s.path) ? s.path : resolve(root, s.path);
    }
    if (s.type === "sharepoint-online" && (!s.driveId || !s.folderId))
      throw Error(`${s.id}: driveId and folderId are required.`);
    if (s.type === "sharepoint-rest") {
      if (!s.siteUrl || !s.folderServerRelativeUrl)
        throw Error(
          `${s.id}: siteUrl and folderServerRelativeUrl are required.`,
        );
      const u = new URL(s.siteUrl);
      if (u.protocol !== "https:" || u.username || u.password)
        throw Error(
          `${s.id}: use an HTTPS site URL without embedded credentials.`,
        );
      if (!s.folderServerRelativeUrl.startsWith("/"))
        throw Error(`${s.id}: folderServerRelativeUrl must start with /.`);
    }
    return s;
  });
}
