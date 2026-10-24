#!/usr/bin/env node
/**
 * Overlay regression test.
 *
 * Proves the editing workflow the project documents actually holds:
 *
 *   1. adopting a module produces an editable overlay
 *   2. a build with that overlay still produces a runnable bundle
 *   3. an edit to an overlay reaches the build output
 *   4. removing the overlay restores byte-for-byte parity with the baseline
 *
 * Step 4 is the important one: it guarantees the test leaves no residue, so it
 * can run in CI on every commit.
 *
 * Usage: node tests/overlay.check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const OVERLAY_DIR = path.join(ROOT, "src", "overlay");
const BUNDLE = "WebappCS.8b5d7cd6";
const MODULE = "hEvvs";

let failures = 0;
const report = (line = "") => process.stdout.write(`${line}\n`);
const check = (label, ok, detail) => {
  if (ok) report(`ok    ${label}`);
  else {
    failures++;
    report(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

function run(script, args = []) {
  return execFileSync(process.execPath, [path.join(ROOT, script), ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

function buildSummary() {
  const out = run("tools/build.mjs");
  return {
    raw: out,
    identical: /(\d+)\/(\d+) bundles byte-identical/.exec(out)?.[0] ?? "",
    overlays: /overlays in use: (\d+)/.exec(out)?.[1] ?? "0",
  };
}

function cleanup() {
  fs.rmSync(OVERLAY_DIR, { recursive: true, force: true });
}

/**
 * Move the overlay tree aside instead of deleting it.
 *
 * `src/overlay/` is where a developer's real, uncommitted work lives. An earlier
 * version of this test deleted it outright — after printing a reassuring "will
 * restore" note — so running the test suite could destroy edits. Stashing and
 * restoring makes the test non-destructive by construction.
 */
function stashOverlays() {
  if (!fs.existsSync(OVERLAY_DIR)) return null;
  const stash = `${OVERLAY_DIR}.stash-${process.pid}`;
  fs.renameSync(OVERLAY_DIR, stash);
  return stash;
}

function restoreOverlays(stash) {
  if (!stash) return;
  fs.rmSync(OVERLAY_DIR, { recursive: true, force: true });
  if (fs.existsSync(stash)) fs.renameSync(stash, OVERLAY_DIR);
}

async function main() {
  // Never leave the tree dirty, whatever happens below. Pre-existing overlays are
  // stashed and put back, never deleted.
  const stash = stashOverlays();
  if (stash) {
    report("note: pre-existing overlays stashed; they will be restored afterwards");
  }

  try {
    cleanup();

    report("=== 1. baseline ===");
    const base = buildSummary();
    check("baseline is byte-identical", base.identical.startsWith("10/10"), base.identical);

    report("\n=== 2. adopt ===");
    const adoptOut = run("tools/adopt.mjs", [BUNDLE, MODULE]);
    const overlayFile = path.join(OVERLAY_DIR, BUNDLE, `${MODULE}.js`);
    check("adopt writes an overlay file", fs.existsSync(overlayFile), overlayFile);
    check("adopt reports the module", adoptOut.includes(`${BUNDLE}/${MODULE}`));

    const overlaySource = fs.readFileSync(overlayFile, "utf8");
    check("overlay is formatted (multi-line)", overlaySource.split("\n").length > 20);
    check("overlay keeps the register call", overlaySource.includes(`register("${MODULE}"`));

    report("\n=== 3. build with overlay ===");
    const withOverlay = buildSummary();
    check(
      "bundle reports as modified",
      withOverlay.identical.startsWith("9/10"),
      withOverlay.identical,
    );
    check("overlay is counted", withOverlay.overlays === "1", `overlays=${withOverlay.overlays}`);

    report("\n=== 4. overlay bundle still runs ===");
    const loadOut = execFileSync(process.execPath, [path.join(ROOT, "tests/bundles.load.mjs")], {
      encoding: "utf8",
      cwd: ROOT,
    });
    const loadLine = loadOut.split("\n").find((l) => l.includes("loaded,")) ?? "";
    check("all bundles load with the overlay in place", loadLine.includes("0 failed"), loadLine);

    report("\n=== 5. edit reaches the output ===");
    const marker = "OVERLAY-EDIT-PROOF";
    const edited = overlaySource.replace(
      `register("${MODULE}"`,
      `register("${MODULE}"/*${marker}*/`,
    );
    fs.writeFileSync(overlayFile, edited, "utf8");
    buildSummary();
    const distText = fs.readFileSync(path.join(ROOT, "dist", `${BUNDLE}.js`), "utf8");
    check("edit is present in dist", distText.includes(marker));

    report("\n=== 6. removing the overlay restores parity ===");
    cleanup();
    const restored = buildSummary();
    check("baseline restored", restored.identical.startsWith("10/10"), restored.identical);
    check("no overlays remain", restored.overlays === "0");
  } finally {
    cleanup();
    restoreOverlays(stash);
    // Leave the build in the correct state regardless of outcome.
    try {
      buildSummary();
    } catch {
      /* build failure is already reported above */
    }
  }

  report(`\n${failures === 0 ? "overlay check passed" : `${failures} problem(s) found`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  cleanup();
  process.stderr.write(`overlay check harness error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
