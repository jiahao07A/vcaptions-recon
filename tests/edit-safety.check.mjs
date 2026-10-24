#!/usr/bin/env node
/**
 * Edit-safety regression test.
 *
 * `tools/reconstruct.mjs` rewrites `src/bundles/` from the pristine baseline.
 * Before the guard was added, that silently discarded any hand edit — and the
 * documented workflow told people to edit exactly those files. This test locks in
 * the two protections:
 *
 *   1. `npm run verify` REFUSES to overwrite an edited file and names it
 *   2. adopting the edit into `src/overlay/` makes it survive, and it reaches dist
 *
 * The test restores everything it touches, so it is safe to run in CI.
 *
 * Usage: node tests/edit-safety.check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = "WebappCS.8b5d7cd6";
const SRC_EPI = path.join(ROOT, "src", "bundles", BUNDLE, "epilogue.js");
const OVERLAY_ROOT = path.join(ROOT, "src", "overlay");
const OVERLAY_DIR = path.join(OVERLAY_ROOT, BUNDLE);
const DIST_BUNDLE = path.join(ROOT, "dist", `${BUNDLE}.js`);

/**
 * Move the overlay tree aside instead of deleting it.
 *
 * `src/overlay/` holds a developer's real uncommitted work. This test used to
 * delete it outright, so running the suite could destroy edits. Stashing makes
 * the test non-destructive by construction.
 */
function stashOverlays() {
  if (!fs.existsSync(OVERLAY_ROOT)) return null;
  const stash = `${OVERLAY_ROOT}.stash-${process.pid}`;
  fs.renameSync(OVERLAY_ROOT, stash);
  return stash;
}

function restoreOverlays(stash) {
  if (!stash) return;
  fs.rmSync(OVERLAY_ROOT, { recursive: true, force: true });
  if (fs.existsSync(stash)) fs.renameSync(stash, OVERLAY_ROOT);
}

let failures = 0;
const report = (line = "") => process.stdout.write(`${line}\n`);
const check = (label, ok, detail) => {
  if (ok) report(`ok    ${label}`);
  else {
    failures++;
    report(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/** Run a tool, returning exit code and combined output instead of throwing. */
function run(script, args = []) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, script), ...args], {
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function build() {
  return run("tools/build.mjs");
}

function main() {
  const originalEpi = fs.readFileSync(SRC_EPI, "utf8");
  const stash = stashOverlays();

  try {
    // Start from a clean state: no overlays, byte-exact tree.
    fs.rmSync(OVERLAY_ROOT, { recursive: true, force: true });
    build();

    report("=== 1. pristine tree verifies ===");
    {
      const r = run("tools/reconstruct.mjs", ["--verify"]);
      check("verify passes on an unedited tree", r.code === 0, r.out.split("\n").slice(-2).join(" "));
    }

    report("\n=== 2. hand edit is protected ===");
    const marker = "EDIT-SAFETY-PROOF";
    fs.writeFileSync(
      SRC_EPI,
      originalEpi.replace('this.info("WebappCS', `this.info("${marker} WebappCS`),
      "utf8",
    );
    {
      const r = run("tools/reconstruct.mjs", ["--verify"]);
      check("verify REFUSES to overwrite the edit", r.code !== 0, `exit=${r.code}`);
      check(
        "refusal names the edited file",
        r.out.includes("epilogue.js"),
        "file not mentioned in output",
      );
      check(
        "refusal explains how to adopt",
        r.out.includes("adopt") || r.out.includes("overlay"),
        "no remediation given",
      );
      const survived = fs.readFileSync(SRC_EPI, "utf8").includes(marker);
      check("edit is still on disk after the refusal", survived);
    }

    report("\n=== 3. adopting the edit makes it durable ===");
    {
      const r = run("tools/adopt.mjs", [BUNDLE, "--epilogue"]);
      check("adopt --epilogue succeeds", r.code === 0, r.out.slice(0, 120));
      const overlayFile = path.join(OVERLAY_DIR, "99-epilogue.js");
      check("overlay fragment created", fs.existsSync(overlayFile));

      // The overlay now holds the edited text; the split copy can be restored.
      fs.writeFileSync(SRC_EPI, originalEpi, "utf8");

      const verify = run("tools/reconstruct.mjs", ["--verify"]);
      check(
        "verify passes once the edit lives in the overlay",
        verify.code === 0,
        verify.out.split("\n").slice(-2).join(" "),
      );
      check(
        "verify did not overwrite the overlay",
        fs.readFileSync(overlayFile, "utf8").includes(marker),
      );

      const b = build();
      const inDist = fs.readFileSync(DIST_BUNDLE, "utf8").includes(marker);
      check("edit from the overlay reaches dist", inDist);
      check(
        "build reports the bundle as modified",
        /9\/10 bundles byte-identical/.test(b.out),
        b.out.split("\n").find((l) => l.includes("byte-identical")) ?? "",
      );
    }

    report("\n=== 4. removing the overlay restores parity ===");
    {
      fs.rmSync(OVERLAY_ROOT, { recursive: true, force: true });
      const b = build();
      check(
        "baseline restored",
        /10\/10 bundles byte-identical/.test(b.out),
        b.out.split("\n").find((l) => l.includes("byte-identical")) ?? "",
      );
    }
  } finally {
    // Always restore the tree, whatever happened above.
    fs.writeFileSync(SRC_EPI, originalEpi, "utf8");
    fs.rmSync(OVERLAY_ROOT, { recursive: true, force: true });
    restoreOverlays(stash);
    try {
      build();
    } catch {
      /* reported above */
    }
  }

  report(`\n${failures === 0 ? "edit-safety check passed" : `${failures} problem(s) found`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
