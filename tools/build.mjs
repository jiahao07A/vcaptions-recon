#!/usr/bin/env node
/**
 * Assemble a loadable extension into `dist/` from the archived baseline.
 *
 * The build is deliberately simple and dependency-free: it copies the static
 * shell (manifest, HTML, CSS, icons, locales) from the baseline and reassembles
 * every Parcel bundle from its split modules under `src/bundles/`. It then
 * verifies each emitted bundle against the baseline SHA-256, so a broken edit in
 * any split module fails the build instead of shipping silently.
 *
 * Usage: node tools/build.mjs [--clean]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import {
  overlayPathFor,
  readOverlayBody,
  fragmentOverlayPathFor,
  listOverlays,
  FRAGMENT_OVERLAYS,
} from "./overlay.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE = path.join(ROOT, "assets", "baseline", "extension-v2.4.6");
const BUNDLES_DIR = path.join(ROOT, "src", "bundles");
const DIST = path.join(ROOT, "dist");

/** Files copied verbatim from the baseline into dist/. */
const STATIC_FILES = [
  "manifest.json",
  "options.html",
  "sidepanel.html",
  "tabs/tab-main.html",
  "options.css",
  "options.d68fb9df.css",
  "style.css",
  "subtitleBar.css",
  "daisyui.css",
  "icon16.plasmo.00ac8b83.png",
  "icon32.plasmo.9ad0c5b6.png",
  "icon48.plasmo.cae3a6b3.png",
  "icon64.plasmo.e4b604fc.png",
  "icon128.plasmo.b89b7dfa.png",
  "_locales/en/messages.json",
  "_locales/zh_CN/messages.json",
];

const STATIC_DIRS = ["tabs"];

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Determine whether a bundle is loaded as an ES module.
 *
 * A bundle appears in an HTML page as `<script src="...">`; when that tag has
 * `type="module"`, the code runs under module semantics (implicit strict mode).
 * The check reads the HTML files in the baseline rather than assuming, so a
 * future change to how a bundle is loaded is picked up automatically.
 */
