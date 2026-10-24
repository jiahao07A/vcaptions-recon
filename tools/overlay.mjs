#!/usr/bin/env node
/**
 * Overlay support: editable sources that take precedence over minified modules.
 *
 * The split modules under `src/bundles/` are byte-exact but minified, which makes
 * them poor editing targets. `src/readable/` is readable but was previously
 * regenerated on every `npm run format`, so edits there were lost.
 *
 * This module adds an overlay layer: a file at `src/overlay/<bundle>/<moduleId>.js`
 * replaces the corresponding minified module at build time. Overlay sources are
 * ordinary JavaScript — formatted, editable, and preserved across `npm run format`.
 *
 * Verified precondition: a Prettier-formatted module, spliced back into its
 * bundle, still executes (see tests/overlay.check.mjs). Formatting only changes
 * whitespace and adds redundant parentheses, so the overlay is semantics-preserving
 * until a developer actually edits it.
 */
import fs from "node:fs";
import path from "node:path";

export const OVERLAY_DIRNAME = "overlay";

/** Root of the overlay tree for a project root. */
export function overlayRoot(projectRoot) {
  return path.join(projectRoot, "src", OVERLAY_DIRNAME);
}

/** Path of the overlay file for one module, or null when no overlay exists. */
export function overlayPathFor(projectRoot, bundleDirName, moduleId) {
  const p = path.join(overlayRoot(projectRoot), bundleDirName, `${moduleId}.js`);
  return fs.existsSync(p) ? p : null;
}

/**
 * Overlay names for the two bundle fragments that are not registered modules.
 *
 * `preamble.js` and `epilogue.js` hold Parcel's bootstrap and the entry scope,
 * and the entry scope is where application code lives. They cannot be adopted
 * through the module path because they are not `register(...)` calls, but they
 * still need an editable, overwrite-proof home.
 */
export const FRAGMENT_OVERLAYS = {
  preamble: "00-preamble",
  epilogue: "99-epilogue",
};

/** Path of a fragment overlay (preamble/epilogue), or null when absent. */
export function fragmentOverlayPathFor(projectRoot, bundleDirName, fragment) {
  const name = FRAGMENT_OVERLAYS[fragment];
  if (!name) return null;
  const p = path.join(overlayRoot(projectRoot), bundleDirName, `${name}.js`);
  return fs.existsSync(p) ? p : null;
}

/** List every adopted module across all bundles. */
export function listOverlays(projectRoot) {
  const root = overlayRoot(projectRoot);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const bundle of fs.readdirSync(root, { withFileTypes: true })) {
    if (!bundle.isDirectory()) continue;
    const dir = path.join(root, bundle.name);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".js")) continue;
      out.push({
        bundle: bundle.name,
        moduleId: file.replace(/\.js$/, ""),
        path: path.join(dir, file),
      });
    }
  }
  return out.sort((a, b) => a.bundle.localeCompare(b.bundle) || a.moduleId.localeCompare(b.moduleId));
}

/**
 * Strip a leading provenance comment block from an overlay source.
 * Overlay files start with a header describing what they replace.
 */
/**
 * Strip the provenance header that `adopt` writes, and only that header.
 *
 * Two subtle failures to avoid:
 *
 *  1. Removing *any* leading block comment would delete a license header, an
 *     `@preserve` notice, or an `eslint-disable` directive the author added.
 *     The overlay header is therefore recognised by its exact first line.
 *  2. Matching the header by loose keywords ("Replaces the minified module") let
 *     a user comment that happened to contain the phrase be treated as a header
 *     and stripped, silently deleting their note. The marker must be the first
 *     line, in the exact form adopt emits.
 *  3. Trimming trailing whitespace can leave a `//` comment as the last line of
 *     a module body, swallowing the separator that follows when spliced back.
 */
const ADOPT_HEADER_FIRST_LINE = /^\/\*\n \* Overlay (?:module|fragment): [\w.\-/]+$/;

export function stripOverlayHeader(text) {
  const trimmed = text.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("/*")) return trimmed;

  const end = trimmed.indexOf("*/");
  if (end === -1) return trimmed;

  const header = trimmed.slice(0, end + 2);
  // The header adopt writes always begins with this exact line. Anchoring on it
  // (rather than on any phrase appearing somewhere in the comment) means a user
  // comment that mentions "Overlay module" further down is left intact.
  const firstLine = header.split("\n")[0] === "/*" ? header.split("\n").slice(0, 2).join("\n") : header;
  if (!ADOPT_HEADER_FIRST_LINE.test(firstLine)) return trimmed;

  return trimmed.slice(end + 2).replace(/^\s*\n/, "");
}

/**
 * Read an overlay module's body, ready to be spliced into a bundle.
 *
 * Trailing blank lines are removed, but a trailing newline is kept when the body
 * ends with a `//` comment: without it the following separator would become part
 * of that comment and the reassembled bundle would not parse.
 */
export function readOverlayBody(file) {
  const body = stripOverlayHeader(fs.readFileSync(file, "utf8"));
  const collapsed = body.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");

  // A `//` comment anywhere after the last newline runs to end-of-file, so a
  // separator appended directly after it would become part of the comment. That
  // covers both a bare comment line and a trailing comment on a code line
  // (`foo(); // note`). Keeping one newline terminates the comment.
  const lastLine = collapsed.slice(collapsed.lastIndexOf("\n") + 1);
  if (lastLine.includes("//")) return `${collapsed}\n`;
  return collapsed;
}
