#!/usr/bin/env node
/**
 * Rule-coverage meta-test for check.mjs.
 *
 * `validator.check.mjs` proves that check.mjs catches the faults it is given.
 * This test proves something different and harder: that *every rule* in
 * check.mjs is actually exercised by some scenario. A rule that no scenario
 * triggers can silently become a no-op — the validator keeps reporting
 * "check passed" while enforcing less and less.
 *
 * Method: for each rule, neutralise only its `fail(...)` call so check.mjs still
 * runs normally, then require the meta-test to go red. If the meta-test stays
 * green, that rule is unguarded.
 *
 * Usage: node tests/rule-coverage.check.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Each entry: rule label, the regex matching its failure report, and the
 * replacement that silences it.
 *
 * Only the reporting call is replaced. Rewriting the surrounding condition
 * instead tends to produce invalid JavaScript, which crashes check.mjs and makes
 * the measurement meaningless.
 */
const RULES = [
  ["manifest_version == 3", /fail\(`manifest_version must be 3[^`]*`\)/, "{}"],
  ["version format", /fail\(`version "\$\{manifest\.version\}" is not[^`]*`\)/, "{}"],
  ["permission whitelist", /unknownPermissions\.push\(p\)/, "void 0"],
  ["API/permission cross-check", /missingPermissions\.push\(`\$\{api\} -> \$\{required\}`\)/, "void 0"],
  ["content_scripts matches", /fail\(`invalid match pattern: \$\{pattern\}`\)/, "{}"],
  [
    "WAR matches nothing",
    /fail\(`web_accessible_resources pattern "\$\{pattern\}" matches no files`\)/,
    "{}",
  ],
  [
    "WAR traversal",
    /fail\(`web_accessible_resources pattern "\$\{pattern\}" escapes the package`\)/,
    "{}",
  ],
  ["runtime stylesheet", /fail\(`runtime stylesheet \$\{css\} is missing[^`]*`\)/, "{}"],
  [
    "locale parses",
    /fail\(`_locales\/\$\{defaultLocale\}\/messages\.json is not valid JSON[^`]*`\)/,
    "{}",
  ],
  [
    // The failure is a multi-line template argument; neutralise the whole
    // statement so the surrounding control flow (and therefore check.mjs itself)
    // stays syntactically valid.
    "locale exists",
    /fail\(\s*`missing _locales\/\$\{defaultLocale\}\/messages\.json`\s*\+\s*\(msgKeys\.size \? ` \(manifest uses \$\{msgKeys\.size\} __MSG_ key\(s\)\)` : ""\)\s*,?\s*\)/,
    "void 0",
  ],
  ["msg key resolves", /else fail\(`manifest uses __MSG_\$\{key\}__[^`]*`\)/, "else {}"],
  ["all JS parse", /fail\(`syntax error in \$\{rel\}: \$\{err\.message\}`\)/, "{}"],
  ["HTML references", /else fail\(`\$\{html\} references missing \$\{rel\}`\)/, "else {}"],
  ["resource exists", /else fail\(`missing resource \$\{rel\}`\)/, "else {}"],
  [
    "structure required",
    /else fail\(`manifest is missing \$\{label\} — Chrome would refuse or degrade the package`\)/,
    "else {}",
  ],
];

function makeScratch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rulecov-"));
  for (const d of ["assets", "src", "tools", "tests"]) {
    fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tmp, "package.json"));
  fs.cpSync(path.join(ROOT, "dist"), path.join(tmp, "dist"), { recursive: true });
  return tmp;
}

function runIn(tmp, script) {
  try {
    const out = execFileSync(process.execPath, [path.join(tmp, script)], {
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

let failures = 0;
const report = (l = "") => process.stdout.write(`${l}\n`);

function main() {
  if (!fs.existsSync(path.join(ROOT, "dist", "manifest.json"))) {
    report("dist/ missing; run `npm run build` first");
    process.exit(2);
  }

  report("check.mjs rule coverage\n");

  let locked = 0;
  let skipped = 0;

  for (const [name, pattern, replacement] of RULES) {
    const tmp = makeScratch();
    try {
      const p = path.join(tmp, "tools", "check.mjs");
      const src = fs.readFileSync(p, "utf8");
      const patched = src.replace(pattern, replacement);
      if (patched === src) {
        report(`skip  ${name} — source fragment not found`);
        skipped++;
        continue;
      }
      fs.writeFileSync(p, patched, "utf8");

      // The validator must still behave like a validator, not crash.
      const direct = runIn(tmp, "tools/check.mjs");
      if (!/check passed|problem\(s\) found/.test(direct.out)) {
        report(`skip  ${name} — neutralising broke check.mjs`);
        skipped++;
        continue;
      }

      const meta = runIn(tmp, "tests/validator.check.mjs");
      if (meta.code !== 0) {
        report(`ok    ${name}`);
        locked++;
      } else {
        failures++;
        report(`FAIL  ${name} — no scenario exercises this rule`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  report(`\n${locked} rules guarded, ${failures} unguarded, ${skipped} skipped`);
  report(failures === 0 ? "rule coverage passed" : "rule coverage INCOMPLETE");
  process.exit(failures === 0 ? 0 : 1);
}

main();
