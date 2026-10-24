// Verify the check.mjs hardening against the exact attacks R2 reported.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");

let failures = 0;
const report = (l = "") => process.stdout.write(`${l}\n`);
const check = (label, ok, detail) => {
  if (ok) report(`ok    ${label}`);
  else {
    failures++;
    report(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

function runCheckOn(dir) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "tools", "check.mjs")], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, VCAPTIONS_DIST: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function scenario(name, mutate, expectFail = true) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "check-attack-"));
  try {
    fs.cpSync(DIST, scratch, { recursive: true });
    mutate(scratch);
    const r = runCheckOn(scratch);
    const ok = expectFail ? r.code !== 0 : r.code === 0;
    check(name, ok, ok ? undefined : r.out.split("\n").find((l) => l.includes("FAIL")) ?? `exit=${r.code}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const editManifest = (dir, fn) => {
  const p = path.join(dir, "manifest.json");
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  fn(m);
  fs.writeFileSync(p, JSON.stringify(m, null, 2), "utf8");
};

report("=== check.mjs hardening (R2 attacks) ===\n");

scenario("baseline passes", () => {}, false);

// R2: deleting whole manifest sections left nothing to check.
scenario("missing background section", (d) => editManifest(d, (m) => delete m.background));
scenario("missing side_panel section", (d) => editManifest(d, (m) => delete m.side_panel));
scenario("missing content_scripts", (d) => editManifest(d, (m) => delete m.content_scripts));
scenario("missing options_ui and options_page", (d) =>
  editManifest(d, (m) => {
    delete m.options_ui;
    delete m.options_page;
  }),
);

// R2: the *.css glob passed as long as one css existed.
scenario("deleting daisyui.css", (d) => fs.rmSync(path.join(d, "daisyui.css")));
scenario("deleting style.css", (d) => fs.rmSync(path.join(d, "style.css")));
scenario("deleting subtitleBar.css", (d) => fs.rmSync(path.join(d, "subtitleBar.css")));

// R2: a traversal pattern resolved outside dist.
scenario("WAR path traversal", (d) =>
  editManifest(d, (m) => {
    m.web_accessible_resources = [{ resources: ["../package.json"], matches: ["<all_urls>"] }];
  }),
);

// R2: malformed permission variants slipped past the whitelist.
scenario("permission with stray slash", (d) =>
  editManifest(d, (m) => {
    m.permissions = m.permissions.map((p) => (p === "storage" ? "storage/" : p));
  }),
);
scenario("permission with stray colon-star", (d) =>
  editManifest(d, (m) => {
    m.permissions = m.permissions.map((p) => (p === "storage" ? "storage:*" : p));
  }),
);

report(`\n${failures === 0 ? "check hardening verified" : `${failures} problem(s) found`}`);
process.exit(failures === 0 ? 0 : 1);
