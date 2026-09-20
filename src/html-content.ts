// Conservative structural extraction: never execute report JavaScript.
const status = (value: string) => {
  const v = value.trim().toLowerCase();
  return /^(pass(?:ed)?|fail(?:ed)?|skip(?:ped)?|broken|pending|flaky|timedout|interrupted|unknown|success|error)$/.test(
    v,
  )
    ? v
    : "";
};
type Frame = {
  tag: string;
  text: string;
  field: string;
  candidate: boolean;
  name: string;
  status: string;
  project: string;
  childTest: boolean;
  ignore: boolean;
};
export function htmlContent() {
  const stack: Frame[] = [];
  const tests: Record<string, string>[] = [];
  let summaryText = "";
  return {
    open(tag: string, attrs: Record<string, string>) {
      const tokens = (attrs.class || "").toLowerCase().split(/\s+/);
      const candidate =
        !!attrs["data-test-name"] ||
        tokens.some((t) =>
          /^(test|test-case|testcase|test-result|test-item|test-card|scenario|scenario-result)$/.test(
            t,
          ),
        );
      const field = tokens.some((t) =>
        /^(test-name|test-title|testcase-name|scenario-name|name)$/.test(t),
      )
        ? "name"
        : tokens.some((t) =>
              /^(status|test-status|result|outcome|badge)$/.test(t),
            )
          ? "status"
          : tokens.some((t) => /^(project|project-name)$/.test(t))
            ? "project"
            : "";
      const declared =
        attrs["data-status"] ||
        attrs.status ||
        tokens.map(status).find(Boolean) ||
        "";
      stack.push({
        tag,
        text: "",
        field,
        candidate,
        name: attrs["data-test-name"] || "",
        status: status(declared),
        project: attrs["data-project"] || "",
        childTest: false,
        ignore:
          stack.at(-1)?.ignore ||
          ["script", "style", "svg", "template"].includes(tag) ||
          tokens.some((t) =>
            /^(step|test-step|steps|log|logs|attachment|attachments)$/.test(t),
          ) ||
          "hidden" in attrs ||
          attrs["aria-hidden"] === "true",
      });
    },
    text(value: string) {
      const f = stack.at(-1);
      if (f && !f.ignore) f.text = (f.text + value).slice(0, 4096);
    },
    close() {
      const f = stack.pop();
      if (!f || f.ignore) return;
      const parent = stack.at(-1);
      if (parent && !parent.ignore)
        parent.text = (parent.text + " " + f.text).slice(0, 4096);
      const owner = [...stack].reverse().find((n) => n.candidate && !n.ignore);
      if (owner && f.field) {
        const value = f.text.replace(/\s+/g, " ").trim();
        if (f.field === "name" && !owner.name) owner.name = value;
        if (f.field === "status" && !owner.status)
          owner.status = status(value) || f.status;
        if (f.field === "project" && !owner.project) owner.project = value;
      }
      if (owner && !f.candidate && f.status && !owner.status)
        owner.status = f.status;
      if (f.candidate) {
        if (owner) owner.childTest = true;
        if (!f.childTest && f.name && f.status) {
          if (tests.length >= 100000)
            throw Error("HTML contains too many test records.");
          tests.push({
            name: f.name,
            status: f.status,
            ...(f.project ? { project: f.project } : {}),
          });
        }
      }
      if (!parent) summaryText = f.text;
    },
    result() {
      return {
        tests,
        summaryOnly: /\b(total|passed|failed)\s*[:=]?\s*\d+/i.test(summaryText),
      };
    },
  };
}
export function embeddedReport(script: string): unknown | undefined {
  // Only JSON literals are accepted, including JSON assigned to common report variables.
  const value = script.trim().replace(/;\s*$/, "");
  const assignment = value.match(
    /^(?:(?:const|let|var)\s+|window\.)(?:reportData|testResults|testData|results|report)\s*=\s*([\s\S]+)$/,
  );
  try {
    const data = JSON.parse(assignment ? assignment[1] : value);
    const records = Array.isArray(data)
      ? data
      : data?.tests || data?.results || data?.testResults;
    if (
      Array.isArray(records) &&
      records.length &&
      records.every(
        (r: any) =>
          r &&
          typeof (r.name || r.title || r.testName) === "string" &&
          typeof r.status === "string",
      )
    )
      return {
        tests: records.map((r: any) => ({
          ...r,
          name: r.name || r.title || r.testName,
        })),
      };
  } catch {
    /* Application code, unrelated JSON and non-literal expressions are not report data. */
  }
}
