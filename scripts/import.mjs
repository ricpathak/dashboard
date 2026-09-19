import { readdir, stat } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { resolve, relative, basename } from "node:path";
const args = process.argv.slice(2);
let project = "",
  name = "",
  url = "http://127.0.0.1:3100";
const paths = [];
for (let i = 0; i < args.length; i++) {
  if (["--project", "--name", "--url"].includes(args[i])) {
    const key = args[i],
      value = args[++i];
    if (!value) throw Error(`Missing ${key} value`);
    if (key === "--project") project = value;
    else if (key === "--name") name = value;
    else url = value;
  } else paths.push(args[i]);
}
if (!paths.length) {
  console.error(
    "Usage: npm run import -- <report.html|report.zip|report.json|report-folder> [--project Name] [--name Run] [--url http://127.0.0.1:3100]",
  );
  process.exit(1);
}
const form = new FormData();
form.append("options", JSON.stringify({ project, name }));
let count = 0;
async function collect(path, root) {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const item of await readdir(path))
      if (
        ![
          "attachments",
          "history",
          "widgets",
          "traces",
          "node_modules",
        ].includes(item)
      )
        await collect(resolve(path, item), root);
  } else if (
    /\.(html?|json|csv|zip)$/i.test(path) &&
    !/-attachment\.json$/i.test(path)
  ) {
    form.append(
      "files",
      await openAsBlob(path),
      relative(root, path).replace(/\\/g, "/"),
    );
    count++;
  }
}
for (const p of paths) {
  const path = resolve(p);
  await collect(path, resolve(path, ".."));
}
if (!count) throw Error("No supported report files found.");
const response = await fetch(`${url.replace(/\/$/, "")}/api/import`, {
  method: "POST",
  body: form,
});
const result = await response.json();
if (!response.ok) throw Error(result.error);
console.log(JSON.stringify(result, null, 2));
