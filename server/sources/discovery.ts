import { posix } from "node:path";
import type { Bundle, SourceConfig, SourceEntry } from "./types.ts";
function matches(name: string, pattern: string) {
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          expression += "(?:.*/)?";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (c === "?") expression += "[^/]";
    else expression += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + expression + "$").test(name);
}
export function discover(entries: SourceEntry[], s: SourceConfig): Bundle[] {
  const groups = new Map<string, SourceEntry[]>();
  const claimed = new Set<string>();
  for (const e of entries) {
    const match = e.name.match(/^(.*\/)?data\/test-cases\/[^/]+\.json$/i);
    if (match) {
      const root = (match[1] || "").replace(/\/$/, "");
      const key = (root ? root + "/" : "") + "index.html";
      groups.set(key, [...(groups.get(key) || []), e]);
      claimed.add(e.name);
    } else if (/(?:^|\/)[^/]+-result\.json$/i.test(e.name)) {
      const dir = posix.dirname(e.name);
      const key = dir === "." ? "allure-results" : dir;
      groups.set(key, [...(groups.get(key) || []), e]);
      claimed.add(e.name);
    }
  }
  for (const [key, files] of groups) {
    const index = entries.find((e) => e.name === key);
    if (index) {
      files.push(index);
      claimed.add(index.name);
    }
  }
  for (const e of entries)
    if (
      !claimed.has(e.name) &&
      e.name.split("/").at(-1) !== s.completionMarker &&
      !/(?:^|\/)(?:data|allure-results)\//i.test(e.name) &&
      /\.(html?|json|csv|zip)$/i.test(e.name)
    )
      groups.set(e.name, [e]);
  return [...groups]
    .filter(
      ([key, files]) =>
        !s.include?.length ||
        s.include.some(
          (p) => matches(key, p) || files.some((f) => matches(f.name, p)),
        ),
    )
    .map(([key, files]) => {
      const dir = key.endsWith("index.html")
        ? posix.dirname(key)
        : files.length === 1 && !/-result\.json$/i.test(files[0].name)
          ? posix.dirname(key)
          : posix.dirname(files[0].name);
      const marker = s.completionMarker
        ? entries.find(
            (e) =>
              e.name === (dir === "." ? "" : dir + "/") + s.completionMarker,
          )
        : undefined;
      return {
        key,
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
        marker,
        options: {
          name: key,
          project:
            s.project ||
            (s.projectFromFolder && key.includes("/")
              ? key.split("/")[0]
              : undefined),
        },
        url: files.find((f) => f.name === key)?.url,
      };
    });
}
