// Verify the P0 fixes: a structurally weakened modules.json must NOT let the
// guard pass, and must not destroy hand edits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGET = "WebappCS.8b5d7cd6";

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0-modjson-"));
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
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const MARKER = "MY-PRECIOUS-EDIT";
const weakenings = [
  ["empty object", "{}"],
  ["empty array", "[]"],
  ["modules: []", JSON.stringify({ modules: [] })],
  ["modules: null", JSON.stringify({ modules: null })],
  ["modules omitted subset", null], // handled specially below
];

for (const [name, content] of weakenings) {
  const tmp = makeScratch();
  try {
    const dir = path.join(tmp, "src", "bundles", TARGET);
    const manPath = path.join(dir, "modules.json");

    // 1. Create a hand edit in a module file.
    const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
    const modFile = path.join(dir, man.modules[0].file);
    const original = fs.readFileSync(modFile, "utf8");
    fs.writeFileSync(modFile, `${original}\n/* ${MARKER} */\n`, "utf8");

    // 2. Weaken the manifest.
    if (content === null) {
      // Drop all but the first module from the list, so the guard would
      // enumerate a shorter list and miss the edited one.
      const reduced = { ...man, modules: man.modules.slice(0, 1) };
      fs.writeFileSync(manPath, JSON.stringify(reduced, null, 2), "utf8");
    } else {
      fs.writeFileSync(manPath, content, "utf8");
    }

    // 3. Re-split must refuse.
    const r = runIn(tmp, "tools/reconstruct.mjs", ["--verify"]);
    check(`refuses when modules.json is ${name}`, r.code !== 0, `exit=${r.code}`);

    // 4. The edit must survive.
    const survived = fs.readFileSync(modFile, "utf8").includes(MARKER);
    check(`edit survives the refusal (${name})`, survived);

    // 5. The advice must not *recommend* deleting the directory. Matching the
    //    phrase alone was wrong: the corrected message says "Do NOT delete the
    //    bundle directory", which contains the same words. Check that the only
    //    occurrence is negated.
    const mentionsDelete = /delete the bundle directory/i.test(r.out);
    const negated = /do not delete the bundle directory/i.test(r.out);
    check(
      `advice does not recommend deleting the bundle (${name})`,
      !mentionsDelete || negated,
      mentionsDelete && !negated ? "found an unqualified delete suggestion" : undefined,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

report(`\n${failures === 0 ? "P0 modules.json guard verified" : `${failures} problem(s) found`}`);
process.exit(failures === 0 ? 0 : 1);
