// Prove the strengthened smoke test catches regressions the old one missed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

function runIn(tmp, script) {
  try {
    const out = execFileSync(process.execPath, [path.join(tmp, script)], {
      encoding: "utf8",
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function makeScratch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-reg-"));
  for (const d of ["assets", "src", "tools", "tests"]) {
    fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tmp, "package.json"));
  runIn(tmp, "tools/build.mjs");
  return tmp;
}

const results = [];

// Baseline: unmodified must pass.
{
  const tmp = makeScratch();
  const r = runIn(tmp, "tests/background.smoke.mjs");
  results.push({ name: "unmodified build", detected: r.code !== 0, expected: false });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Regression 1: handler returns an empty object instead of the real value.
// The old test only checked "a reply exists", so this passed.
{
  const tmp = makeScratch();
  const epi = path.join(tmp, "src", "bundles", "static__background__index", "epilogue.js");
  const src = fs.readFileSync(epi, "utf8");
  // The handler is dispatched by name; make it answer with an empty object.
  const patched = src.replace(
    'case"getCurrentWindowId":lo({...I,sender:G},{send:I=>l(I)})',
    'case"getCurrentWindowId":G.send({})',
  );
  if (patched === src) {
    results.push({ name: "handler returns {}", detected: null, expected: true, note: "pattern not found" });
  } else {
    fs.writeFileSync(epi, patched, "utf8");
    runIn(tmp, "tools/build.mjs");
    const r = runIn(tmp, "tests/background.smoke.mjs");
    results.push({ name: "handler returns {}", detected: r.code !== 0, expected: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Regression 2: message router returns false instead of true, which drops all
// async replies in real Chrome. The old test never checked this.
{
  const tmp = makeScratch();
  const epi = path.join(tmp, "src", "bundles", "static__background__index", "epilogue.js");
  const src = fs.readFileSync(epi, "utf8");

  // Target the listener's OWN return, not the first `return!0` in the file.
  // There are 20 such occurrences; the first belongs to unrelated code, which is
  // why an earlier version of this test silently tested nothing.
  const listenerStart = src.indexOf("onMessage.addListener(");
  const switchEnd = src.indexOf('case"webappExtensionAuth"', listenerStart);
  const anchor = src.indexOf("return!0", switchEnd);

  if (listenerStart === -1 || switchEnd === -1 || anchor === -1) {
    results.push({ name: "router returns false", detected: null, expected: true, note: "anchor not found" });
  } else {
    const patched = src.slice(0, anchor) + "return!1" + src.slice(anchor + "return!0".length);
    fs.writeFileSync(epi, patched, "utf8");
    runIn(tmp, "tools/build.mjs");
    const r = runIn(tmp, "tests/background.smoke.mjs");
    results.push({ name: "router returns false", detected: r.code !== 0, expected: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("smoke test effectiveness\n");
let failures = 0;
for (const r of results) {
  if (r.detected === null) {
    console.log(`SKIP  ${r.name} — ${r.note}`);
    continue;
  }
  const ok = r.detected === r.expected;
  console.log(`${ok ? "ok  " : "FAIL"}  ${r.name} — detected=${r.detected} expected=${r.expected}`);
  if (!ok) failures++;
}
console.log(`\n${failures === 0 ? "smoke regression check passed" : `${failures} problem(s) found`}`);
process.exit(failures === 0 ? 0 : 1);
