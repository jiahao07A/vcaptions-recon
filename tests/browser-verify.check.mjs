// Prove the expanded browser-verify now catches what it used to miss.
// Round-1 L4 showed that breaking sidepanel/tab-main/content scripts still
// produced "browser verification passed".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

function run(script, args = [], cwd = ROOT) {
  try {
    const out = execFileSync(process.execPath, [path.join(cwd, script), ...args], {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function makeScratch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bv-reg-"));
  for (const d of ["assets", "src", "tools", "tests"]) {
    fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tmp, "package.json"));
  run("tools/build.mjs", [], tmp);
  run("tools/package.mjs", [], tmp);
  return tmp;
}

const results = [];
const PKG = (tmp) => path.join(tmp, "release", "vcaptions-test-2.4.6");

// Baseline: unmodified must pass.
{
  const tmp = makeScratch();
  const r = run("tools/browser-verify.mjs", [PKG(tmp)], tmp);
  results.push({ name: "unmodified package", detected: r.code !== 0, expected: false });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Regression 1: sidepanel bundle throws on load. Previously reported as passed.
{
  const tmp = makeScratch();
  const f = path.join(PKG(tmp), "sidepanel.65d86198.js");
  const src = fs.readFileSync(f, "utf8");
  fs.writeFileSync(f, `throw new Error('SIDEPANEL-BROKEN');\n${src}`, "utf8");
  const r = run("tools/browser-verify.mjs", [PKG(tmp)], tmp);
  results.push({ name: "sidepanel bundle throws", detected: r.code !== 0, expected: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Regression 2: tab-main bundle throws. Previously reported as passed.
{
  const tmp = makeScratch();
  const f = path.join(PKG(tmp), "tabs", "tab-main.1e0435ca.js");
  const src = fs.readFileSync(f, "utf8");
  fs.writeFileSync(f, `throw new Error('TABMAIN-BROKEN');\n${src}`, "utf8");
  const r = run("tools/browser-verify.mjs", [PKG(tmp)], tmp);
  results.push({ name: "tab-main bundle throws", detected: r.code !== 0, expected: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Regression 3: a content script throws, so nothing injects.
{
  const tmp = makeScratch();
  const f = path.join(PKG(tmp), "MainCS.277dcde3.js");
  const src = fs.readFileSync(f, "utf8");
  fs.writeFileSync(f, `throw new Error('MAINCS-BROKEN');\n${src}`, "utf8");
  const r = run("tools/browser-verify.mjs", [PKG(tmp)], tmp);
  results.push({ name: "content script throws", detected: r.code !== 0, expected: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("browser-verify effectiveness\n");
let failures = 0;
for (const r of results) {
  const ok = r.detected === r.expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${r.name} — detected=${r.detected} expected=${r.expected}`);
}
console.log(`\n${failures === 0 ? "browser-verify regression check passed" : `${failures} problem(s) found`}`);
process.exit(failures === 0 ? 0 : 1);
