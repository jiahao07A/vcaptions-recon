#!/usr/bin/env node
/**
 * Validator effectiveness test.
 *
 * A validator that always passes is worse than no validator. This test breaks the
 * build output in specific ways and asserts that `tools/check.mjs` notices each
 * one. It runs against a temporary copy of dist/ so the real tree is never
 * touched.
 *
 * Usage: node tests/validator.check.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");

let failures = 0;
const report = (line = "") => process.stdout.write(`${line}\n`);
const check = (label, ok, detail) => {
  if (ok) report(`ok    ${label}`);
  else {
    failures++;
    report(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/** Run check.mjs against an arbitrary dist directory. */
function runCheckOn(dir) {
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT, "tools", "check.mjs")],
      { encoding: "utf8", cwd: ROOT, env: { ...process.env, VCAPTIONS_DIST: dir } },
    );
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** Apply a mutation to a scratch copy, run the validator, restore nothing. */
function scenario(name, mutate, expectFail = true) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vcaptions-check-"));
  try {
    copyTree(DIST, scratch);
    mutate(scratch);
    const r = runCheckOn(scratch);
    const failed = r.code !== 0;
    const ok = expectFail ? failed : !failed;
    check(name, ok, ok ? undefined : failed ? "validator rejected a valid tree" : "validator missed it");
    if (expectFail && failed) {
      const line = r.out.split("\n").find((l) => l.includes("FAIL"));
      if (line) report(`        ${line.trim().slice(0, 120)}`);
    }
    return ok;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  if (!fs.existsSync(path.join(DIST, "manifest.json"))) {
    report("dist/ missing; run `npm run build` first");
    process.exit(2);
  }

  report("validator effectiveness\n");

  scenario("accepts a clean build", () => {}, false);

  scenario("catches missing default locale", (d) => {
    fs.rmSync(path.join(d, "_locales", "en", "messages.json"));
  });

  scenario("catches invalid locale JSON", (d) => {
    fs.writeFileSync(path.join(d, "_locales", "en", "messages.json"), "{ not json");
  });

  scenario("catches missing content script bundle", (d) => {
    fs.rmSync(path.join(d, "MainCS.277dcde3.js"));
  });

  scenario("catches missing service worker", (d) => {
    fs.rmSync(path.join(d, "static", "background", "index.js"));
  });

  scenario("catches syntax error in bundle", (d) => {
    fs.writeFileSync(path.join(d, "WebappCS.8b5d7cd6.js"), "this is not javascript(((");
  });

  scenario("catches missing stylesheet referenced by HTML", (d) => {
    fs.rmSync(path.join(d, "tabs", "tab-main.64262913.css"));
  });

  scenario("catches manifest referencing missing icon", (d) => {
    const p = path.join(d, "manifest.json");
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.icons["256"] = "icon256.missing.png";
    fs.writeFileSync(p, JSON.stringify(m, null, 2));
  });

  scenario("catches undefined i18n key in manifest", (d) => {
    const p = path.join(d, "manifest.json");
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.description = "__MSG_doesNotExist__";
    fs.writeFileSync(p, JSON.stringify(m, null, 2));
  });

  scenario("catches missing side panel page", (d) => {
    fs.rmSync(path.join(d, "sidepanel.html"));
  });

  // ---------------------------------------------------------------------
  // The scenarios above predate most of check.mjs's rules. A meta-test only
  // guards the rules it actually exercises, so each rule below gets a scenario
  // that must fail. Coverage is the point: an unexercised rule can silently
  // become a no-op and nothing would notice.
  // ---------------------------------------------------------------------

  const editManifest = (d, fn) => {
    const p = path.join(d, "manifest.json");
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    fn(m);
    fs.writeFileSync(p, JSON.stringify(m, null, 2), "utf8");
  };

  // Rule: manifest_version must be 3.
  scenario("catches manifest_version 2", (d) =>
    editManifest(d, (m) => {
      m.manifest_version = 2;
    }),
  );

  // Rule: version must be 1-4 dot-separated integers.
  scenario("catches malformed version", (d) =>
    editManifest(d, (m) => {
      m.version = "2.4.6.1.2";
    }),
  );

  // Rule: permission names must be recognised.
  scenario("catches misspelled permission", (d) =>
    editManifest(d, (m) => {
      m.permissions = m.permissions.map((p) => (p === "storage" ? "stoarge" : p));
    }),
  );

  // Rule: a permission may not carry a stray suffix that looks like a pattern.
  scenario("catches permission with stray colon", (d) =>
    editManifest(d, (m) => {
      m.permissions = m.permissions.map((p) => (p === "storage" ? "storage:*" : p));
    }),
  );

  // Rule: code that uses chrome.X must declare the matching permission.
  scenario("catches missing permission for a used API", (d) =>
    editManifest(d, (m) => {
      m.permissions = m.permissions.filter((p) => p !== "scripting");
    }),
  );

  // Rule: content_scripts match patterns must be well-formed.
  scenario("catches invalid match pattern", (d) =>
    editManifest(d, (m) => {
      m.content_scripts[0].matches = ["https://*.example.com"];
    }),
  );

  // Rule: web_accessible_resources patterns must match at least one file.
  scenario("catches WAR pattern matching nothing", (d) =>
    editManifest(d, (m) => {
      m.web_accessible_resources = [{ resources: ["*.nonexistent"], matches: ["<all_urls>"] }];
    }),
  );

  // Rule: WAR patterns may not escape the package.
  scenario("catches WAR path traversal", (d) =>
    editManifest(d, (m) => {
      m.web_accessible_resources = [{ resources: ["../package.json"], matches: ["<all_urls>"] }];
    }),
  );

  // Rule: the three runtime stylesheets must be present regardless of the glob.
  scenario("catches missing runtime stylesheet", (d) => {
    fs.rmSync(path.join(d, "daisyui.css"));
  });

  // Rule: required manifest sections must exist (existence checks alone are
  // one-directional — deleting a section removes its references too).
  scenario("catches missing background section", (d) =>
    editManifest(d, (m) => {
      delete m.background;
    }),
  );
  scenario("catches missing side_panel section", (d) =>
    editManifest(d, (m) => {
      delete m.side_panel;
    }),
  );
  scenario("catches missing content_scripts", (d) =>
    editManifest(d, (m) => {
      delete m.content_scripts;
    }),
  );

  // Rule: every JavaScript file in the package must parse, not only the ones the
  // manifest names directly.
  scenario("catches syntax error in an unreferenced bundle", (d) => {
    fs.writeFileSync(path.join(d, "WebappCS.8b5d7cd6.js"), "SYNTAX ERROR (((");
  });

  report(`\n${failures === 0 ? "validator check passed" : `${failures} problem(s) found`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
