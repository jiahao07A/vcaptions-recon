// Prove the boundary-anchored doc assertions reject the substring bug R2 found:
// `includes("16 个存储键")` was satisfied by "116 个存储键".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docbound-"));
  for (const d of ["assets", "src", "tools", "tests", "docs"]) {
    fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
  }
  for (const f of ["README.md", "package.json"]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  }
  fs.cpSync(path.join(ROOT, "dist"), path.join(tmp, "dist"), { recursive: true });
  return tmp;
}

function runConsistency(tmp) {
  try {
    const out = execFileSync(process.execPath, [path.join(tmp, "tests", "consistency.check.mjs")], {
      encoding: "utf8",
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

report("=== doc number boundary anchoring ===\n");

// Baseline: unmodified docs pass.
{
  const tmp = makeScratch();
  try {
    const r = runConsistency(tmp);
    check("baseline docs pass", r.code === 0, r.out.split("\n").filter((l) => l.includes("FAIL")).join(" | "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// R2's exact bypass: prepend a digit so the correct number becomes a suffix.
{
  const tmp = makeScratch();
  try {
    const p = path.join(tmp, "README.md");
    const text = fs.readFileSync(p, "utf8");
    fs.writeFileSync(p, text.replace("16 个存储键", "116 个存储键"), "utf8");
    const r = runConsistency(tmp);
    check("rejects '116 个存储键' when the real count is 16", r.code !== 0, `exit=${r.code}`);
    check(
      "the failure names the stale count",
      /stale storage-key|116/.test(r.out),
      r.out.split("\n").find((l) => l.includes("FAIL")) ?? "no FAIL line",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// A wrong count in a doc that used to be ignored entirely.
{
  const tmp = makeScratch();
  try {
    const p = path.join(tmp, "docs", "navigation.md");
    const text = fs.readFileSync(p, "utf8");
    fs.writeFileSync(p, text.replace("16 个存储键", "9 个存储键"), "utf8");
    const r = runConsistency(tmp);
    check("rejects a wrong count in navigation.md", r.code !== 0, `exit=${r.code}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

report(`\n${failures === 0 ? "doc boundary anchoring verified" : `${failures} problem(s) found`}`);
process.exit(failures === 0 ? 0 : 1);
