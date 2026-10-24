#!/usr/bin/env node
/**
 * Package the built extension for distribution and manual testing.
 *
 * Produces two artifacts under `release/`:
 *
 *   vcaptions-test-<version>/       unpacked directory — load this in Chrome
 *   vcaptions-test-<version>.zip    the same tree, zipped for sharing
 *
 * A "test" build differs from the store build in ways that matter for manual
 * testing, all opt-in:
 *
 *   --suffix <text>   append to the version, e.g. 2.4.6-test.1
 *   --name-suffix     append to the extension name, so it is distinguishable
 *                     from the store-installed copy in chrome://extensions
 *
 * Without flags the package is byte-for-byte the reconstructed store build,
 * which is the useful default: it is the artifact under test.
 *
 * Usage:
 *   node tools/package.mjs                  package the current dist/
 *   node tools/package.mjs --suffix test.1  mark it as a test build
 *   node tools/package.mjs --name-suffix    also distinguish the display name
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const RELEASE = path.join(ROOT, "release");

/** Files Chrome does not need in a shipped package. */
const EXCLUDE = new Set(["build-report.json", ".DS_Store", "Thumbs.db"]);

function parseArgs(argv) {
  const out = { suffix: null, nameSuffix: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--suffix") out.suffix = argv[++i];
    else if (argv[i] === "--name-suffix") out.nameSuffix = true;
  }
  return out;
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/** Recursively list files relative to `dir`, skipping excluded names. */
function walk(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, acc);
    else acc.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return acc;
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * Minimal ZIP writer (deflate). Chrome accepts standard zip archives for
 * "Load unpacked" and for CRX packing, and this avoids a dependency.
 */
function writeZip(rootDir, zipPath) {
  const files = walk(rootDir);
  const chunks = [];
  const central = [];
  let offset = 0;

  // Fixed timestamp for reproducible archives.
  //
  // Using each file's mtime made the zip's bytes depend on filesystem
  // timestamps: two runs from identical inputs usually produced the same hash
  // only because copyTree happened to preserve mtimes. Pinning the DOS epoch
  // makes the archive a pure function of the file contents and names, so
  // `zip sha256` is a meaningful integrity value rather than a build clock.
  const FIXED_DOS = { time: 0, date: ((2020 - 1980) << 9) | (1 << 5) | 1 };

  for (const rel of files) {
    const abs = path.join(rootDir, rel);
    const data = fs.readFileSync(abs);
    const { time, date } = FIXED_DOS;
    const nameBuf = Buffer.from(rel, "utf8");
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Store uncompressed when deflate does not help (tiny or already-compressed).
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, end]));
  return files.length;
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Resolve a manifest value that may be an __MSG_key__ placeholder.
 *
 * Chrome substitutes these from `_locales/<default_locale>/messages.json`. When
 * a build needs to modify such a value (for example appending "(test)"), the
 * placeholder must be resolved first, otherwise the result is an undefined key
 * that Chrome prints literally.
 */
