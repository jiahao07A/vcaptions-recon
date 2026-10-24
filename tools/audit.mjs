#!/usr/bin/env node
/**
 * Static audit of the reconstructed bundles.
 *
 * Extracts the cross-context message protocol, storage keys, endpoints and
 * third-party dependencies directly from the bundles, so the reconstructed
 * architecture documentation is derived from the artifact instead of being
 * hand-maintained. Output is written to docs/architecture.generated.json.
 *
 * Usage: node tools/audit.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const DOCS = path.join(ROOT, "docs");

const SOURCES = {
  background: "static/background/index.js",
  content_main: "MainCS.277dcde3.js",
  content_iframe: "IFrameCS.26275720.js",
  content_youtube: "YoutubeCS.6bf33c81.js",
  content_webapp: "WebappCS.8b5d7cd6.js",
  content_app: "Main.00175a8f.js",
  content_subtitle_bar: "SubtitleBar.f2dae354.js",
  sidepanel: "sidepanel.65d86198.js",
  options: "options.6406b895.js",
  tab: "tabs/tab-main.1e0435ca.js",
};

/** Third-party libraries detected by signature, with the evidence used. */
const LIB_SIGNATURES = [
  { name: "react", test: /react\.transitional\.element/ },
  { name: "react-dom", test: /hydrateRoot/ },
  { name: "scheduler", test: /unstable_getCurrentPriorityLevel/ },
  { name: "webextension-polyfill", test: /webextension-polyfill|Failed to send onMessage rejected reply/ },
  { name: "buffer", test: /nodejs\.util\.inspect\.custom/ },
  { name: "base64-js", test: /Invalid string\. Length must be a multiple of 4/ },
  { name: "use-sync-external-store", test: /useSyncExternalStoreWithSelector/ },
  { name: "react-toastify", test: /Toastify__toast-container/ },
  { name: "i18next", test: /i18next|missingKey/ },
  { name: "immer", test: /Immer/ },
  { name: "dayjs", test: /dayjs/ },
  { name: "lodash", test: /lodash/ },
  { name: "openai", test: /\/chat\/completions/ },
  { name: "posthog", test: /posthog/ },
  { name: "pinyin", test: /ZHOU.*XIAN.*XING/ },
  { name: "idb", test: /indexedDB\.open/ },
  { name: "virtuoso", test: /data-virtuoso-scroller/ },
  { name: "daisyui", test: /--rounded-box/ },
  { name: "tailwindcss", test: /@tailwind/ },
];

