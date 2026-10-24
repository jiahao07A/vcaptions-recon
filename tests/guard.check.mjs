#!/usr/bin/env node
/**
 * Guard regression test for the re-split safety checks.
 *
 * Covers the two P0 defects found in round-1 review:
 *
 *   P0-A  `verify()` was tautological — it accepted any split, even one whose
 *         module boundaries were completely wrong, because it only compared
 *         "concatenate the parts" against the original.
 *   P0-B  Hand-edit detection silently disabled itself when `modules.json` or
 *         `index.json` was missing, so edits were overwritten with exit code 0.
 *
 * Each case asserts the guard fires. A passing test means a broken tree is
 * rejected, not merely that a good tree is accepted.
 *
 * Usage: node tests/guard.check.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE = path.join(ROOT, "assets", "baseline", "extension-v2.4.6");
const SPLITTER = path.join(ROOT, "tools", "parcel-split.mjs");
const BUNDLE = "WebappCS.8b5d7cd6";
const SRC_DIR = path.join(ROOT, "src", "bundles", BUNDLE);

let failures = 0;
const report = (line = "") => process.stdout.write(`${line}\n`);
const check = (label, ok, detail) => {
  if (ok) report(`ok    ${label}`);
  else {
    failures++;
    report(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

function run(script, args, cwd = ROOT) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** Build a scratch split of the bundle, then let `mutate` corrupt it. */
function scratchSplit(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  copyDir(SRC_DIR, dir);
  if (mutate) mutate(dir);
  return dir;
}

function main() {
  report("=== P0-A: verify must reject wrong module boundaries ===\n");

  // Baseline: the real split passes.
  {
    const r = run(SPLITTER, [path.join(BASELINE, `${BUNDLE}.js`), SRC_DIR, "--check"]);
    check("pristine split passes --check", r.code === 0, r.out.trim().split("\n")[0]);
  }

  // Case A1: module body moved into the separator, module file left empty.
  {
    const dir = scratchSplit((d) => {
      const manPath = path.join(d, "modules.json");
      const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
      const m = man.modules[0];
      const raw = fs.readFileSync(path.join(d, m.file), "utf8");
      const nl = raw.indexOf("\n");
      man.modules[0].separator_after = raw.slice(nl + 1) + (m.separator_after || "");
      fs.writeFileSync(path.join(d, m.file), raw.slice(0, nl + 1), "utf8");
      fs.writeFileSync(manPath, JSON.stringify(man, null, 2), "utf8");
    });
    const r = run(SPLITTER, [path.join(BASELINE, `${BUNDLE}.js`), dir, "--check"]);
    check("rejects module body moved into separator", r.code !== 0, `exit=${r.code}`);
    check(
      "names the offending module",
      r.out.includes("hEvvs"),
      r.out.split("\n").find((l) => l.includes("differs")) ?? "",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Case A2: a module file deleted entirely.
  {
    const dir = scratchSplit((d) => {
      const man = JSON.parse(fs.readFileSync(path.join(d, "modules.json"), "utf8"));
      fs.rmSync(path.join(d, man.modules[0].file));
    });
    const r = run(SPLITTER, [path.join(BASELINE, `${BUNDLE}.js`), dir, "--check"]);
    check("rejects a deleted module file", r.code !== 0, `exit=${r.code}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Case A3: module source altered by one byte.
  {
    const dir = scratchSplit((d) => {
      const man = JSON.parse(fs.readFileSync(path.join(d, "modules.json"), "utf8"));
      const f = path.join(d, man.modules[0].file);
      const raw = fs.readFileSync(f, "utf8");
      const nl = raw.indexOf("\n");
      const body = raw.slice(nl + 1);
      fs.writeFileSync(f, raw.slice(0, nl + 1) + body.replace("function", "functioN"), "utf8");
    });
    const r = run(SPLITTER, [path.join(BASELINE, `${BUNDLE}.js`), dir, "--check"]);
    check("rejects a one-byte module edit", r.code !== 0, `exit=${r.code}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Case A4: epilogue altered.
  {
    const dir = scratchSplit((d) => {
      const f = path.join(d, "epilogue.js");
      fs.writeFileSync(f, `${fs.readFileSync(f, "utf8")}/*x*/`, "utf8");
    });
    const r = run(SPLITTER, [path.join(BASELINE, `${BUNDLE}.js`), dir, "--check"]);
    check("rejects an epilogue edit", r.code !== 0, `exit=${r.code}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  report("\n=== P0-B: re-split must refuse when it cannot prove the tree is clean ===\n");

  const epilogue = path.join(SRC_DIR, "epilogue.js");
  const manifest = path.join(SRC_DIR, "modules.json");
  const originalEpi = fs.readFileSync(epilogue, "utf8");
  const manifestBackup = fs.readFileSync(manifest, "utf8");

  try {
    // Case B1: hand edit is refused.
    fs.writeFileSync(
      epilogue,
      originalEpi.replace('this.info("WebappCS', 'this.info("GUARD-PROOF WebappCS'),
      "utf8",
    );
    {
      const r = run(path.join(ROOT, "tools", "reconstruct.mjs"), ["--verify"]);
      check("refuses to overwrite a hand edit", r.code !== 0, `exit=${r.code}`);
      check("names the edited file", r.out.includes("epilogue.js"));
      check("edit survives the refusal", fs.readFileSync(epilogue, "utf8").includes("GUARD-PROOF"));
    }

    // Case B2: missing modules.json must also refuse (this was the silent hole).
    fs.writeFileSync(epilogue, originalEpi, "utf8");
    fs.rmSync(manifest);
    {
      const r = run(path.join(ROOT, "tools", "reconstruct.mjs"), ["--verify"]);
      check("refuses when modules.json is missing", r.code !== 0, `exit=${r.code}`);
      check(
        "explains why it cannot verify",
        /cannot verify|missing|not valid JSON/i.test(r.out),
        r.out.split("\n").find((l) => l.includes("modules.json")) ?? "",
      );
    }

    // Case B3: corrupt modules.json must also refuse.
    fs.writeFileSync(manifest, "{ not json", "utf8");
    {
      const r = run(path.join(ROOT, "tools", "reconstruct.mjs"), ["--verify"]);
      check("refuses when modules.json is corrupt", r.code !== 0, `exit=${r.code}`);
    }
  } finally {
    fs.writeFileSync(epilogue, originalEpi, "utf8");
    fs.writeFileSync(manifest, manifestBackup, "utf8");
  }

  // Restored tree must verify again.
  {
    const r = run(path.join(ROOT, "tools", "reconstruct.mjs"), ["--verify"]);
    check("restored tree verifies clean", r.code === 0, r.out.trim().split("\n").slice(-1)[0]);
  }

  report(`\n${failures === 0 ? "guard check passed" : `${failures} problem(s) found`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