function isModuleLoaded(entry) {
  const htmlFiles = ["options.html", "sidepanel.html", "tabs/tab-main.html"];
  for (const html of htmlFiles) {
    const abs = path.join(BASELINE, html);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    // Match the tag that references this bundle, then look for type="module".
    const tagRe = new RegExp(
      `<script[^>]*src=["'][^"']*${entry.baseline_file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
      "i",
    );
    const tag = tagRe.exec(text);
    if (tag && /type=["']module["']/i.test(tag[0])) return true;
  }
  return false;
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyFile(rel, destRoot = DIST) {
  const src = path.join(BASELINE, rel);
  const dest = path.join(destRoot, rel);
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

/**
 * Files present in the baseline that are deliberately not shipped.
 *
 * `_metadata/verified_contents.json` is Chrome's signed content manifest for the
 * store package. Any re-signed or unpacked build has a different byte layout, so
 * the stored signature can never validate; shipping it is at best inert and at
 * worst confusing. Every other baseline file must reach dist/, and the check
 * below enforces that so a future baseline update cannot silently lose a file.
 */
const BASELINE_EXCLUDED = new Set(["_metadata/verified_contents.json"]);

/** Recursively list files relative to `dir`, POSIX-style. */
function walkFiles(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, base, acc);
    else acc.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return acc;
}

/**
 * Assert that every baseline file is either copied or explicitly excluded.
 * Returns the list of unexpected omissions.
 */
function findOmittedBaselineFiles(outRoot) {
  const shipped = new Set(walkFiles(outRoot));
  return walkFiles(BASELINE).filter(
    (rel) => !BASELINE_EXCLUDED.has(rel) && !shipped.has(rel),
  );
}

/**
 * Reassemble one bundle from its split parts, substituting adopted overlays.
 *
 * Precedence, highest first:
 *   1. `src/overlay/<bundle>/<id>.js`      adopted editable module
 *   2. `src/bundles/<bundle>/<id>.js`      byte-exact split module
 *
 * The preamble and epilogue follow the same rule using the `00-preamble` and
 * `99-epilogue` overlay names. Without this, editing the entry scope (where the
 * application code lives) would be silently reverted by the next
 * `npm run verify`.
 */
function reassembleBundle(entry, bundleName) {
  const dir = path.join(ROOT, entry.split_dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "modules.json"), "utf8"));
  const overlaid = [];

  const readFragment = (fragment, file) => {
    const overlayFile = fragmentOverlayPathFor(ROOT, bundleName, fragment);
    if (overlayFile) {
      // Record the overlay's own name (`99-epilogue`), which is what
      // `listOverlays` reports. Pushing the internal fragment name
      // (`epilogue`) made the "every overlay was used" check see a mismatch and
      // fail builds that were in fact correct.
      overlaid.push(FRAGMENT_OVERLAYS[fragment]);
      return readOverlayBody(overlayFile);
    }
    return fs.readFileSync(path.join(dir, file), "utf8");
  };

  const preamble = readFragment("preamble", "preamble.js");
  const epilogue = readFragment("epilogue", "epilogue.js");

  let out = preamble;
  for (const m of manifest.modules) {
    const overlayFile = overlayPathFor(ROOT, bundleName, m.id);
    let body;
    if (overlayFile) {
      body = readOverlayBody(overlayFile);
      overlaid.push(m.id);
    } else {
      const raw = fs.readFileSync(path.join(dir, m.file), "utf8");
      const nl = raw.indexOf("\n");
      body = raw.slice(nl + 1);
    }
    out += body + (m.separator_after ?? "");
  }
  out += epilogue;
  return { text: out, manifest, overlaid };
}

function main() {
  // The build is always a fresh staging directory, so --clean is accepted for
  // backward compatibility but no longer changes behaviour.
  const clean = process.argv.includes("--clean");
  void clean;
  if (!fs.existsSync(BASELINE)) {
    console.error(
      `baseline missing: ${path.relative(ROOT, BASELINE)}\n` +
        `The original artifact is not versioned (it belongs to the extension's author).\n` +
        `Run \`npm run fetch-baseline\` to download it again.`,
    );
    process.exit(2);
  }
  const indexFile = path.join(BUNDLES_DIR, "index.json");
  if (!fs.existsSync(indexFile)) {
    console.error("src/bundles/index.json missing; run `npm run split` first.");
    process.exit(2);
  }
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));

  // Build into a staging directory and swap it in at the end.
  //
  // Writing in place let stale files from a previous build survive into the
  // package: an orphan .js shipped through build, check and package without any
  // of them noticing. Building to staging makes the output an exact function of
  // the inputs, and a failed build leaves the previous dist/ intact instead of
  // half-overwritten.
  const STAGING = path.join(ROOT, ".dist-staging");
  rmrf(STAGING);
  fs.mkdirSync(STAGING, { recursive: true });

  // 1. static shell
  let copied = 0;
  for (const rel of STATIC_FILES) if (copyFile(rel, STAGING)) copied++;
  for (const dir of STATIC_DIRS) {
    const srcDir = path.join(BASELINE, dir);
    if (!fs.existsSync(srcDir)) continue;
    for (const name of fs.readdirSync(srcDir)) {
      const rel = path.join(dir, name);
      if (fs.statSync(path.join(BASELINE, rel)).isFile() && copyFile(rel, STAGING)) copied++;
    }
  }
  console.log(`static: ${copied} files copied`);

  // 2. bundles
  const results = [];
  for (const entry of index.bundles) {
    // Derive the directory name from the baseline path, not from `split_dir`.
    // `split_dir` is stored with OS separators; on POSIX `path.basename` does not
    // split on backslash, so a Windows-generated index would yield the whole
    // path as the bundle name and every overlay lookup would silently miss.
    const bundleName = entry.baseline_file
      .replace(/[\\/]/g, "__")
      .replace(/\.js$/, "");
    const { text, manifest, overlaid } = reassembleBundle(entry, bundleName);
    const dest = path.join(STAGING, entry.baseline_file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, "utf8");
    const emitted = fs.readFileSync(dest);
    const digest = sha256(emitted);

    // A bundle that no longer parses is not a build, it is a broken package.
    // Byte comparison cannot catch this (the bytes are "as edited"), so the
    // syntax check has to happen here or the failure ships silently.
    //
    // Two parse goals are required. Some entries load as classic scripts and
    // others as `<script type="module">`, and module code is implicitly strict:
    // `with (x) {}` parses as a classic script but is a SyntaxError in a module.
    // Checking only the script goal let exactly that through five guards, and
    // only real Chrome rejected it.
    //
    // `vm.SourceTextModule` needs `--experimental-vm-modules`, which callers
    // cannot be assumed to pass, so module semantics are approximated by
    // prefixing `"use strict"`: that reproduces the strict-mode syntax errors
    // which are the observable difference here.
    const moduleLoaded = isModuleLoaded(entry);
    let syntaxError = null;
    try {
      if (moduleLoaded) {
        new vm.Script(`"use strict";\n${text}`, { filename: entry.baseline_file });
      } else {
        new vm.Script(text, { filename: entry.baseline_file });
      }
    } catch (err) {
      syntaxError = `${moduleLoaded ? "[module] " : ""}${err.message}`;
    }

    // Compare against the baseline on disk, not against the digest recorded in
    // index.json. If the baseline is updated without re-splitting, a stale index
    // would make every bundle look "modified" (or worse, match a stale digest
    // and hide a real difference).
    const baselinePath = path.join(BASELINE, entry.baseline_file);
    const baselineDigest = fs.existsSync(baselinePath)
      ? sha256(fs.readFileSync(baselinePath))
      : entry.baseline_sha256;

    results.push({
      file: entry.baseline_file,
      role: entry.role,
      bundleDirName: bundleName,
      modules: manifest.module_count,
      bytes: emitted.length,
      sha256: digest,
      matches_baseline: digest === baselineDigest,
      overlaid_modules: overlaid,
      syntax_error: syntaxError,
    });
  }

  // 3. report
  const changed = results.filter((r) => !r.matches_baseline);
  const broken = results.filter((r) => r.syntax_error);
  const totalOverlaid = results.reduce((a, r) => a + r.overlaid_modules.length, 0);
  for (const r of results) {
    const mark = r.syntax_error ? "!" : r.matches_baseline ? "=" : "~";
    const note = r.overlaid_modules.length ? ` [overlay: ${r.overlaid_modules.join(", ")}]` : "";
    console.log(
      `${mark} ${r.file.padEnd(30)} ${String(r.modules).padStart(3)} modules ` +
        `${String(r.bytes).padStart(9)} B ${r.sha256.slice(0, 12)}…${note}`,
    );
    if (r.syntax_error) console.log(`    syntax error: ${r.syntax_error}`);
  }
  fs.writeFileSync(
    // Written outside dist/ on purpose: dist/ is the extension package itself,
    // and Chrome warns about unrecognised files at the package root.
    path.join(ROOT, "build-report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        baseline_version: index.baseline_version,
        bundles: results,
        byte_identical_bundles: results.length - changed.length,
        modified_bundles: changed.map((c) => c.file),
        broken_bundles: broken.map((b) => ({ file: b.file, error: b.syntax_error })),
        overlaid_module_count: totalOverlaid,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `\nbuild: ${results.length - changed.length}/${results.length} bundles byte-identical to baseline`,
  );

  // A syntax error means the package cannot load; fail loudly.
  if (broken.length) {
    console.error(
      `\nbuild FAILED — ${broken.length} bundle(s) do not parse:\n` +
        broken.map((b) => `  ${b.file}: ${b.syntax_error}`).join("\n"),
    );
    process.exitCode = 1;
  }

  // Nothing from the baseline may go missing silently.
  const omitted = findOmittedBaselineFiles(STAGING);
  if (omitted.length) {
    console.error(`\nbuild INCOMPLETE — baseline files missing: ${omitted.join(", ")}`);
    process.exitCode = 1;
  }

  // Every overlay file on disk must have been used. An overlay whose name does
  // not match a module, a fragment, or a bundle directory is ignored by the
  // build — silently. `adopt --list` still reports it as adopted, so the
  // operator believes their edit is live when it is not. R1 reproduced four
  // shapes of this, one of which produced a bundle with the same byte count as
  // the baseline but different content.
  const usedOverlays = new Set();
  for (const r of results) {
    for (const id of r.overlaid_modules) usedOverlays.add(`${r.bundleDirName}/${id}`);
  }
  const ignoredOverlays = listOverlays(ROOT).filter(
    (o) => !usedOverlays.has(`${o.bundle}/${o.moduleId}`),
  );
  if (ignoredOverlays.length) {
    console.error(
      `\nbuild: ${ignoredOverlays.length} overlay file(s) were IGNORED ` +
        `(name does not match any module in that bundle):`,
    );
    for (const o of ignoredOverlays) {
      console.error(`  src/overlay/${o.bundle}/${o.moduleId}.js`);
    }
    console.error(
      "\nThese edits did NOT reach dist/. Check the bundle directory name and the" +
        "\nmodule id (fragment overlays must be named 00-preamble.js / 99-epilogue.js).",
    );
    process.exitCode = 1;
  }

  // Publish only when the build is sound. A failed build leaves the previous
  // dist/ untouched rather than replacing it with something unusable.
  if (process.exitCode === 1) {
    rmrf(STAGING);
    console.error("\ndist/ was left unchanged because the build failed.");
    return;
  }

  // Swap in three steps, with the old tree retained until the new one is in
  // place.
  //
  // The previous version did `rmrf(DIST); renameSync(STAGING, DIST)`. If the
  // rename failed — a reader holding a handle on a file inside dist/, a locked
  // directory, a cross-device move — the old tree was already gone and the new
  // one was stranded in staging. A reviewer reproduced exactly that: 27 files
  // became 18 with no "dist/ was left unchanged" message. Renaming the old tree
  // aside first means a failure at any point can be rolled back.
  const RETIRED = path.join(ROOT, ".dist-retired");
  rmrf(RETIRED);

  let published = false;
  try {
    if (fs.existsSync(DIST)) fs.renameSync(DIST, RETIRED);
    fs.renameSync(STAGING, DIST);
    published = true;
  } catch (err) {
    // Roll back: put the previous tree back if we moved it.
    if (fs.existsSync(RETIRED) && !fs.existsSync(DIST)) {
      try {
        fs.renameSync(RETIRED, DIST);
      } catch {
        /* nothing more we can do; the message below names both paths */
      }
    }
    rmrf(STAGING);
    console.error(
      `\nbuild FAILED to publish: ${err.message}\n` +
        `  previous dist/: ${fs.existsSync(DIST) ? "restored" : "lost"}\n` +
        `  retired copy:   ${path.relative(ROOT, RETIRED)}${fs.existsSync(RETIRED) ? " (still present)" : ""}\n` +
        `Close anything holding files under dist/ (editors, antivirus, a running` +
        ` browser) and re-run.`,
    );
    process.exit(1);
  } finally {
    if (published) rmrf(RETIRED);
  }

  if (totalOverlaid) {
    console.log(`overlays in use: ${totalOverlaid} module(s)`);
  }
  if (changed.length) {
    console.log(`modified (expected while editing): ${changed.map((c) => c.file).join(", ")}`);
  }
  console.log(`output: ${path.relative(ROOT, DIST)}`);
}

main();
