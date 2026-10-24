#!/usr/bin/env node
/**
 * Rebuild the vCaptions extension from the archived baseline.
 *
 * This is the reproducibility backbone of the reconstruction: it takes the
 * pristine `assets/baseline/extension-v2.4.6` tree, splits every Parcel bundle
 * into its registered modules under `src/bundles/<bundle>/`, and proves that
 * reassembly reproduces each bundle byte-for-byte.
 *
 * Usage: node tools/reconstruct.mjs [--verify]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { findModules } from "./parcel-split.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE = path.join(ROOT, "assets", "baseline", "extension-v2.4.6");
const OUT = path.join(ROOT, "src", "bundles");
const SPLITTER = path.join(ROOT, "tools", "parcel-split.mjs");

/** Bundle inventory, ordered as the manifest loads them. */
const BUNDLES = [
  { file: "static/background/index.js", role: "background" },
  { file: "MainCS.277dcde3.js", role: "content-script:main" },
  { file: "IFrameCS.26275720.js", role: "content-script:iframe" },
  { file: "YoutubeCS.6bf33c81.js", role: "content-script:youtube" },
  { file: "WebappCS.8b5d7cd6.js", role: "content-script:webapp" },
  { file: "Main.00175a8f.js", role: "content-script:app" },
  { file: "SubtitleBar.f2dae354.js", role: "content-script:subtitle-bar" },
  { file: "sidepanel.65d86198.js", role: "sidepanel" },
  { file: "options.6406b895.js", role: "options" },
  { file: "tabs/tab-main.1e0435ca.js", role: "tab" },
];

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Detect edits that would be destroyed by re-splitting.
 *
 * `reconstruct.mjs` rewrites `src/bundles/` from the pristine baseline, which
 * silently reverts any hand edit made there. Editing those files used to be the
 * documented workflow, so this guard turns a silent data loss into a clear
 * refusal: the affected files are reported and the operator is told to adopt
 * them into `src/overlay/` first.
 *
 * A file counts as edited when its bytes differ from what re-splitting the
 * baseline would produce. That is checked by digest against the values recorded
 * in `modules.json` and the baseline, so the check is cheap and needs no re-split.
 */
function findHandEdits() {
  const edited = [];
  const unreadable = [];

  // Derive the bundle list from the baseline itself rather than from
  // index.json. Depending on a generated file meant that a missing or corrupt
  // index silently disabled the whole check, and the next line then overwrote
  // the edits.
  for (const { file } of BUNDLES) {
    const baselineFile = path.join(BASELINE, file);
    if (!fs.existsSync(baselineFile)) continue;

    const slug = file.replace(/[\\/]/g, "__").replace(/\.js$/, "");
    const dir = path.join(OUT, slug);
    if (!fs.existsSync(dir)) continue; // not split yet, nothing to lose

    const baselineText = fs.readFileSync(baselineFile, "utf8");
    const truth = findModuleSpans(baselineText);
    if (!truth.length) continue;

    const manifestFile = path.join(dir, "modules.json");
    let manifest = null;
    if (fs.existsSync(manifestFile)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      } catch {
        manifest = null;
      }
    }

    // A manifest that parses but lacks a usable `modules` array is just as
    // useless as a missing one. Treating it as "no edits" let a single edit to
    // modules.json (`{}`, `[]`, `{"modules":null}`) silently disable the guard
    // and overwrite every hand edit in the bundle.
    const hasModuleList = manifest && Array.isArray(manifest.modules) && manifest.modules.length > 0;
    if (!hasModuleList) {
      unreadable.push({ bundle: path.basename(dir), file: "modules.json" });
      continue;
    }

    // Modules: compare each stored file against the exact span the baseline says
    // it should hold. This does not trust the recorded digests, so a corrupted
    // modules.json cannot mask an edit.
    //
    // The baseline is the authority for which modules exist. Enumerating from
    // the manifest alone meant a manifest listing fewer modules simply skipped
    // the rest; now any module the baseline expects but the manifest omits is
    // reported as its own problem.
    const truthById = new Map(truth.map((s) => [s.id, s]));
    const listedIds = new Set();

    for (const mod of manifest.modules) {
      listedIds.add(mod.id);
      const file2 = path.join(dir, mod.file);
      if (!fs.existsSync(file2)) {
        // Missing module file: the tree is incomplete, not clean.
        edited.push({
          bundle: path.basename(dir),
          file: mod.file,
          kind: "module",
          moduleId: mod.id,
        });
        continue;
      }
      const raw = fs.readFileSync(file2, "utf8");
      const nl = raw.indexOf("\n");
      const body = nl === -1 ? raw : raw.slice(nl + 1);
      const span = truthById.get(mod.id);
      if (!span || body !== span.source) {
        edited.push({
          bundle: path.basename(dir),
          file: mod.file,
          kind: "module",
          moduleId: mod.id,
        });
      }
    }

    // Modules the baseline has but the manifest forgot: another way to hide
    // edits by making the guard enumerate a shorter list.
    for (const span of truth) {
      if (!listedIds.has(span.id)) {
        unreadable.push({
          bundle: path.basename(dir),
          file: `modules.json (omits module ${span.id})`,
        });
      }
    }

    // Fragments: compare against the text outside the module spans.
    const expectedPreamble = baselineText.slice(0, truth[0].start);
    const expectedEpilogue = baselineText.slice(truth[truth.length - 1].end);
    for (const [fragment, expected, moduleId] of [
      ["preamble.js", expectedPreamble, "00-preamble"],
      ["epilogue.js", expectedEpilogue, "99-epilogue"],
    ]) {
      const f = path.join(dir, fragment);
      if (!fs.existsSync(f)) continue;
      if (fs.readFileSync(f, "utf8") !== expected) {
        edited.push({
          bundle: path.basename(dir),
          file: fragment,
          kind: fragment === "epilogue.js" ? "epilogue" : "preamble",
          moduleId,
        });
      }
    }
  }
  return { edited, unreadable };
}

