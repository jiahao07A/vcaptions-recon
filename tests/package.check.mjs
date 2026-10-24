#!/usr/bin/env node
/**
 * Packaging regression test.
 *
 * Verifies the properties that matter for a package someone will actually load:
 *
 *   1. the package is complete — every manifest reference resolves
 *   2. every __MSG_ key resolves in the default locale (a dangling key makes
 *      Chrome display the raw placeholder as the extension name)
 *   3. `--name-suffix` produces a literal, human-readable name rather than a
 *      broken placeholder
 *   4. `--suffix` produces a valid Chrome version
 *   5. the zip is a readable archive containing exactly the unpacked files
 *
 * Usage: node tests/package.check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const RELEASE = path.join(ROOT, "release");

let failures = 0;
const report = (line = "") => process.stdout.write(`${line}\n`);
const check = (label, ok, detail) => {
  if (ok) report(`ok    ${label}`);
  else {
    failures++;
    report(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

function runPackage(args = []) {
  return execFileSync(process.execPath, [path.join(ROOT, "tools", "package.mjs"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, acc);
    else acc.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return acc;
}

/**
 * Read a zip's central directory to list entry names.
 * Enough to prove the archive is well-formed and complete.
 */
function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  // Locate the end-of-central-directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, buf };
}

/** Extract one entry and verify its contents decompress. */
function extractEntry(zip, entry) {
  const { buf } = zip;
  const lh = entry.localOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  return entry.method === 8 ? zlib.inflateRawSync(raw) : raw;
}

function main() {
  if (!fs.existsSync(path.join(ROOT, "dist", "manifest.json"))) {
    report("dist/ missing; run `npm run build` first");
    process.exit(2);
  }

  report("=== default package ===\n");
  const out = runPackage();
  check("package command succeeds", out.includes("package verified"));

  const dir = path.join(RELEASE, "vcaptions-test-2.4.6");
  const zip = path.join(RELEASE, "vcaptions-test-2.4.6.zip");
  check("unpacked directory exists", fs.existsSync(dir));
  check("zip exists", fs.existsSync(zip));

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  check("version is unchanged", manifest.version === "2.4.6", manifest.version);

  // Every manifest reference must resolve inside the package.
  const missing = [];
  const need = (p) => {
    if (!p) return;
    const rel = String(p).replace(/^\//, "");
    if (!fs.existsSync(path.join(dir, rel))) missing.push(rel);
  };
  need(manifest.background?.service_worker);
  need(manifest.side_panel?.default_path);
  need(manifest.options_ui?.page ?? manifest.options_page);
  for (const cs of manifest.content_scripts ?? []) for (const js of cs.js ?? []) need(js);
  for (const v of Object.values(manifest.icons ?? {})) need(v);
  check("every manifest reference resolves", missing.length === 0, missing.join(", "));

  // Every __MSG_ key must resolve, or Chrome prints the placeholder verbatim.
  const locale = manifest.default_locale ?? "en";
  const messages = JSON.parse(
    fs.readFileSync(path.join(dir, "_locales", locale, "messages.json"), "utf8"),
  );
  const dangling = [];
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    if (!messages[m[1]]?.message) dangling.push(m[1]);
  }
  check("every __MSG_ key resolves", dangling.length === 0, [...new Set(dangling)].join(", "));

  report("\n=== zip integrity ===\n");
  const zipData = readZipEntries(zip);
  const onDisk = walk(dir).sort();
  const inZip = zipData.entries.map((e) => e.name).sort();
  check(
    "zip contains exactly the unpacked files",
    JSON.stringify(onDisk) === JSON.stringify(inZip),
    `disk=${onDisk.length} zip=${inZip.length}`,
  );

  // Spot-check that a large entry actually decompresses to the right size.
  const bigName = "sidepanel.65d86198.js";
  const bigEntry = zipData.entries.find((e) => e.name === bigName);
  if (bigEntry) {
    const extracted = extractEntry(zipData, bigEntry);
    const expected = fs.statSync(path.join(dir, bigName)).size;
    check(
      `zip entry ${bigName} decompresses correctly`,
      extracted.length === expected,
      `${extracted.length} vs ${expected}`,
    );
  } else {
    check(`zip contains ${bigName}`, false);
  }

  report("\n=== --name-suffix ===\n");
  runPackage(["--name-suffix"]);
  const named = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  check(
    "name becomes a literal string, not a broken placeholder",
    typeof named.name === "string" && !named.name.includes("__MSG_"),
    named.name,
  );
  check(
    "name retains the product name and marks the test build",
    /vCaptions/.test(named.name) && /\(test\)/.test(named.name),
    named.name,
  );
  const stillResolves = [...JSON.stringify(named).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].every(
    (m) => messages[m[1]]?.message,
  );
  check("remaining __MSG_ keys still resolve", stillResolves);

  report("\n=== --suffix ===\n");
  runPackage(["--suffix", "test.1"]);
  const suffixed = JSON.parse(
    fs.readFileSync(path.join(RELEASE, "vcaptions-test-2.4.6.1", "manifest.json"), "utf8"),
  );
  const validVersion = /^\d+(\.\d+){0,3}$/.test(suffixed.version);
  check("suffixed version is Chrome-valid", validVersion, suffixed.version);

  // Leave the default package in place so the documented path stays accurate.
  runPackage();

  report(`\n${failures === 0 ? "package check passed" : `${failures} problem(s) found`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
