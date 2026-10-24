#!/usr/bin/env node
/**
 * Structural validation of the built extension.
 *
 * Verifies that every path referenced by manifest.json exists in dist/, that the
 * service worker and content scripts parse as JavaScript, and that the emitted
 * tree is complete enough to load in Chrome as an unpacked extension.
 *
 * Usage: node tools/check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");
// VCAPTIONS_DIST lets tests point the validator at a scratch copy, so the
// validator's own effectiveness can be tested without touching dist/.
const DIST = process.env.VCAPTIONS_DIST
  ? path.resolve(process.env.VCAPTIONS_DIST)
  : path.join(ROOT, "dist");

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`FAIL  ${msg}`);
};
const ok = (msg) => console.log(`ok    ${msg}`);

function main() {
  const manifestPath = path.join(DIST, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    fail("dist/manifest.json missing (run `npm run build`)");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  // Structural requirements. Existence checks alone are one-directional: they
  // catch a referenced file that is missing, but deleting a whole manifest
  // section removes the reference too, so nothing is left to check and the
  // report says "check passed". These assertions pin what the package must
  // contain regardless of what the manifest happens to mention.
  const required = [
    ["background.service_worker", manifest.background?.service_worker],
    ["side_panel.default_path", manifest.side_panel?.default_path],
    ["options_ui.page or options_page", manifest.options_ui?.page ?? manifest.options_page],
    ["icons", Object.keys(manifest.icons ?? {}).length ? "present" : undefined],
  ];
  for (const [label, value] of required) {
    if (value) ok(`manifest declares ${label}`);
    else fail(`manifest is missing ${label} — Chrome would refuse or degrade the package`);
  }

  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
    fail("manifest declares no content_scripts — the extension would inject nothing");
  } else {
    const jsCount = manifest.content_scripts.reduce((a, cs) => a + (cs.js?.length ?? 0), 0);
    ok(`${manifest.content_scripts.length} content_script blocks, ${jsCount} scripts`);
  }

  // Every referenced resource must exist.
  const referenced = new Set();
  const add = (p) => p && referenced.add(p.replace(/^\//, ""));

  add(manifest.background?.service_worker);
  add(manifest.options_ui?.page);
  add(manifest.options_page);
  add(manifest.side_panel?.default_path);
  for (const cs of manifest.content_scripts ?? []) {
    for (const js of cs.js ?? []) add(js);
    for (const css of cs.css ?? []) add(css);
  }
  for (const v of Object.values(manifest.icons ?? {})) add(v);
  for (const v of Object.values(manifest.action?.default_icon ?? {})) add(v);

  for (const rel of [...referenced].sort()) {
    if (fs.existsSync(path.join(DIST, rel))) ok(`resource ${rel}`);
    else fail(`missing resource ${rel}`);
  }

  // HTML entry points must reference scripts that exist.
  for (const html of ["options.html", "sidepanel.html", "tabs/tab-main.html"]) {
    const abs = path.join(DIST, html);
    if (!fs.existsSync(abs)) {
      fail(`missing ${html}`);
      continue;
    }
    const text = fs.readFileSync(abs, "utf8");
    for (const m of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const rel = m[1].replace(/^\//, "");
      if (rel.startsWith("http")) continue;
      if (fs.existsSync(path.join(DIST, rel))) ok(`${html} -> ${rel}`);
      else fail(`${html} references missing ${rel}`);
    }
  }

  // Locales must define every __MSG_* key the manifest uses. A missing default
  // locale file is fatal, not skippable: Chrome would render the raw __MSG_
  // placeholder as the extension name.
  const defaultLocale = manifest.default_locale ?? "en";
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const msgKeys = new Set([...manifestText.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1]));

  const messagesPath = path.join(DIST, "_locales", defaultLocale, "messages.json");
  if (!fs.existsSync(messagesPath)) {
    fail(
      `missing _locales/${defaultLocale}/messages.json` +
        (msgKeys.size ? ` (manifest uses ${msgKeys.size} __MSG_ key(s))` : ""),
    );
  } else {
    let messages = null;
    try {
      messages = JSON.parse(fs.readFileSync(messagesPath, "utf8"));
    } catch (err) {
      fail(`_locales/${defaultLocale}/messages.json is not valid JSON: ${err.message}`);
    }
    if (messages) {
      for (const key of msgKeys) {
        if (messages[key]?.message) ok(`i18n ${key}`);
        else fail(`manifest uses __MSG_${key}__ but ${defaultLocale}/messages.json lacks it`);
      }
      // Every declared locale must at least parse, or Chrome rejects the package.
      const localesDir = path.join(DIST, "_locales");
      if (fs.existsSync(localesDir)) {
        for (const locale of fs.readdirSync(localesDir)) {
          const file = path.join(localesDir, locale, "messages.json");
          if (!fs.existsSync(file)) {
            fail(`locale ${locale} has no messages.json`);
            continue;
          }
          try {
            JSON.parse(fs.readFileSync(file, "utf8"));
            ok(`locale ${locale} parses`);
          } catch (err) {
            fail(`locale ${locale} messages.json is invalid: ${err.message}`);
          }
        }
      }
    }
  }

  // Scripts must at least parse. Check every .js in the package, not just the
  // ones the manifest names directly: a bundle can be reachable through another
  // bundle's runtime URL resolution, and a broken one that nothing points at
  // still ships. Checking only manifest-referenced files left four bundles
  // unchecked.
  const allScripts = [];
  const walkJs = (dir, base = dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walkJs(abs, base);
      else if (entry.name.endsWith(".js")) {
        allScripts.push(path.relative(base, abs).split(path.sep).join("/"));
      }
    }
  };
  if (fs.existsSync(DIST)) walkJs(DIST);

  const parseFailures = [];
  for (const rel of allScripts.sort()) {
    const abs = path.join(DIST, rel);
    const code = fs.readFileSync(abs, "utf8");
    try {
      new vm.Script(code, { filename: rel });
    } catch (err) {
      parseFailures.push({ rel, message: err.message });
      fail(`syntax error in ${rel}: ${err.message}`);
    }
  }
  if (parseFailures.length === 0) {
    ok(`all ${allScripts.length} JavaScript files parse`);
  }

  // Manifest contract checks that Chrome enforces at load time. A violation
  // makes the browser refuse the whole extension, so they belong here rather
  // than being discovered during a manual load.
  if (manifest.manifest_version !== 3) {
    fail(`manifest_version must be 3 for this build, found ${manifest.manifest_version}`);
  } else {
    ok("manifest_version is 3");
  }

  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? "")) {
    fail(`version "${manifest.version}" is not 1-4 dot-separated integers`);
  } else {
    ok(`version ${manifest.version} is Chrome-valid`);
  }

  // Permission names are exact strings. A typo (`stoarge` for `storage`) does
  // not fail to load — Chrome simply ignores the unknown name, so the API
  // vanishes at runtime with no error anywhere. Validate against the known set.
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
  const declared = manifest.permissions ?? [];
  const unknownPermissions = [];
  const malformedPermissions = [];
  for (const p of declared) {
    if (typeof p !== "string") {
      malformedPermissions.push(JSON.stringify(p));
      continue;
    }
    // Host patterns are legitimate entries in `permissions`.
    const isHostPattern = /^(?:https?|wss?|\*):\/\//.test(p) || p === "<all_urls>";
    if (isHostPattern) continue;
    // Anything else must be an exact permission name. The old filter accepted
    // `storage/`, `storage:*` and similar by treating any `/ : * < >` as a host
    // pattern, so a typo with a stray suffix passed the whitelist.
    if (!VALID_PERMISSIONS.has(p)) unknownPermissions.push(p);
  }
  if (malformedPermissions.length) {
    fail(`non-string permission entries: ${malformedPermissions.join(", ")}`);
  }
  if (unknownPermissions.length) {
    fail(
      `unknown permission(s): ${unknownPermissions.join(", ")} ` +
        `(Chrome ignores these silently, disabling the API at runtime)`,
    );
  } else if (declared.length) {
    ok(`${declared.length} declared permissions are recognised`);
  }

  // The extension must declare the APIs its bundles actually call. This catches
  // the inverse mistake: code that uses chrome.storage with the permission
  // removed.
  const usedApis = new Set();
  if (fs.existsSync(DIST)) {
    const scanJs = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) scanJs(abs);
        else if (e.name.endsWith(".js")) {
          const code = fs.readFileSync(abs, "utf8");
          for (const m of code.matchAll(/chrome\.([a-zA-Z]+)\./g)) usedApis.add(m[1]);
        }
      }
    };
    scanJs(DIST);
  }
  // Map API namespace -> required permission (only the non-trivial ones).
  // Map every chrome.* namespace that requires a manifest permission to that
  // permission. The earlier table covered 12 namespaces, so code using e.g.
  // chrome.alarms without declaring `alarms` passed unnoticed. Entries whose
  // permission is optional or implicit are omitted rather than guessed.
  const API_PERMISSION = {
    alarms: "alarms",
    bookmarks: "bookmarks",
    browsingData: "browsingData",
    certificateProvider: "certificateProvider",
    clipboard: "clipboardRead",
    contentSettings: "contentSettings",
    contextMenus: "contextMenus",
    cookies: "cookies",
    debugger: "debugger",
    declarativeContent: "declarativeContent",
    declarativeNetRequest: "declarativeNetRequest",
    desktopCapture: "desktopCapture",
    documentScan: "documentScan",
    downloads: "downloads",
    enterprise: "enterprise.deviceAttributes",
    fileBrowserHandler: "fileBrowserHandler",
    fileSystemProvider: "fileSystemProvider",
    fontSettings: "fontSettings",
    gcm: "gcm",
    history: "history",
    identity: "identity",
    idle: "idle",
    loginState: "loginState",
    management: "management",
    notifications: "notifications",
    offscreen: "offscreen",
    pageCapture: "pageCapture",
    platformKeys: "platformKeys",
    power: "power",
    printerProvider: "printerProvider",
    printing: "printing",
    printingMetrics: "printingMetrics",
    privacy: "privacy",
    processes: "processes",
    proxy: "proxy",
    readingList: "readingList",
    scripting: "scripting",
    search: "search",
    sessions: "sessions",
    sidePanel: "sidePanel",
    storage: "storage",
    system: "system.cpu",
    tabCapture: "tabCapture",
    tabGroups: "tabGroups",
    tabs: "tabs",
    topSites: "topSites",
    tts: "tts",
    ttsEngine: "ttsEngine",
    vpnProvider: "vpnProvider",
    wallpaper: "wallpaper",
    webAuthenticationProxy: "webAuthenticationProxy",
    webNavigation: "webNavigation",
    webRequest: "webRequest",
  };

  // Namespaces that need no permission, or whose permission differs by call.
  // Listing them explicitly documents the decision instead of leaving a silent
  // gap in the cross-check.
  const NO_PERMISSION_NEEDED = new Set(["action", "commands", "i18n", "runtime", "windows"]);

  const missingPermissions = [];
  const unmappedApis = [];
  for (const api of usedApis) {
    if (NO_PERMISSION_NEEDED.has(api)) continue;
    const required = API_PERMISSION[api];
    if (!required) {
      unmappedApis.push(api);
      continue;
    }
    if (!declared.includes(required)) missingPermissions.push(`${api} -> ${required}`);
  }
  if (unmappedApis.length) {
    // Not a hard failure: a new namespace may genuinely need no permission. But
    // reporting it keeps the cross-check honest instead of silently skipping.
    ok(`APIs with no permission mapping (review if new): ${unmappedApis.join(", ")}`);
  }
  if (missingPermissions.length) {
    fail(
      `code uses these APIs but the permissions are not declared: ` +
        missingPermissions.join(", "),
    );
  } else if (usedApis.size) {
    ok("every chrome.* API used by the bundles has its permission declared");
  }

  // content_scripts match patterns: an invalid pattern makes Chrome reject the
  // extension outright.
  const isValidMatch = (pattern) =>
    /^(\*|https?|file|ftp|urn):\/\/(\*|\*\.[^/*]+|[^/*]+)?\/.*$/.test(pattern) ||
    pattern === "<all_urls>";
  let matchCount = 0;
  for (const cs of manifest.content_scripts ?? []) {
    for (const pattern of cs.matches ?? []) {
      matchCount++;
      if (!isValidMatch(pattern)) fail(`invalid match pattern: ${pattern}`);
    }
  }
  if (matchCount) ok(`${matchCount} content_script match patterns are well-formed`);

  // web_accessible_resources entries must name real files, otherwise the
  // resource silently 404s at runtime.
  // web_accessible_resources entries must name real files. Patterns may contain
  // wildcards; skipping those made the real `*.css` pattern entirely unchecked,
  // so a missing stylesheet would ship silently. Expand each pattern against the
  // package and require at least one match.
  const expandWarPattern = (pattern) => {
    const rel = pattern.replace(/^\//, "");

    // Reject traversal: a pattern that escapes dist/ would "resolve" against a
    // file outside the package, which Chrome never serves.
    if (rel.split("/").some((seg) => seg === "..")) return { matches: [], traversal: true };

    if (!rel.includes("*")) {
      const abs = path.resolve(DIST, rel);
      if (!abs.startsWith(path.resolve(DIST) + path.sep)) return { matches: [], traversal: true };
      return { matches: fs.existsSync(abs) ? [rel] : [] };
    }
    // Convert the glob to a regex over package-relative paths.
    const re = new RegExp(
      `^${rel
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*")}$`,
    );
    const matches = [];
    const walk = (dir, base = dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs, base);
        else {
          const relPath = path.relative(base, abs).split(path.sep).join("/");
          if (re.test(relPath)) matches.push(relPath);
        }
      }
    };
    if (fs.existsSync(DIST)) walk(DIST);
    return { matches };
  };

  let warChecked = 0;
  for (const war of manifest.web_accessible_resources ?? []) {
    for (const pattern of war.resources ?? []) {
      const { matches, traversal } = expandWarPattern(pattern);
      if (traversal) {
        fail(`web_accessible_resources pattern "${pattern}" escapes the package`);
      } else if (matches.length === 0) {
        fail(`web_accessible_resources pattern "${pattern}" matches no files`);
      } else {
        warChecked += matches.length;
      }
    }
  }
  if (warChecked) ok(`${warChecked} web_accessible_resources files resolve`);

  // Stylesheets the content scripts rely on at runtime. The WAR glob `*.css`
  // was satisfied by any single match, so deleting daisyui/style/subtitleBar
  // still passed while the injected UI lost its styling. These are named
  // explicitly because the extension loads them by name.
  for (const css of ["daisyui.css", "style.css", "subtitleBar.css"]) {
    if (fs.existsSync(path.join(DIST, css))) ok(`runtime stylesheet ${css}`);
    else fail(`runtime stylesheet ${css} is missing — injected UI would be unstyled`);
  }

  console.log(`\n${failures === 0 ? "check passed" : `${failures} problem(s) found`}`);
  if (failures) process.exit(1);
}

main();
