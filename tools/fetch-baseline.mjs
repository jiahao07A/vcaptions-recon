#!/usr/bin/env node
/**
 * Fetch the published extension bundle this project reconstructs.
 *
 * `assets/baseline/` is not versioned: it holds the original author's published
 * artifact, and redistributing it in a public repository would be republication.
 * Everything else in the repo is our own reconstruction, so a fresh clone needs
 * this one step before `npm run verify` / `build` / `audit` can run.
 *
 * The extension is downloaded from the Chrome Web Store's own update endpoint,
 * which serves the same bytes the browser would install. The CRX3 header is
 * stripped to produce the plain zip, then extracted.
 *
 * Usage:
 *   node tools/fetch-baseline.mjs            download and extract
 *   node tools/fetch-baseline.mjs --check    report whether a baseline exists
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE_DIR = path.join(ROOT, "assets", "baseline");
const EXT_ID = "bciglihaegkdhoogebcdblfhppoilclp";
const VERSION = "2.4.6";
const CRX_PATH = path.join(BASELINE_DIR, `vCaptions-${VERSION}.crx`);
const EXTRACT_DIR = path.join(BASELINE_DIR, `extension-v${VERSION}`);

/** Files that must exist for the baseline to be usable. */
const REQUIRED = ["manifest.json", "sidepanel.html", "options.html", "static/background/index.js"];

function isComplete() {
  if (!fs.existsSync(EXTRACT_DIR)) return false;
  return REQUIRED.every((rel) => fs.existsSync(path.join(EXTRACT_DIR, rel)));
}

/** Minimal zip reader: extract every entry into `dest`. */
function extractZip(zipBuf, dest) {
  // Locate the end-of-central-directory record.
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip archive (no end-of-central-directory)");

  const count = zipBuf.readUInt16LE(eocd + 10);
  let p = zipBuf.readUInt32LE(eocd + 16);
  let written = 0;

  for (let i = 0; i < count; i++) {
    if (zipBuf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const method = zipBuf.readUInt16LE(p + 10);
    const compSize = zipBuf.readUInt32LE(p + 20);
    const nameLen = zipBuf.readUInt16LE(p + 28);
    const extraLen = zipBuf.readUInt16LE(p + 30);
    const commentLen = zipBuf.readUInt16LE(p + 32);
    const localOffset = zipBuf.readUInt32LE(p + 42);
    const name = zipBuf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;

    // Reject absolute paths and traversal so a hostile archive cannot escape.
    const normalised = path.normalize(name).replace(/^([/\\])+/, "");
    if (normalised.split(/[/\\]/).includes("..")) {
      throw new Error(`refusing to extract unsafe path: ${name}`);
    }

    const lh = localOffset;
    if (zipBuf.readUInt32LE(lh) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lNameLen = zipBuf.readUInt16LE(lh + 26);
    const lExtraLen = zipBuf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lNameLen + lExtraLen;
    const raw = zipBuf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;

    const outPath = path.join(dest, normalised);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
    written++;
  }
  return written;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf;
}

async function main() {
  if (process.argv.includes("--check")) {
    if (isComplete()) {
      console.log(`baseline present: ${path.relative(ROOT, EXTRACT_DIR)}`);
      return;
    }
    console.error(
      `baseline missing: ${path.relative(ROOT, EXTRACT_DIR)}\n` +
        `Run \`npm run fetch-baseline\` to download it.`,
    );
    process.exit(2);
  }

  if (isComplete()) {
    console.log(`baseline already present: ${path.relative(ROOT, EXTRACT_DIR)}`);
    console.log("Delete it first if you want to re-download.");
    return;
  }

  fs.mkdirSync(BASELINE_DIR, { recursive: true });

  const url =
    `https://clients2.google.com/service/update2/crx?response=redirect` +
    `&os=win&arch=x86-64&os_arch=x86-64&nacl_arch=x86-64` +
    `&prod=chromiumcrx&prodchannel=unknown&prodversion=141.0.0.0` +
    `&acceptformat=crx2,crx3&x=id%3D${EXT_ID}%26uc`;

  console.log(`downloading vCaptions ${VERSION} from the Chrome Web Store…`);
  const crx = await download(url, CRX_PATH);
  console.log(`  ${(crx.length / 1024 / 1024).toFixed(2)} MB -> ${path.relative(ROOT, CRX_PATH)}`);

  // CRX3 layout: magic(4) version(4) headerLength(4) header(n) zip
  if (crx.subarray(0, 4).toString("ascii") !== "Cr24") {
    throw new Error("downloaded file is not a CRX archive");
  }
  const version = crx.readUInt32LE(4);
  if (version !== 3) throw new Error(`unexpected CRX version ${version}`);
  const headerLen = crx.readUInt32LE(8);
  const zipBuf = crx.subarray(12 + headerLen);

  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  const files = extractZip(zipBuf, EXTRACT_DIR);
  console.log(`  extracted ${files} files -> ${path.relative(ROOT, EXTRACT_DIR)}`);

  // Verify the manifest reports the version we expect, so a silent store-side
  // update cannot make every later byte comparison meaningless.
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTRACT_DIR, "manifest.json"), "utf8"));
  if (manifest.version !== VERSION) {
    console.error(
      `\nWARNING: the store now serves version ${manifest.version}, but this project\n` +
        `reconstructs ${VERSION}. Byte comparisons against the baselines recorded in\n` +
        `src/bundles/index.json will not match. Pin the expected version or update the\n` +
        `project to the new release.`,
    );
  }

  const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(EXTRACT_DIR, rel)));
  if (missing.length) {
    console.error(`\nbaseline incomplete — missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  const digest = crypto.createHash("sha256").update(zipBuf).digest("hex");
  console.log(`\nbaseline ready. zip sha256: ${digest.slice(0, 32)}…`);
  console.log("Next: `npm run verify` to re-split, or `npm run build` directly.");
}

main().catch((err) => {
  console.error(`fetch-baseline failed: ${err.message}`);
  console.error(
    "\nIf the download is blocked, obtain the CRX manually from\n" +
      `  https://chromewebstore.google.com/detail/${EXT_ID}\n` +
      `and place it at ${path.relative(ROOT, CRX_PATH)}, then re-run this script.`,
  );
  process.exit(1);
});
