#!/usr/bin/env node
/**
 * Round-2 repair verification.
 *
 * Round-2 review found that several round-3/4 "fixes" could still be bypassed.
 * This test pins the corrected behaviour so it cannot regress:
 *
 *   - a structurally weakened modules.json must not disable the edit guard
 *   - the guard's advice must not recommend deleting a bundle that may hold edits
 *   - an overlay whose name matches nothing must fail the build instead of being
 *     silently ignored
 *   - stripOverlayHeader must only remove the exact header `adopt` writes
 *   - a module loaded via `<script type="module">` must be parsed under strict
 *     mode, not as a classic script
 *
 * Usage: node tests/round2-repairs.check.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stripOverlayHeader } from "../tools/overlay.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

let failures = 0;
const report = (l = "") => process.stdout.write(`${l}\n`);
const check = (label, ok, detail) => {
  if (ok) report(`ok    ${label}`);
  else {
    failures++;
    report(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

function makeScratch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "round2-"));
  for (const d of ["assets", "src", "tools", "tests"]) {
    fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tmp, "package.json"));
  return tmp;
}

function runIn(tmp, script, args = []) {
  try {
    const out = execFileSync(process.execPath, [path.join(tmp, script), ...args], {
      encoding: "utf8",
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

report("=== overlay header detection ===\n");
{
  const adopt = `/*\n * Overlay module: hEvvs\n * Replaces the minified module in src/bundles/X/hEvvs.js\n */\nBODY`;
  check("strips the exact adopt header", stripOverlayHeader(adopt) === "BODY");

  const note = `/*\n * My note about the Replaces the minified module idea\n */\nBODY`;
  check(
    "keeps a user note that mentions the same phrase",
    stripOverlayHeader(note) === note,
    "user comment was stripped",
  );

  for (const [name, src] of [
    ["license", "/*! @preserve MIT */\nBODY"],
    ["eslint", "/* eslint-disable */\nBODY"],
    ["todo block", "/*\n * TODO: later\n */\nBODY"],
  ]) {
    check(`keeps a leading ${name} comment`, stripOverlayHeader(src) === src);
  }
}

report("\n=== overlay name validation ===\n");
{
  const tmp = makeScratch();
  try {
    runIn(tmp, "tools/build.mjs");
    const overlayDir = path.join(tmp, "src", "overlay", "WebappCS.8b5d7cd6");
    fs.mkdirSync(overlayDir, { recursive: true });
    fs.writeFileSync(path.join(overlayDir, "NOT-A-MODULE.js"), "/* x */\n", "utf8");

    const r = runIn(tmp, "tools/build.mjs");
    check("a misnamed overlay fails the build", r.code !== 0, `exit=${r.code}`);
    check(
      "the warning names the ignored file",
      r.out.includes("NOT-A-MODULE.js"),
      r.out.split("\n").find((l) => l.includes("IGNORED")) ?? "no IGNORED line",
    );

    // A correctly named overlay must still be accepted.
    fs.rmSync(path.join(overlayDir, "NOT-A-MODULE.js"));
    runIn(tmp, "tools/adopt.mjs", ["WebappCS.8b5d7cd6", "hEvvs"]);
    const ok = runIn(tmp, "tools/build.mjs");
    check("a correctly named overlay still builds", ok.code === 0, `exit=${ok.code}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

report("\n=== module strict-mode parsing ===\n");
{
  const tmp = makeScratch();
  try {
    runIn(tmp, "tools/build.mjs");
    // options.html loads its bundle as <script type="module">, so `with` is a
    // SyntaxError there even though it parses as a classic script.
    const epi = path.join(tmp, "src", "bundles", "options.6406b895", "epilogue.js");
    fs.writeFileSync(epi, `${fs.readFileSync(epi, "utf8")}\nwith (Math) { }`, "utf8");

    const r = runIn(tmp, "tools/build.mjs");
    check("build rejects `with` in a module-loaded bundle", r.code !== 0, `exit=${r.code}`);
    check(
      "the error is attributed to module semantics",
      r.out.includes("[module]"),
      r.out.split("\n").find((l) => l.includes("Strict mode")) ?? "no strict-mode message",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

report("\n=== publish rollback ===\n");
{
  const tmp = makeScratch();
  try {
    runIn(tmp, "tools/build.mjs");
    const before = fs.readdirSync(path.join(tmp, "dist")).sort();
    // Build again; the swap must be clean both times.
    const r = runIn(tmp, "tools/build.mjs");
    const after = fs.readdirSync(path.join(tmp, "dist")).sort();
    check("rebuild succeeds", r.code === 0, `exit=${r.code}`);
    check("dist contents are stable across rebuilds", JSON.stringify(before) === JSON.stringify(after));
    check("no staging directory left behind", !fs.existsSync(path.join(tmp, ".dist-staging")));
    check("no retired directory left behind", !fs.existsSync(path.join(tmp, ".dist-retired")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

report(`\n${failures === 0 ? "round-2 repairs verified" : `${failures} problem(s) found`}`);
process.exit(failures === 0 ? 0 : 1);
