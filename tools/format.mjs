#!/usr/bin/env node
/**
 * Produce a readable source tree from the split Parcel modules.
 *
 * The split modules under `src/bundles/` are byte-exact but minified: one line,
 * mangled identifiers. This tool emits a *derived* view under `src/readable/`
 * where every module is pretty-printed, so the code can be read, searched and
 * navigated.
 *
 * Formatting a module in isolation fails for the preamble/epilogue fragments,
 * because they are pieces of the enclosing IIFE rather than valid programs. So
 * this tool formats the *whole bundle* first — which is always a valid program —
 * and then splits the formatted output back at the `register(...)` boundaries.
 * Whitespace changes never move a boundary, so the module mapping stays exact.
 *
 * The readable tree is a derived artifact. It is never fed back into the build:
 * `npm run build` still reassembles from `src/bundles/`, preserving byte-for-byte
 * parity with the published extension.
 *
 * Usage: node tools/format.mjs [--bundle <substring>]
 */
import fs from "node:fs";
import path from "node:path";
import prettier from "prettier";
import { findModules } from "./parcel-split.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE = path.join(ROOT, "assets", "baseline", "extension-v2.4.6");
const BUNDLES = path.join(ROOT, "src", "bundles");
const READABLE = path.join(ROOT, "src", "readable");

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

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function stripHeader(text) {
  if (!text.startsWith("/* parcel module id:")) return text;
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(nl + 1);
}

/**
 * Format one bundle and return the formatted text.
 * Returns null when Prettier cannot parse it; callers fall back to raw output.
 */
async function formatBundle(code) {
  try {
    return await prettier.format(code, PRETTIER_OPTIONS);
  } catch {
    return null;
  }
}

async function processBundle(entry) {
  const bundleDir = path.join(ROOT, entry.split_dir);
  const name = path.basename(bundleDir);
  const outDir = path.join(READABLE, name);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "modules.json"), "utf8"));
  const original = fs.readFileSync(path.join(BASELINE, entry.baseline_file), "utf8");

  const formatted = await formatBundle(original);
  const stats = {
    bundle: manifest.bundle,
    role: entry.role,
    modules: manifest.modules.length,
    formatted: Boolean(formatted),
    bytes: Buffer.byteLength(formatted ?? original, "utf8"),
  };

  if (!formatted) {
    // Fall back: emit each split part verbatim so the tree is still complete.
    console.warn(`  ! ${name}: bundle format failed, emitting raw parts`);
    for (const mod of manifest.modules) {
      const raw = stripHeader(fs.readFileSync(path.join(bundleDir, mod.file), "utf8"));
      fs.writeFileSync(path.join(outDir, `${mod.id}.js`), raw, "utf8");
    }
    fs.copyFileSync(path.join(bundleDir, "preamble.js"), path.join(outDir, "00-preamble.js"));
    fs.copyFileSync(path.join(bundleDir, "epilogue.js"), path.join(outDir, "99-epilogue.js"));
    return stats;
  }

  // Re-locate module boundaries in the formatted text.
  const spans = findModules(formatted);
  const byId = new Map(spans.map((s) => [s.id, s]));

  // Preamble: everything before the first module.
  const firstStart = spans.length ? spans[0].start : formatted.length;
  fs.writeFileSync(
    path.join(outDir, "00-preamble.js"),
    `/* Parcel bootstrap preamble for ${manifest.bundle}.\n` +
      ` * Fragment of the enclosing IIFE; formatting only, semantics unchanged. */\n` +
      formatted.slice(0, firstStart).trimEnd(),
    "utf8",
  );

  // Modules: one readable file each.
  for (const mod of manifest.modules) {
    const span = byId.get(mod.id);
    if (!span) {
      console.warn(`  ! ${name}/${mod.id}: boundary lost after formatting, using raw`);
      const raw = stripHeader(fs.readFileSync(path.join(bundleDir, mod.file), "utf8"));
      fs.writeFileSync(path.join(outDir, `${mod.id}.js`), raw, "utf8");
      continue;
    }
    const deps = mod.dependencies.length
      ? mod.dependencies.map((d) => d.request || d.id).join(", ")
      : "none";
    const header = `/* module ${mod.id} | ${mod.bytes} bytes | deps: ${deps} */\n`;
    fs.writeFileSync(path.join(outDir, `${mod.id}.js`), header + span.source, "utf8");
  }

  // Epilogue: everything after the last module — the entry scope holding app code.
  const lastEnd = spans.length ? spans[spans.length - 1].end : 0;
  fs.writeFileSync(
    path.join(outDir, "99-epilogue.js"),
    `/* Entry scope for ${manifest.bundle}.\n` +
      ` * Application code is inlined here by Parcel; this is the primary file to read. */\n` +
      formatted.slice(lastEnd).replace(/^\s*,/, "").trimEnd(),
    "utf8",
  );

  return stats;
}

async function main() {
  const flagIndex = process.argv.indexOf("--bundle");
  const only = flagIndex !== -1 ? process.argv[flagIndex + 1] : null;

  // Validate the filter before touching anything. Previously the readable tree
  // was deleted first, so a typo in `--bundle` wiped it and then reported
  // "0/0 bundles formatted" with exit 0 — destroying the tree and calling it
  // success.
  if (flagIndex !== -1 && !only) {
    console.error("--bundle needs a value, e.g. `--bundle sidepanel`");
    process.exit(2);
  }

  const indexFile = path.join(BUNDLES, "index.json");
  if (!fs.existsSync(indexFile)) {
    console.error("src/bundles/index.json missing; run `npm run split` first.");
    process.exit(2);
  }
  if (!fs.existsSync(BASELINE)) {
    console.error(
      `baseline missing: ${path.relative(ROOT, BASELINE)}\n` +
        `Formatting reads the original bundle to re-split it into readable modules.\n` +
        `Run \`npm run fetch-baseline\` to download it again.`,
    );
    process.exit(2);
  }
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));

  if (only) {
    const matches = index.bundles.filter((e) => path.basename(e.split_dir).includes(only));
    if (!matches.length) {
      const available = index.bundles.map((e) => path.basename(e.split_dir)).join(", ");
      console.error(
        `no bundle matches "${only}" — refusing to clear src/readable/.\n` +
          `available: ${available}`,
      );
      process.exit(2);
    }
  }

  rmrf(READABLE);
  fs.mkdirSync(READABLE, { recursive: true });

  const results = [];
  for (const entry of index.bundles) {
    const name = path.basename(entry.split_dir);
    if (only && !name.includes(only)) continue;
    process.stdout.write(`formatting ${name} … `);
    const stats = await processBundle(entry);
    results.push(stats);
    console.log(stats.formatted ? "ok" : "raw fallback");
  }

  fs.writeFileSync(
    path.join(READABLE, "index.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        generated_by: "tools/format.mjs",
        note:
          "Derived readability view. NOT used by the build — src/bundles/ is the " +
          "byte-exact source of truth for `npm run build`.",
        bundles: results,
      },
      null,
      2,
    ),
    "utf8",
  );

  const ok = results.filter((r) => r.formatted).length;
  console.log(`\n${ok}/${results.length} bundles formatted`);
  console.log(`output: src/readable/`);
}

main();
