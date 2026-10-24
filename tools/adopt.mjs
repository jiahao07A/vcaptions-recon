#!/usr/bin/env node
/**
 * Adopt a minified module as an editable overlay.
 *
 * Copies one module out of `src/bundles/<bundle>/<moduleId>.js`, formats it, and
 * writes it to `src/overlay/<bundle>/<moduleId>.js`. From then on the build uses
 * the overlay instead of the minified original, and `npm run format` no longer
 * touches it.
 *
 * Usage:
 *   node tools/adopt.mjs <bundle> <moduleId>      adopt one module
 *   node tools/adopt.mjs <bundle> --all           adopt every module in a bundle
 *   node tools/adopt.mjs --list                   show current overlays
 *   node tools/adopt.mjs --list-available         show adoptable modules
 *
 * Example:
 *   node tools/adopt.mjs WebappCS.8b5d7cd6 hEvvs
 */
import fs from "node:fs";
import path from "node:path";
import prettier from "prettier";
import { listOverlays, overlayRoot, overlayPathFor, FRAGMENT_OVERLAYS } from "./overlay.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLES = path.join(ROOT, "src", "bundles");

/** When true, an existing overlay may be overwritten (destroys edits). */
const FORCE = process.argv.includes("--force");

const PRETTIER_OPTIONS = {
  parser: "babel",
  printWidth: 100,
  tabWidth: 2,
  semi: true,
  singleQuote: false,
  trailingComma: "none",
  bracketSpacing: true,
  arrowParens: "always",
};

/** Strip the one-line provenance header added by parcel-split.mjs. */
function stripModuleHeader(text) {
  if (!text.startsWith("/* parcel module id:")) return text;
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(nl + 1);
}

