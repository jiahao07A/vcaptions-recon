#!/usr/bin/env node
/**
 * Documentation and inventory consistency test.
 *
 * The project derives facts two ways: `tools/audit.mjs` scans the built bundles,
 * and `tools/index-symbols.mjs` scans the readable tree. When their extraction
 * rules drift, the documentation starts quoting numbers that no longer agree
 * with each other — which is how three different handler counts once coexisted.
 *
 * This test asserts that both tools agree on every shared inventory, and that
 * the numbers quoted in the docs match the generated JSON. A failure here means
 * a doc is stale or one extractor regressed.
 *
 * Usage: node tests/consistency.check.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS = path.join(ROOT, "docs");

let failures = 0;
const report = (line = "") => process.stdout.write(`${line}\n`);
const check = (label, ok, detail) => {
  if (ok) report(`ok    ${label}`);
  else {
    failures++;
    report(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

function readJson(rel) {
  const abs = path.join(DOCS, rel);
  if (!fs.existsSync(abs)) return null;
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function setOf(entries, category) {
  return new Set(entries.filter((e) => e.category === category).map((e) => e.value));
}

/** Compare two sets and describe the symmetric difference. */
function diff(a, b) {
  const onlyA = [...a].filter((x) => !b.has(x));
  const onlyB = [...b].filter((x) => !a.has(x));
  return { onlyA, onlyB, equal: onlyA.length === 0 && onlyB.length === 0 };
}

