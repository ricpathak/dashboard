import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
const args = process.argv.slice(2);
let project = "",
  name = "",
  url = "http://127.0.0.1:3100";
const paths = [];
for (let i = 0; i < args.length; i++) {
  if (["--project", "--name", "--url"].includes(args[i])) {
    const key = args[i];
    const value = args[++i];
    if (!value) throw Error(`Missing ${key} value`);
    if (key === "--project") project = value;
    else if (key === "--name") name = value;
    else url = value;
  } else paths.push(args[i]);
}
if (!paths.length) {
  console.error(
    "Usage: npm run import -- <report.json|report.csv|allure-results-folder> [--project Name] [--name Run] [--url http://127.0.0.1:3100]",
  );
  process.exit(1);
}
const files = [];
async function collect(path) {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const item of await readdir(path)) await collect(resolve(path, item));
  } else if ([".json", ".csv"].includes(extname(path).toLowerCase()))
    files.push({ name: path, text: await readFile(path, "utf8") });
}
for (const p of paths) await collect(resolve(p));
const response = await fetch(`${url.replace(/\/$/, "")}/api/import`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ files, options: { project, name } }),
});
const result = await response.json();
if (!response.ok) throw Error(result.error);
console.log(JSON.stringify(result, null, 2));