function read(rel) {
  const abs = path.join(DIST, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

function uniq(re, text, group = 1) {
  const out = new Set();
  for (const m of text.matchAll(re)) if (m[group]) out.add(m[group]);
  return [...out].sort();
}

function main() {
  // Refuse to run without a build. Otherwise every source reads as null, the
  // audit happily writes an all-zero report over the committed one, and the
  // damage is invisible because a later run with dist/ present "fixes" it.
  if (!fs.existsSync(path.join(DIST, "manifest.json"))) {
    console.error(
      "audit: dist/ is missing or incomplete — refusing to write an empty report.\n" +
        "       Run `npm run build` first, then re-run the audit.",
    );
    process.exit(2);
  }

  const src = {};
  const missingSources = [];
  for (const [key, rel] of Object.entries(SOURCES)) {
    const text = read(rel);
    if (text === null) missingSources.push(rel);
    src[key] = text;
  }
  if (missingSources.length) {
    console.error(
      `audit: these expected bundles are missing from dist/: ${missingSources.join(", ")}\n` +
        "       Refusing to write a partial report.",
    );
    process.exit(2);
  }

  // Cross-context protocol -------------------------------------------------
  // Handlers exist in several layers: the service worker answers
  // chrome.runtime messages, UI bundles answer app-layer messages routed through
  // the background, and content scripts answer tab-level actions. Counting only
  // the worker understates the protocol, so layers are reported separately and
  // the union is reported as the authoritative total.
  const bg = src.background ?? "";
  const uiBundles = ["content_app", "sidepanel", "tab"];
  const csBundles = [
    "content_main",
    "content_iframe",
    "content_youtube",
    "content_webapp",
    "content_subtitle_bar",
  ];
  const uiText = uiBundles.map((k) => src[k]).filter(Boolean).join("\n");
  const csText = csBundles.map((k) => src[k]).filter(Boolean).join("\n");

  // Handlers look like `NAME: async (...) =>`, `NAME: async arg =>`, or
  // `NAME: (...) =>`. A few globals and library constants share that shape and
  // must not be counted; the deny-list keeps the inventory honest.
  const HANDLER_RE = /([A-Z][A-Z0-9_]{3,60}):\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/g;
  const NOT_HANDLERS = new Set([
    "PROBE_UNKNOWN_ACTION",
    "REDUX_DEVTOOLS_EXTENSION_COMPOSE__",
    "SC_DISABLE_SPEEDY",
    "RFC1738",
  ]);
  const collect = (text) => uniq(HANDLER_RE, text).filter((h) => !NOT_HANDLERS.has(h));

  const bgHandlers = collect(bg);
  const uiHandlers = collect(uiText);
  const csHandlers = collect(csText);

  const all = Object.values(src).filter(Boolean).join("\n");
  const handlers = collect(all);
  const tabActions = uniq(/["'`](vcaptions_[a-z_]+)["'`]/g, all);
  const appCommands = uniq(/["'`]((?:APP|BAR)_[A-Z0-9_]+)["'`]/g, all);
  const runtimeMessages = uniq(/"source:"(vcaptions-[a-z]+)"/g, all);

  // Feature domains, grouped by handler prefix ------------------------------
  const domains = {};
  for (const h of handlers) {
    const key = h.split("_")[0];
    (domains[key] ??= []).push(h);
  }

  // Storage keys -----------------------------------------------------------
  // Extracted from actual storage call sites, not by guessing at identifier
  // names. The previous regex matched anything ending in Config/Info/Session,
  // which pulled in six i18n translation keys (they are passed to `t(...)`, not
  // to storage) and missed real keys such as `vcaptions-auth-token` because they
  // are hyphenated and resolved through a constant.
  const storageKeys = new Set();

  /**
   * Decide whether an identifier is plausibly an application storage key.
   *
   * Storage calls in the bundle sit next to library code that uses the same
   * shape with unrelated literals ("buffer", "function", "sha512", cipher
   * tables). Accepting those made the key list mostly noise. A real key here is
   * either namespaced (`vcaptions-*`) or one of the domain terms the app owns.
   *
   * The domain terms are the ones the background declares alongside the
   * namespaced keys — `GX="videoInfo"`, `GR="chapterInfo"`, `Gg="subtitleInfo"`,
   * `GH="chatSession"`, `GO="noteInfo"` appear in the same declaration run as
   * `Gy="vcaptions-auth-token"`, so they carry the same meaning.
   */
  const isPlausibleStorageKey = (key) => {
    if (!/^[A-Za-z][\w-]{2,60}$/.test(key)) return false;
    if (/^(function|object|string|number|boolean|undefined|null|buffer|sha512|rmd160|utf8|en|fallback|properties|timestamp)$/.test(key)) {
      return false;
    }
    if (/^[A-Za-z0-9+/]{20,}$/.test(key)) return false; // base64 alphabets
    return /^(vcaptions[-_]|websiteConfig|subtitle|chapter|chat|note|video|transcription|finetune|translate|analytics_|posthog_|app)/.test(
      key,
    );
  };

  /**
   * Resolve `NAME` to a string literal, but only when the assignment is
   * unambiguous across the whole bundle set.
   *
   * The naive version matched any `NAME = "..."` anywhere, so a dynamic local
   * (`let t = ...`) picked up an unrelated same-named constant and injected
   * library strings like "function"/"utf8" into the key list. Requiring exactly
   * one distinct value, and rejecting single-letter or heavily reused names,
   * keeps this to real module-level constants.
   */
  const resolveConst = (name) => {
    if (name.length < 3) return null; // dynamic locals are usually t/I/G/e
    const values = new Set();
    const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']{1,80})["']`, "g");
    for (const text of Object.values(src)) {
      if (!text) continue;
      for (const hit of text.matchAll(re)) values.add(hit[1]);
      if (values.size > 1) return null; // ambiguous
    }
    if (values.size !== 1) return null;
    const [only] = values;
    return isPlausibleStorageKey(only) ? only : null;
  };

  for (const text of Object.values(src)) {
    if (!text) continue;

    // Direct string argument: storage.local.get("key") / .remove("key")
    for (const m of text.matchAll(
      /storage\.(?:local|session|sync)\.(?:get|remove)\(\s*["']([^"']{1,80})["']/g,
    )) {
      if (isPlausibleStorageKey(m[1])) storageKeys.add(m[1]);
    }

    // Object literal passed to get({key: default}) or set({key: value}).
    // Only accept keys that look like application storage keys: library code
    // also calls storage-like APIs with unrelated literals (cipher names,
    // encoding tables), and accepting those buried the real keys in noise.
    for (const m of text.matchAll(/storage\.(?:local|session|sync)\.(?:get|set)\(\s*\{([^}]{0,600})/g)) {
      for (const k of m[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$-]*)\s*:/g)) {
        const key = k[1];
        if (!isPlausibleStorageKey(key)) continue;
        storageKeys.add(key);
      }
    }

    // Computed key from a constant: set({[K]: v}) or get(K)
    for (const m of text.matchAll(
      /storage\.(?:local|session|sync)\.(?:get|set|remove)\(\s*(?:\[\s*)?([A-Za-z_$][\w$]*)/g,
    )) {
      const resolved = resolveConst(m[1]);
      if (resolved) storageKeys.add(resolved);
    }
    for (const m of text.matchAll(/storage\.(?:local|session|sync)\.(?:get|set)\(\s*\{\s*\[([A-Za-z_$][\w$]*)\]/g)) {
      const resolved = resolveConst(m[1]);
      if (resolved) storageKeys.add(resolved);
    }

    // Extension-namespaced literal keys used as storage identifiers. These are
    // the hyphenated form the identifier-based regex could never match.
    for (const m of text.matchAll(/["'](vcaptions[-_][a-z][\w-]{2,40})["']/g)) {
      const candidate = m[1];
      // Exclude message/action names and DOM ids: those are never storage keys.
      if (/^vcaptions_(mount|unmount|toggle_mount|subtitle_bar_|log_config)/.test(candidate)) {
        if (candidate === "vcaptions_log_config") storageKeys.add(candidate);
        continue;
      }
      if (/^vcaptions-(extension|webapp|env|temp|list|bar|subtitle|inner|assistant)/.test(candidate)) {
        // DOM ids and message sources, not storage keys, except env/temp/auth/global.
        if (!/^vcaptions-(env|temp|auth|global)/.test(candidate)) continue;
      }
      storageKeys.add(candidate);
    }
  }

  // Analytics keys persisted through the storage wrapper.
  // `analytics_control` is deliberately excluded: it is a remote settings name
  // read via `getSetting("analytics_control", ...)` from the server-provided
  // settings cache, not a key written to chrome.storage.
  for (const m of all.matchAll(/["']((?:posthog|analytics)_[a-z_]{3,40})["']/g)) {
    if (m[1] === "analytics_control") continue;
    storageKeys.add(m[1]);
  }

  // Constants declared in the same run as the namespaced keys. The background
  // declares its storage-key table as one comma-separated chain, e.g.
  //   GX="videoInfo",GR="chapterInfo",...,Gy="vcaptions-auth-token"
  // Those domain names are storage keys even though they are not hyphenated and
  // are not literals at the call site.
  for (const m of all.matchAll(
    /["'](vcaptions-(?:auth-token|auth-refresh-token|auth-user|env|temp|global-settings))["']/g,
  )) {
    // Find the declaration chain this literal belongs to and collect siblings.
    const at = m.index ?? 0;
    const windowStart = Math.max(0, at - 1200);
    const windowText = all.slice(windowStart, at + 400);
    for (const s of windowText.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*["']([A-Za-z][\w-]{2,60})["']/g)) {
      if (isPlausibleStorageKey(s[2])) storageKeys.add(s[2]);
    }
  }

  // Drop non-key entries that slipped through (action names are not storage).
  for (const k of [...storageKeys]) {
    if (/^vcaptions_(mount|unmount|toggle_mount|subtitle_bar_|assistant)$/.test(k)) {
      storageKeys.delete(k);
    }
  }

  // Endpoints --------------------------------------------------------------
  // Two kinds of endpoint evidence exist and must not be conflated:
  //   absolute  full URLs the extension calls (API hosts, docs links)
  //   relative  SDK-internal path fragments such as "/chat/completions", which
  //             belong to a bundled client library, not to app code
  const allEndpointLiterals = uniq(
    /"((?:https?:\/\/|\/)[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]{3,120})"/g,
    all,
  ).filter((e) => !e.includes("${"));

  const absoluteEndpoints = allEndpointLiterals.filter((e) => /^https?:\/\//.test(e));
  const relativePaths = allEndpointLiterals.filter((e) => e.startsWith("/"));
  const endpoints = allEndpointLiterals;

  // Permissions actually exercised -----------------------------------------
  // Direct `chrome.X.Y` member accesses. Most extension API calls go through
  // webextension-polyfill, so this counts direct call sites only; the polyfill
  // layer is detected separately under `libraries`.
  const chromeApiSites = [...all.matchAll(/chrome\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map(
    (m) => `${m[1]}.${m[2]}`,
  );
  const chromeApis = [...new Set(chromeApiSites)].sort();

  // Dependencies -----------------------------------------------------------
  const libraries = [];
  for (const lib of LIB_SIGNATURES) {
    const hits = Object.entries(src)
      .filter(([, text]) => text && lib.test.test(text))
      .map(([k]) => k);
    if (hits.length) libraries.push({ name: lib.name, found_in: hits });
  }

  const report = {
    generated_at: new Date().toISOString(),
    generated_by: "tools/audit.mjs",
    source: "dist/ (reassembled from assets/baseline/extension-v2.4.6)",
    bundles: Object.fromEntries(
      Object.entries(SOURCES).map(([k, rel]) => {
        const text = src[k];
        return [k, { file: rel, bytes: text ? Buffer.byteLength(text, "utf8") : null }];
      }),
    ),
    protocol: {
      // Handlers live in three layers; each is reported separately so no single
      // count is mistaken for the whole protocol.
      background_handlers: bgHandlers,
      background_handler_count: bgHandlers.length,
      ui_handlers: uiHandlers,
      ui_handler_count: uiHandlers.length,
      content_script_handlers: csHandlers,
      content_script_handler_count: csHandlers.length,
      all_handlers: handlers,
      all_handler_count: handlers.length,
      feature_domains: domains,
      tab_actions: tabActions,
      app_commands: appCommands,
      window_postmessage_sources: runtimeMessages,
    },
    storage_keys: [...storageKeys].sort(),
    endpoints,
    absolute_endpoints: absoluteEndpoints,
    relative_sdk_paths: relativePaths,
    chrome_apis: chromeApis,
    chrome_api_call_site_count: chromeApiSites.length,
    libraries,
  };

  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(
    path.join(DOCS, "architecture.generated.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  console.log(`background handlers: ${bgHandlers.length}`);
  console.log(`ui handlers:         ${uiHandlers.length}`);
  console.log(`content handlers:    ${csHandlers.length}`);
  console.log(`all handlers (union):${handlers.length}`);
  console.log(`feature domains:     ${Object.keys(domains).length}`);
  console.log(`tab actions:         ${tabActions.length}`);
  console.log(`app commands:        ${appCommands.length}`);
  console.log(`storage keys:        ${[...storageKeys].length}`);
  console.log(`endpoints:           ${absoluteEndpoints.length} absolute, ${relativePaths.length} SDK paths`);
  console.log(`chrome APIs:         ${chromeApis.length} (${chromeApiSites.length} call sites)`);
  console.log(`libraries:           ${libraries.map((l) => l.name).join(", ")}`);
  console.log(`\nwritten docs/architecture.generated.json`);
}

main();