function main() {
  const arch = readJson("architecture.generated.json");
  const index = readJson("symbol-index.json");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const archDoc = fs.readFileSync(path.join(DOCS, "architecture.md"), "utf8");

  if (!arch || !index) {
    report("generated docs missing; run `npm run audit` and `npm run index` first");
    process.exit(2);
  }

  report("=== extractor agreement ===\n");

  // Handlers: both tools must produce the same name set.
  {
    const fromIndex = setOf(index.entries, "background_handler");
    const fromAudit = new Set(arch.protocol.all_handlers);
    const d = diff(fromIndex, fromAudit);
    check(
      "handler inventories agree",
      d.equal,
      `index-only=${d.onlyA.slice(0, 4).join(",")} audit-only=${d.onlyB.slice(0, 4).join(",")}`,
    );
  }

  // Endpoints: the index records absolute URLs, so compare against those only.
  {
    const fromIndex = setOf(index.entries, "endpoint");
    const fromAudit = new Set(arch.absolute_endpoints);
    const d = diff(fromIndex, fromAudit);
    check(
      "endpoint inventories agree",
      d.equal,
      `index-only=${d.onlyA.slice(0, 4).join(",")} audit-only=${d.onlyB.slice(0, 4).join(",")}`,
    );
  }

  // Storage keys: the index reads its key set from the audit, so comparing the
  // two proves nothing. Verify instead against the artifact directly — every
  // reported key must actually appear at a storage call site, and no i18n
  // translation key may be reported as storage.
  {
    const fromIndex = setOf(index.entries, "storage_key");
    const fromAudit = new Set(arch.storage_keys);

    // Independent ground truth: scan the built bundles for storage call sites.
    const distDir = path.join(ROOT, "dist");
    const bundleText = [];
    const collect = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) collect(abs);
        else if (e.name.endsWith(".js")) bundleText.push(fs.readFileSync(abs, "utf8"));
      }
    };
    if (fs.existsSync(distDir)) collect(distDir);
    const allBundles = bundleText.join("\n");

    // A key is corroborated if it is declared as a constant in the same
    // declaration run as a namespaced storage key, appears directly at a
    // storage call site, or is declared as a named constant that is later
    // passed to storage by variable. Keys like `chapterInfo` and
    // `analytics_identify_throttle` are used through a variable
    // (`storage.local.get(GR)`), so requiring a literal at the call site
    // produces false negatives.
    const corroborated = [...fromAudit].filter((k) => {
      const idx = allBundles.indexOf(`"${k}"`);
      if (idx === -1) return false;
      const near = allBundles.slice(Math.max(0, idx - 500), idx + 500);
      const atCallSite = /storage\.(?:local|session|sync)/.test(near);
      const declaredWithNamespaced = /vcaptions-(?:auth-token|env|temp|global-settings|log_config)/.test(near);
      // Named-constant form: `XX="key"` — find the identifier and see whether it
      // is passed to a storage call anywhere in the bundles.
      const decl = new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*"${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(allBundles);
      let viaVariable = false;
      if (decl) {
        const varName = decl[1];
        viaVariable = new RegExp(
          `storage\\.(?:local|session|sync)\\.(?:get|set|remove)\\(\\s*(?:\\{\\s*)?\\[?${varName}\\b`,
        ).test(allBundles);
      }
      return atCallSite || declaredWithNamespaced || viaVariable;
    });
    const uncorroborated = [...fromAudit].filter((k) => !corroborated.includes(k));
    check(
      "every reported storage key appears at a storage call site",
      uncorroborated.length === 0,
      uncorroborated.slice(0, 5).join(", "),
    );

    // The assertion above is one-directional: it proves every *reported* key is
    // real, but not that every *real* key is reported. A key silently dropped
    // from the audit would leave nothing to check. Derive the key set from the
    // artifact independently and compare both ways.
    //
    // Independent derivation: identifiers assigned a short string literal that is
    // then passed to a storage call. That is the shape the bundles use for their
    // key table, and it does not read the audit output at all.
    const derivedFromArtifact = new Set();
    for (const m of allBundles.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*"([A-Za-z][\w-]{2,60})"/g)) {
      const [, varName, value] = m;
      const usedInStorage = new RegExp(
        `storage\\.(?:local|session|sync)\\.(?:get|set|remove)\\(\\s*(?:\\{\\s*)?\\[?${varName}\\b`,
      ).test(allBundles);
      if (usedInStorage && /^(vcaptions[-_]|websiteConfig|subtitle|chapter|chat|note|video|transcription|finetune|translate|analytics_|posthog_|app)/.test(value)) {
        derivedFromArtifact.add(value);
      }
    }
    // Keys passed as literal arguments need no variable indirection.
    for (const m of allBundles.matchAll(
      /storage\.(?:local|session|sync)\.(?:get|remove)\(\s*"([^"]{3,60})"/g,
    )) {
      derivedFromArtifact.add(m[1]);
    }

    const droppedKeys = [...derivedFromArtifact].filter(
      (k) => !fromAudit.has(k) && !asTranslationKey(k),
    );
    check(
      "no storage key found in the artifact is missing from the audit",
      droppedKeys.length === 0,
      `missing: ${droppedKeys.slice(0, 6).join(", ")}`,
    );

    // i18n keys are passed to t(...), never to storage. Reporting one as a
    // storage key was the original defect; assert the shapes stay separated.
    //
    // The previous check built a +/-60 character window and then searched it for
    // `t(` immediately followed by the key. The window always starts with the
    // opening quote, so `t(` could never be at its end, and the assertion was
    // vacuously true for every input.
    //
    // A second problem: the translation helper is minified to a single letter
    // (`e("key")`, `r("key")`), so matching only `t(` missed every real lookup.
    // The detector therefore accepts any identifier of 1-2 characters followed
    // by `("key"` — the shape minifiers produce for a lookup function.
    // A real translation lookup passes a fallback: `e("key", "Default text")`.
    // A storage key appears as a plain argument (`get("key")`) or an object key.
    // Requiring the fallback argument separates the two without depending on the
    // minified helper's name, which is a single letter.
    const asTranslationKey = (k) => {
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const callRe = new RegExp(
        `(?:[A-Za-z_$][\\w$]?|i18n\\.t|translate)\\(\\s*["']${escaped}["']\\s*,`,
      );
      return callRe.test(allBundles);
    };
    const i18nAsStorage = [...fromAudit].filter(asTranslationKey);
    check(
      "no key used as a translation lookup is reported as a storage key",
      i18nAsStorage.length === 0,
      i18nAsStorage.slice(0, 5).join(", "),
    );

    // Sanity: the detector must actually find translation lookups. Without this,
    // a broken regex would make the assertion above pass for the wrong reason.
    const knownTranslationKeys = ["chapterNavigation_deleteSession", "websiteConfigBtn_websiteConfig"];
    const detected = knownTranslationKeys.filter(asTranslationKey);
    check(
      "the translation-lookup detector recognises known keys",
      detected.length > 0,
      `detected ${detected.length}/${knownTranslationKeys.length} — detector may be broken`,
    );

    // The index must still cover every key the audit found.
    const missingFromIndex = [...fromAudit].filter((k) => !fromIndex.has(k));
    check(
      "index covers every audited storage key",
      missingFromIndex.length === 0,
      missingFromIndex.slice(0, 5).join(", "),
    );
  }

  // Tab actions: a token may legitimately be both a storage key and an action
  // (vcaptions_log_config is sent as an action and stored as a config key), so
  // the index records it once under its more specific category. Compare against
  // the union of both categories to avoid a false failure.
  {
    const fromIndex = new Set([
      ...setOf(index.entries, "tab_action"),
      ...setOf(index.entries, "storage_key"),
    ]);
    const fromAudit = new Set(arch.protocol.tab_actions);
    const missing = [...fromAudit].filter((x) => !fromIndex.has(x));
    check(
      "tab actions are all indexed",
      missing.length === 0,
      `missing: ${missing.join(",")}`,
    );
  }

  report("\n=== documented numbers ===\n");

  const allHandlers = arch.protocol.all_handler_count;
  const bgHandlers = arch.protocol.background_handler_count;
  const absEndpoints = arch.absolute_endpoints.length;
  const storageKeys = arch.storage_keys.length;

  // A quoted number must match as a whole token.
  //
  // Plain `includes("16 个存储键")` is satisfied by "116 个存储键", so a doc that
  // drifted to a larger number whenever the correct one appeared as a suffix
  // still passed. Requiring a non-digit boundary before the number fixes that.
  const quotes = (text, value, suffix) => {
    const re = new RegExp(`(?<!\\d)${value}\\s*${suffix}`);
    return re.test(text);
  };

  // README quotes the total handler count and the per-layer split.
  check(
    `README quotes the handler total (${allHandlers})`,
    quotes(readme, allHandlers, "个消息处理器") || quotes(readme, allHandlers, "个处理器"),
    "no matching phrase",
  );
  check(
    `README quotes the background handler count (${bgHandlers})`,
    new RegExp(`后台\\s*${bgHandlers}(?!\\d)`).test(readme),
    "no matching phrase",
  );
  check(
    `README quotes the absolute endpoint count (${absEndpoints})`,
    quotes(readme, absEndpoints, "个端点"),
    "no matching phrase",
  );
  check(
    `README quotes the storage key count (${storageKeys})`,
    quotes(readme, storageKeys, "个存储键"),
    "no matching phrase",
  );

  // The architecture and navigation docs quote the same totals. They were not
  // read at all before, which is how they kept saying "14 个存储键" after the
  // real figure became 16.
  const navDoc = fs.readFileSync(path.join(DOCS, "navigation.md"), "utf8");
  check(
    `architecture.md quotes the handler total (${allHandlers})`,
    quotes(archDoc, allHandlers, "个"),
    "no matching phrase",
  );
  check(
    `architecture.md quotes the storage key count (${storageKeys})`,
    quotes(archDoc, storageKeys, "个存储键"),
    "no matching phrase",
  );
  check(
    `navigation.md quotes the handler total (${allHandlers})`,
    quotes(navDoc, allHandlers, "个消息处理器") || quotes(navDoc, allHandlers, "个处理器"),
    "no matching phrase",
  );
  check(
    `navigation.md quotes the storage key count (${storageKeys})`,
    quotes(navDoc, storageKeys, "个存储键"),
    "no matching phrase",
  );

  // A stale count must not survive anywhere. Any "<n> 个存储键" that differs from
  // the audited value is a bug, regardless of which number it is.
  for (const [name, text] of [
    ["README.md", readme],
    ["architecture.md", archDoc],
    ["navigation.md", navDoc],
  ]) {
    const claimed = [...text.matchAll(/(?<!\d)(\d+)\s*个存储键/g)].map((m) => Number(m[1]));
    const wrong = claimed.filter((n) => n !== storageKeys);
    check(
      `${name} states no stale storage-key count`,
      wrong.length === 0,
      wrong.length ? `found ${[...new Set(wrong)].join(", ")}, expected ${storageKeys}` : undefined,
    );
  }

  report("\n=== stale claims ===\n");

  // Numbers that were once wrong and must not come back.
  const forbidden = [
    { pattern: /\b207 个可识别/, why: "207 was REA's tool count, not Chrome API sites" },
    { pattern: /7698 处中文文案/, why: "7698 was wrong; the count is ~1657 distinct strings" },
    { pattern: /57,114/, why: "epilogue is 57,140 lines" },
    { pattern: /176 个后台处理器/, why: "handler total is 158" },
    { pattern: /96 个后台处理器/, why: "background layer is 97" },
  ];
  for (const f of forbidden) {
    const hit = f.pattern.test(readme) || f.pattern.test(archDoc);
    check(`no stale claim: ${f.why}`, !hit);
  }

  report(`\n${failures === 0 ? "consistency check passed" : `${failures} problem(s) found`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