function resolveMessage(value, locale) {
  if (typeof value !== "string") return value;
  const m = /^__MSG_([A-Za-z0-9_]+)__$/.exec(value.trim());
  if (!m) return value;
  const file = path.join(DIST, "_locales", locale, "messages.json");
  if (!fs.existsSync(file)) return m[1];
  try {
    const messages = JSON.parse(fs.readFileSync(file, "utf8"));
    return messages[m[1]]?.message ?? m[1];
  } catch {
    return m[1];
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const manifestPath = path.join(DIST, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error("dist/manifest.json missing — run `npm run build` first.");
    process.exit(2);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const baseVersion = manifest.version;

  if (opts.suffix) {
    // Chrome requires 1-4 dot-separated integers; keep it valid.
    const clean = opts.suffix.replace(/[^0-9.]/g, "");
    if (!clean) {
      console.error(`--suffix must contain digits, got "${opts.suffix}"`);
      process.exit(2);
    }
    manifest.version = `${baseVersion}.${clean}`.replace(/\.+/g, ".").replace(/\.$/, "");
  }

  if (opts.nameSuffix) {
    // `name` is an __MSG_* placeholder resolved through _locales. Appending to
    // the placeholder produces an undefined key, which Chrome renders literally
    // as "__MSG_appName__ (test)". Resolve the real string first, then append,
    // and drop the localization indirection for this build.
    const resolved = resolveMessage(manifest.name, manifest.default_locale ?? "en");
    manifest.name = `${resolved} (test)`;
    // `description` keeps its placeholder; it resolves independently and is
    // still present in the locale file.
  }

  // ---- Validate BEFORE writing anything to release/ ---------------------
  //
  // Previously the package was written first and checked afterwards, so a
  // failure left a half-valid directory behind and still printed "packaged".
  // Everything that can be decided from the manifest is decided here.

  // Chrome accepts 1-4 dot-separated integers. `--suffix 5.5.5` used to produce
  // `2.4.6.5.5.5` (6 segments) which Chrome refuses, while this script reported
  // success.
  const versionSegments = String(manifest.version).split(".");
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) {
    console.error(
      `invalid version "${manifest.version}" — Chrome requires 1-4 dot-separated\n` +
        `integers. The suffix added ${versionSegments.length - 3} extra segment(s).`,
    );
    process.exit(2);
  }

  // Permission names are exact; a typo silently removes the API at runtime
  // (`chrome.storage` becomes undefined) and nothing else notices.
  const VALID_PERMISSIONS = new Set([
    "activeTab", "alarms", "audio", "background", "bookmarks", "browsingData",
    "certificateProvider", "clipboardRead", "clipboardWrite", "contentSettings",
    "contextMenus", "cookies", "debugger", "declarativeContent",
    "declarativeNetRequest", "declarativeNetRequestWithHostAccess",
    "declarativeNetRequestFeedback", "desktopCapture", "documentScan", "downloads",
    "downloads.open", "downloads.ui", "enterprise.deviceAttributes",
    "enterprise.hardwarePlatform", "enterprise.networkingAttributes",
    "enterprise.platformKeys", "favicon", "fileBrowserHandler", "fileSystemProvider",
    "fontSettings", "gcm", "geolocation", "history", "identity", "identity.email",
    "idle", "loginState", "management", "nativeMessaging", "notifications",
    "offscreen", "pageCapture", "platformKeys", "power", "printerProvider",
    "printing", "printingMetrics", "privacy", "processes", "proxy", "readingList",
    "scripting", "search", "sessions", "sidePanel", "storage", "system.cpu",
    "system.display", "system.memory", "system.storage", "tabCapture", "tabGroups",
    "tabs", "topSites", "tts", "ttsEngine", "unlimitedStorage", "vpnProvider",
    "wallpaper", "webAuthenticationProxy", "webNavigation", "webRequest",
    "webRequestBlocking",
  ]);
  const badPermissions = (manifest.permissions ?? []).filter((p) => {
    // Host patterns and optional qualified forms are not permission names.
    if (/[:/*<>]/.test(p)) return false;
    return !VALID_PERMISSIONS.has(p);
  });
  if (badPermissions.length) {
    console.error(
      `unknown permission(s): ${badPermissions.join(", ")}\n` +
        `Chrome ignores these silently, which disables the API at runtime.`,
    );
    process.exit(2);
  }

  // Every path the manifest references must exist in dist/ before copying.
  const preflightMissing = [];
  const needPre = (p) => {
    if (!p) return;
    const rel = String(p).replace(/^\//, "");
    if (!fs.existsSync(path.join(DIST, rel))) preflightMissing.push(rel);
  };
  needPre(manifest.background?.service_worker);
  needPre(manifest.side_panel?.default_path);
  needPre(manifest.options_ui?.page ?? manifest.options_page);
  for (const cs of manifest.content_scripts ?? []) for (const js of cs.js ?? []) needPre(js);
  for (const v of Object.values(manifest.icons ?? {})) needPre(v);
  if (preflightMissing.length) {
    console.error(
      `dist/ is missing files the manifest references: ${preflightMissing.join(", ")}\n` +
        `Run \`npm run build\` first.`,
    );
    process.exit(2);
  }

  // ---- Write the package ------------------------------------------------
  // Remove only the artifacts this run will recreate, not the whole release/
  // directory. Deleting release/ wholesale destroyed anything else the operator
  // had put there, including previous builds they were comparing against.
  const label = opts.suffix ? `test-${manifest.version}` : `test-${baseVersion}`;
  const pkgDir = path.join(RELEASE, `vcaptions-${label}`);
  const zipPathEarly = path.join(RELEASE, `vcaptions-${label}.zip`);
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.rmSync(zipPathEarly, { force: true });
  fs.mkdirSync(pkgDir, { recursive: true });

  copyTree(DIST, pkgDir);
  // Apply the manifest changes after copying so dist/ stays untouched.
  fs.writeFileSync(
    path.join(pkgDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const zipPath = path.join(RELEASE, `vcaptions-${label}.zip`);
  const count = writeZip(pkgDir, zipPath);

  const zipBytes = fs.readFileSync(zipPath);
  const dirBytes = walk(pkgDir).reduce((a, f) => a + fs.statSync(path.join(pkgDir, f)).size, 0);

  console.log("packaged extension");
  console.log(`  version:   ${manifest.version}`);
  console.log(`  name:      ${manifest.name}`);
  console.log(`  files:     ${count}`);
  console.log(`  unpacked:  ${(dirBytes / 1024 / 1024).toFixed(2)} MB  ${path.relative(ROOT, pkgDir)}`);
  console.log(`  zip:       ${(zipBytes.length / 1024 / 1024).toFixed(2)} MB  ${path.relative(ROOT, zipPath)}`);
  console.log(`  zip sha256: ${sha256(zipBytes).slice(0, 32)}…`);

  // Post-write sanity check: the emitted tree must still satisfy the contract.
  const missing = [];
  const need = (p) => {
    if (!p) return;
    const rel = String(p).replace(/^\//, "");
    if (!fs.existsSync(path.join(pkgDir, rel))) missing.push(rel);
  };
  need(manifest.background?.service_worker);
  need(manifest.side_panel?.default_path);
  need(manifest.options_ui?.page ?? manifest.options_page);
  for (const cs of manifest.content_scripts ?? []) for (const js of cs.js ?? []) need(js);
  for (const v of Object.values(manifest.icons ?? {})) need(v);

  if (missing.length) {
    console.error(`\npackage is INCOMPLETE — missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  // Every __MSG_ key left in the packaged manifest must resolve. A dangling key
  // makes Chrome display the raw placeholder as the extension name.
  const locale = manifest.default_locale ?? "en";
  const localeFile = path.join(pkgDir, "_locales", locale, "messages.json");
  const danglingKeys = [];
  if (fs.existsSync(localeFile)) {
    const messages = JSON.parse(fs.readFileSync(localeFile, "utf8"));
    const text = JSON.stringify(manifest);
    for (const m of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
      if (!messages[m[1]]?.message) danglingKeys.push(m[1]);
    }
  }
  if (danglingKeys.length) {
    console.error(
      `\npackage has UNRESOLVED i18n keys: ${[...new Set(danglingKeys)].join(", ")}`,
    );
    process.exit(1);
  }

  console.log("\npackage verified: every manifest reference resolves");
  console.log("package verified: every __MSG_ key resolves in the default locale");
}

main();