/**
 * Locate module spans using the same parser the splitter uses.
 *
 * Duplicating the bracket matcher here was a mistake: the two implementations
 * disagreed on where a module ends, so a pristine tree looked edited. Importing
 * the real parser guarantees the guard and the splitter share one definition of
 * a boundary.
 */
function findModuleSpans(src) {
  return findModules(src);
}

function main() {
  const verify = process.argv.includes("--verify");
  if (!fs.existsSync(BASELINE)) {
    console.error(
      `baseline missing: ${path.relative(ROOT, BASELINE)}\n` +
        `The original artifact is not versioned (it belongs to the extension's author).\n` +
        `Run \`npm run fetch-baseline\` to download it again.`,
    );
    process.exit(2);
  }

  // Refuse to overwrite edits. Re-splitting is a baseline operation; hand edits
  // belong in src/overlay/ where the build honours them.
  const { edited: edits, unreadable } = findHandEdits();

  // An unreadable manifest means the check cannot prove the tree is clean.
  // Treat that as a refusal rather than assuming "no edits": assuming the safe
  // case is what silently destroyed edits before.
  if (unreadable.length) {
    console.error("refusing to re-split: cannot verify these bundles are unedited\n");
    for (const u of unreadable) {
      console.error(`  ${u.bundle}/${u.file}`);
    }
    console.error(
      "\nDo NOT delete the bundle directory: it may contain hand edits that this\n" +
        "check cannot see. Instead:\n" +
        "  1. back up src/bundles/<bundle>/ somewhere safe\n" +
        "  2. restore modules.json from assets/baseline/ by re-splitting into a\n" +
        "     scratch directory, then copy its modules.json back\n" +
        "  3. re-run this command so the edits are detected and can be adopted\n\n" +
        "Re-splitting now could destroy edits.",
    );
    process.exit(1);
  }

  if (edits.length) {
    console.error("refusing to re-split: these files contain edits that would be lost\n");
    for (const e of edits) {
      console.error(`  ${e.bundle}/${e.file}`);
    }
    console.error(
      "\nAdopt them into src/overlay/ first, then re-run:\n" +
        edits
          .filter((e) => e.kind === "module")
          .map((e) => `  node tools/adopt.mjs ${e.bundle} ${e.moduleId}`)
          .join("\n") +
        (edits.some((e) => e.kind !== "module")
          ? "\n  node tools/adopt.mjs <bundle> --epilogue    (for 99-epilogue.js)\n" +
            "  node tools/adopt.mjs <bundle> --preamble    (for 00-preamble.js)"
          : "") +
        "\n\nOr discard the edits by restoring the file from assets/baseline/.",
    );
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });

  const index = {
    extension: "vCaptions",
    baseline_version: "2.4.6",
    baseline_dir: path.relative(ROOT, BASELINE),
    generated_by: "tools/reconstruct.mjs",
    bundles: [],
  };

  for (const { file, role } of BUNDLES) {
    const abs = path.join(BASELINE, file);
    if (!fs.existsSync(abs)) {
      console.warn(`  skip (missing): ${file}`);
      continue;
    }
    const slug = file.replace(/[\\/]/g, "__").replace(/\.js$/, "");
    const dest = path.join(OUT, slug);

    // Split without --verify, then validate the written tree in a separate
    // process. Splitting and verifying in one call would validate the in-memory
    // result rather than what actually landed on disk.
    const splitOut = execFileSync(process.execPath, [SPLITTER, abs, dest], {
      encoding: "utf8",
    }).trim();
    console.log(`  ${file} -> ${JSON.parse(fs.readFileSync(path.join(dest, "modules.json"), "utf8")).module_count} modules`);

    let checkOut = null;
    let checkOk = null;
    if (verify) {
      try {
        checkOut = execFileSync(process.execPath, [SPLITTER, abs, dest, "--check"], {
          encoding: "utf8",
        }).trim();
        checkOk = true;
      } catch (err) {
        checkOut = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
        checkOk = false;
      }
      console.log(`    ${checkOut.split("\n").join("\n    ")}`);
    } else {
      console.log(`    ${splitOut.split("\n").join("\n    ")}`);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(dest, "modules.json"), "utf8"));
    const baselineBytes = fs.readFileSync(abs);
    index.bundles.push({
      role,
      baseline_file: file,
      baseline_sha256: sha256(baselineBytes),
      baseline_bytes: baselineBytes.length,
      split_dir: path.relative(ROOT, dest).split(path.sep).join("/"),
      module_count: manifest.module_count,
      reassembly_verified: checkOk,
    });
  }

  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 2), "utf8");
  const total = index.bundles.reduce((a, b) => a + b.module_count, 0);
  console.log(`\n${index.bundles.length} bundles, ${total} modules -> ${path.relative(ROOT, OUT)}`);
  if (verify) {
    const failed = index.bundles.filter((b) => b.reassembly_verified !== true);
    if (failed.length) {
      console.error(`reassembly FAILED for: ${failed.map((f) => f.baseline_file).join(", ")}`);
      process.exit(1);
    }
    console.log("all bundles reassemble byte-for-byte");
  }
}

main();