function readBundleManifest(bundleDir) {
  const file = path.join(BUNDLES, bundleDir, "modules.json");
  if (!fs.existsSync(file)) {
    throw new Error(`no such bundle: ${bundleDir} (expected ${path.relative(ROOT, file)})`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listAvailable() {
  const bundles = fs
    .readdirSync(BUNDLES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const rows = [];
  for (const bundle of bundles) {
    let manifest;
    try {
      manifest = readBundleManifest(bundle);
    } catch {
      continue;
    }
    for (const mod of manifest.modules) {
      const adopted = Boolean(overlayPathFor(ROOT, bundle, mod.id));
      rows.push({ bundle, moduleId: mod.id, bytes: mod.bytes, adopted });
    }
  }
  return rows;
}

async function adoptOne(bundleDir, moduleId) {
  const manifest = readBundleManifest(bundleDir);
  const mod = manifest.modules.find((m) => m.id === moduleId);
  if (!mod) {
    const ids = manifest.modules.map((m) => m.id).join(", ");
    throw new Error(`module ${moduleId} not in ${bundleDir}; available: ${ids}`);
  }

  const srcFile = path.join(BUNDLES, bundleDir, mod.file);
  const body = stripModuleHeader(fs.readFileSync(srcFile, "utf8"));

  let formatted;
  try {
    formatted = await prettier.format(body, PRETTIER_OPTIONS);
  } catch (err) {
    throw new Error(
      `module ${moduleId} could not be formatted (${err.message.split("\n")[0]}); ` +
        `it may not be a standalone expression`,
    );
  }

  const destDir = path.join(overlayRoot(ROOT), bundleDir);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `${moduleId}.js`);

  // Never clobber existing work. An overlay is the one place a developer's real
  // edits live, and re-running `adopt` is an easy mistake; overwriting it
  // silently would destroy changes with no warning and no undo.
  if (fs.existsSync(dest) && !FORCE) {
    throw new Error(
      `overlay already exists: ${path.relative(ROOT, dest)}\n` +
        `  refusing to overwrite it. Delete it first, or pass --force to discard the edits.`,
    );
  }

  const header = `/*
 * Overlay module: ${moduleId}
 * Replaces the minified module in src/bundles/${bundleDir}/${mod.file}
 * Original size: ${mod.bytes} bytes
 *
 * This file is the editable source. Edits here are used by \`npm run build\`
 * instead of the minified original. Delete this file to fall back to the
 * byte-exact minified module.
 *
 * The body below is the original module, formatted only — whitespace and
 * redundant parentheses differ, semantics do not.
 */
`;
  fs.writeFileSync(dest, header + formatted, "utf8");
  return { dest, moduleId, bundleDir, bytes: mod.bytes };
}

/**
 * Adopt a bundle fragment (preamble or epilogue) as an editable overlay.
 *
 * The epilogue holds the entry scope, which is where the application code lives.
 * It is not a `register(...)` call, so it cannot be adopted through the module
 * path; this copies it verbatim under the fragment overlay name instead.
 */
async function adoptFragment(bundleDir, fragment) {
  const manifest = readBundleManifest(bundleDir);
  const sourceFile = path.join(BUNDLES, bundleDir, `${fragment}.js`);
  if (!fs.existsSync(sourceFile)) {
    throw new Error(`no ${fragment}.js in ${bundleDir}`);
  }

  const overlayName = FRAGMENT_OVERLAYS[fragment];
  if (!overlayName) throw new Error(`unknown fragment: ${fragment}`);

  const body = fs.readFileSync(sourceFile, "utf8");
  const destDir = path.join(overlayRoot(ROOT), bundleDir);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `${overlayName}.js`);

  if (fs.existsSync(dest) && !FORCE) {
    throw new Error(
      `overlay already exists: ${path.relative(ROOT, dest)}\n` +
        `  refusing to overwrite it. Delete it first, or pass --force to discard the edits.`,
    );
  }

  const header = `/*
 * Overlay fragment: ${fragment}
 * Replaces src/bundles/${bundleDir}/${fragment}.js
 * Original size: ${Buffer.byteLength(body, "utf8")} bytes
 *
 * This file is the editable source. Edits here are used by \`npm run build\`
 * instead of the split copy, and \`npm run verify\` will not overwrite it.
 * Delete this file to fall back to the byte-exact split fragment.
 *
 * The fragment is not independently parseable (it is part of the enclosing
 * Parcel IIFE), so it is copied verbatim rather than formatted.
 */
`;
  fs.writeFileSync(dest, header + body, "utf8");
  return { dest, bundleDir, fragment, bytes: Buffer.byteLength(body, "utf8") };
}

function printOverlays() {
  const overlays = listOverlays(ROOT);
  if (!overlays.length) {
    console.log("no adopted modules yet");
    console.log("adopt one with: node tools/adopt.mjs <bundle> <moduleId>");
    return;
  }
  console.log(`adopted modules (${overlays.length}):`);
  for (const o of overlays) {
    console.log(`  ${o.bundle}/${o.moduleId}`);
  }
}

function printAvailable() {
  const rows = listAvailable();
  const byBundle = new Map();
  for (const r of rows) {
    if (!byBundle.has(r.bundle)) byBundle.set(r.bundle, []);
    byBundle.get(r.bundle).push(r);
  }
  for (const [bundle, mods] of byBundle) {
    const adopted = mods.filter((m) => m.adopted).length;
    console.log(`\n${bundle}  (${mods.length} modules, ${adopted} adopted)`);
    for (const m of mods) {
      const mark = m.adopted ? "*" : " ";
      console.log(`  ${mark} ${m.moduleId.padEnd(8)} ${String(m.bytes).padStart(8)} B`);
    }
  }
  console.log("\n* = already adopted");
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(`usage:
  node tools/adopt.mjs <bundle> <moduleId>       adopt one module
  node tools/adopt.mjs <bundle> --epilogue       adopt the entry scope (app code)
  node tools/adopt.mjs <bundle> --preamble       adopt the Parcel bootstrap
  node tools/adopt.mjs <bundle> --all            adopt every module in a bundle
  node tools/adopt.mjs --list                    show adopted overlays
  node tools/adopt.mjs --list-available          show adoptable modules`);
    return;
  }
  if (args[0] === "--list") {
    printOverlays();
    return;
  }
  if (args[0] === "--list-available") {
    printAvailable();
    return;
  }

  const [bundleDir, target] = args;
  if (!bundleDir || !target) {
    console.error("need <bundle> and <moduleId|--all|--epilogue|--preamble>");
    process.exit(2);
  }

  // Fragments: the entry scope (epilogue) and Parcel bootstrap (preamble).
  if (target === "--epilogue" || target === "--preamble") {
    const fragment = target === "--epilogue" ? "epilogue" : "preamble";
    const r = await adoptFragment(bundleDir, fragment);
    console.log(`adopted ${r.bundleDir}/${r.fragment} -> ${path.relative(ROOT, r.dest)}`);
    console.log(`  ${r.bytes} bytes copied verbatim (fragments are not independently parseable)`);
    console.log(`\nRun \`npm run build\` — this bundle will now report as modified.`);
    return;
  }

  if (target === "--all") {
    const manifest = readBundleManifest(bundleDir);
    let ok = 0;
    let failed = 0;
    for (const mod of manifest.modules) {
      try {
        const r = await adoptOne(bundleDir, mod.id);
        console.log(`adopted ${r.bundleDir}/${r.moduleId}`);
        ok++;
      } catch (err) {
        console.log(`skip    ${mod.id}: ${err.message.split("\n")[0]}`);
        failed++;
      }
    }
    console.log(`\n${ok} adopted, ${failed} skipped`);
    return;
  }

  const r = await adoptOne(bundleDir, target);
  console.log(`adopted ${r.bundleDir}/${r.moduleId}`);
  console.log(`  ${path.relative(ROOT, r.dest)}  (from ${r.bytes} minified bytes)`);
  console.log(`\nRun \`npm run build\` — this bundle will now report as modified.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
