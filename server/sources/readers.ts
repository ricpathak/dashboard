import { readdir, lstat, realpath } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { SourceConfig, SourceEntry, SourceReader } from "./types.ts";
const MAX_ENTRIES = 20000,
  MAX_DEPTH = 24;
const excludedDir = (name: string) =>
  [
    "attachments",
    "history",
    "widgets",
    "trace",
    "traces",
    "plugins",
    "node_modules",
    ".git",
  ].includes(name.toLowerCase());
function relevant(name: string, s: SourceConfig) {
  return (
    /\.(html?|json|csv|zip)$/i.test(name) ||
    name.split("/").at(-1) === s.completionMarker
  );
}
function version(size: number, modifiedAt: number) {
  return `${size}:${modifiedAt}`;
}
function envValue(name: string | undefined, fallback?: string): string {
  const key = name || fallback;
  const value = key ? process.env[key] : undefined;
  if (!value)
    throw Error(`Missing environment variable ${key || "(accessTokenEnv)"}.`);
  return value;
}
export function folderReader(s: SourceConfig): SourceReader {
  const base = resolve(s.path!);
  async function entry(path: string): Promise<SourceEntry> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("Report is not a regular file.");
    const actual = await realpath(path),
      root = await realpath(base);
    if (actual !== root && !actual.startsWith(root + sep))
      throw Error("Report path is outside the configured folder.");
    return {
      name: relative(base, path).split(sep).join("/"),
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      version: version(stat.size, stat.mtimeMs),
      locator: actual,
    };
  }
  return {
    async list() {
      const items: SourceEntry[] = [];
      let visited = 0;
      async function walk(path: string, depth: number) {
        if (depth > MAX_DEPTH)
          throw Error("Source folders exceed maximum depth.");
        for (const d of await readdir(path, { withFileTypes: true })) {
          if (++visited > MAX_ENTRIES)
            throw Error(
              "Source has too many entries; configure a narrower report folder.",
            );
          if (d.isSymbolicLink()) continue;
          const p = resolve(path, d.name);
          if (d.isDirectory() && !excludedDir(d.name)) await walk(p, depth + 1);
          else if (d.isFile() && relevant(d.name, s))
            items.push(await entry(p));
        }
      }
      await walk(base, 0);
      return items;
    },
    async open(e) {
      const current = await entry(resolve(base, e.name));
      if (current.version !== e.version)
        throw Error(
          "Report changed while being read; retry after copying finishes.",
        );
      const b = await openAsBlob(current.locator);
      return b.stream();
    },
    async unchanged(entries) {
      try {
        for (const e of entries)
          if ((await entry(resolve(base, e.name))).version !== e.version)
            return false;
        return true;
      } catch {
        return false;
      }
    },
  };
}
export interface RemoteRuntime {
  fetch: typeof fetch;
}
const timeout = () => AbortSignal.timeout(120000);
function safeUrl(value: string, origin?: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (origin && u.origin !== origin)
  )
    throw Error("Remote service returned an unexpected URL.");
  return u.href;
}
async function checkedJson(r: Response, service: string) {
  if (!r.ok) {
    await r.body?.cancel();
    throw Error(
      `${service} request failed (HTTP ${r.status}). Check source credentials and read permissions.`,
    );
  }
  const text = await r.text();
  if (text.length > 16 * 1024 ** 2)
    throw Error(`${service} listing is too large.`);
  try {
    return JSON.parse(text);
  } catch {
    throw Error(`${service} returned invalid JSON.`);
  }
}
function nameSegment(name: unknown): string {
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    /[\\/]/.test(name)
  )
    throw Error("Remote service returned an invalid filename.");
  return name;
}
export function graphReader(
  s: SourceConfig,
  runtime: RemoteRuntime = { fetch },
): SourceReader {
  let token = "",
    expires = 0;
  async function auth() {
    if (s.accessTokenEnv) return envValue(s.accessTokenEnv);
    if (token && Date.now() < expires) return token;
    const tenant = envValue(s.tenantIdEnv, "SP_TENANT_ID");
    const client = envValue(s.clientIdEnv, "SP_CLIENT_ID");
    const secret = envValue(s.clientSecretEnv, "SP_CLIENT_SECRET");
    const data = await checkedJson(
      await runtime.fetch(
        `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: client,
            client_secret: secret,
            scope: "https://graph.microsoft.com/.default",
            grant_type: "client_credentials",
          }),
          redirect: "error",
          signal: timeout(),
        },
      ),
      "Microsoft sign-in",
    );
    if (typeof data.access_token !== "string")
      throw Error("Microsoft sign-in returned no access token.");
    token = data.access_token;
    expires = Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60000;
    return token;
  }
  const itemUrl = (id: string) =>
    `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(s.driveId!)}/items/${encodeURIComponent(id)}`;
  async function api(url: string) {
    return checkedJson(
      await runtime.fetch(safeUrl(url, "https://graph.microsoft.com"), {
        headers: { Authorization: `Bearer ${await auth()}` },
        redirect: "error",
        signal: timeout(),
      }),
      "Microsoft Graph",
    );
  }
  const from = (d: any, name: string): SourceEntry => ({
    name,
    size: Number(d.size) || 0,
    modifiedAt: Date.parse(d.lastModifiedDateTime) || 0,
    version: String(
      d.eTag ||
        version(Number(d.size) || 0, Date.parse(d.lastModifiedDateTime) || 0),
    ),
    url: typeof d.webUrl === "string" ? safeUrl(d.webUrl) : undefined,
    locator: String(d.id),
  });
  return {
    async list() {
      const files: SourceEntry[] = [];
      const seen = new Set<string>();
      let visited = 0;
      async function walk(id: string, path: string, depth: number) {
        if (depth > MAX_DEPTH)
          throw Error("SharePoint folders exceed maximum depth.");
        let url: string | undefined =
          itemUrl(id) +
          "/children?$top=200&$select=id,name,size,eTag,lastModifiedDateTime,webUrl,folder,file";
        while (url) {
          if (seen.has(url))
            throw Error("SharePoint returned repeated pagination.");
          seen.add(url);
          const data = await api(url);
          if (!Array.isArray(data.value))
            throw Error("SharePoint returned an invalid folder listing.");
          for (const d of data.value) {
            if (++visited > MAX_ENTRIES)
              throw Error(
                "SharePoint source has too many entries. Configure a narrower folder.",
              );
            const name = nameSegment(d.name);
            const relative = path ? `${path}/${name}` : name;
            if (d.folder && !excludedDir(name))
              await walk(String(d.id), relative, depth + 1);
            else if (d.file && relevant(name, s)) files.push(from(d, relative));
          }
          url = data["@odata.nextLink"];
        }
      }
      await walk(s.folderId!, "", 0);
      return files;
    },
    async open(e) {
      const r = await runtime.fetch(itemUrl(e.locator) + "/content", {
        headers: {
          Authorization: `Bearer ${await auth()}`,
          ...(e.version.startsWith("W/") || e.version.startsWith('"')
            ? { "If-Match": e.version }
            : {}),
        },
        redirect: "manual",
        signal: timeout(),
      });
      if (r.status === 302) {
        const location = r.headers.get("location");
        await r.body?.cancel();
        if (!location) throw Error("SharePoint download URL is missing.");
        const download = await runtime.fetch(safeUrl(location), {
          redirect: "error",
          signal: timeout(),
        });
        if (!download.ok || !download.body) {
          await download.body?.cancel();
          throw Error(`SharePoint download failed (HTTP ${download.status}).`);
        }
        return download.body;
      }
      if (!r.ok || !r.body) {
        await r.body?.cancel();
        throw Error(`SharePoint download failed (HTTP ${r.status}).`);
      }
      return r.body;
    },
    async unchanged(entries) {
      for (const e of entries) {
        const d = await api(
          itemUrl(e.locator) + "?$select=id,size,eTag,lastModifiedDateTime",
        );
        if (from(d, e.name).version !== e.version) return false;
      }
      return true;
    },
  };
}
export function restReader(
  s: SourceConfig,
  runtime: RemoteRuntime = { fetch },
): SourceReader {
  const site = s.siteUrl!.replace(/\/$/, "");
  const origin = new URL(site).origin;
  const literal = (value: string) =>
    encodeURIComponent(value.replace(/'/g, "''")).replace(/'/g, "%27");
  const folderUrl = (path: string) =>
    `${site}/_api/web/GetFolderByServerRelativeUrl('${literal(path)}')`;
  const fileUrl = (path: string) =>
    `${site}/_api/web/GetFileByServerRelativeUrl('${literal(path)}')`;
  function headers() {
    return {
      Authorization: `Bearer ${envValue(s.accessTokenEnv)}`,
      Accept: "application/json;odata=nometadata",
    };
  }
  async function api(url: string) {
    return checkedJson(
      await runtime.fetch(safeUrl(url, origin), {
        headers: headers(),
        redirect: "error",
        signal: timeout(),
      }),
      "SharePoint REST",
    );
  }
  const from = (d: any, name: string): SourceEntry => ({
    name,
    size: Number(d.Length) || 0,
    modifiedAt: Date.parse(d.TimeLastModified) || 0,
    version: String(
      d.ETag ||
        version(Number(d.Length) || 0, Date.parse(d.TimeLastModified) || 0),
    ),
    url: new URL(d.ServerRelativeUrl, origin).href,
    locator: String(d.ServerRelativeUrl),
  });
  return {
    async list() {
      const files: SourceEntry[] = [];
      let visited = 0;
      const pages = new Set<string>();
      async function collection(url: string) {
        const rows: any[] = [];
        let next: string | undefined = url;
        while (next) {
          if (pages.has(next))
            throw Error("SharePoint returned repeated pagination.");
          pages.add(next);
          const data = await api(next);
          const values = data.value || data.d?.results;
          if (!Array.isArray(values))
            throw Error("SharePoint REST returned an invalid listing.");
          visited += values.length;
          if (visited > MAX_ENTRIES)
            throw Error(
              "SharePoint source has too many entries. Configure a narrower folder.",
            );
          rows.push(...values);
          const n =
            data["@odata.nextLink"] || data["odata.nextLink"] || data.d?.__next;
          next = n ? new URL(n, site + "/").href : undefined;
        }
        return rows;
      }
      async function walk(path: string, prefix: string, depth: number) {
        if (depth > MAX_DEPTH)
          throw Error("SharePoint folders exceed maximum depth.");
        for (const d of await collection(
          folderUrl(path) +
            "/Files?$select=Name,ServerRelativeUrl,Length,TimeLastModified,ETag",
        )) {
          const name = nameSegment(d.Name);
          if (relevant(name, s))
            files.push(from(d, prefix ? `${prefix}/${name}` : name));
        }
        for (const d of await collection(
          folderUrl(path) + "/Folders?$select=Name,ServerRelativeUrl",
        )) {
          const name = nameSegment(d.Name);
          if (!excludedDir(name) && name !== "Forms")
            await walk(
              String(d.ServerRelativeUrl),
              prefix ? `${prefix}/${name}` : name,
              depth + 1,
            );
        }
      }
      await walk(s.folderServerRelativeUrl!, "", 0);
      return files;
    },
    async open(e) {
      const r = await runtime.fetch(fileUrl(e.locator) + "/$value", {
        headers: {
          ...headers(),
          ...(e.version.startsWith("W/") || e.version.startsWith('"')
            ? { "If-Match": e.version }
            : {}),
        },
        redirect: "error",
        signal: timeout(),
      });
      if (!r.ok || !r.body) {
        await r.body?.cancel();
        throw Error(
          `SharePoint REST download failed (HTTP ${r.status}). This connector requires bearer authentication; for Windows integrated authentication use a synced or mounted folder.`,
        );
      }
      return r.body;
    },
    async unchanged(entries) {
      for (const e of entries) {
        const data = await api(
          fileUrl(e.locator) +
            "?$select=Name,ServerRelativeUrl,Length,TimeLastModified,ETag",
        );
        if (from(data.d || data, e.name).version !== e.version) return false;
      }
      return true;
    },
  };
}
export function createReader(s: SourceConfig): SourceReader {
  return s.type === "folder"
    ? folderReader(s)
    : s.type === "sharepoint-online"
      ? graphReader(s)
      : restReader(s);
}
