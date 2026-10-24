#!/usr/bin/env node
/**
 * Build a navigable symbol index over the readable tree.
 *
 * Answers the question "where is this feature implemented?" without reading
 * 57,000-line files. For every anchor found in `src/readable/` it records the
 * bundle, file, line and the surrounding context, so a message name, storage
 * key, endpoint or UI string leads straight to its implementation site.
 *
 * Usage: node tools/index-symbols.mjs
 * Output: docs/symbol-index.json + docs/symbol-index.md
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const READABLE = path.join(ROOT, "src", "readable");
const DOCS = path.join(ROOT, "docs");

/**
 * Anchor categories, in priority order. Each pattern is matched per line so the
 * index can point at an exact location.
 *
 * Order matters: when a token matches more than one category, the first one
 * claims it. Specific categories (an exact storage key) therefore come before
 * looser prefix patterns (a `vcaptions_*` action), so `vcaptions_log_config` is
 * recorded as the storage key it actually is.
 */
const CATEGORIES = [
  {
    key: "storage_key",
    label: "存储键",
    // Matched against the authoritative key set from tools/audit.mjs rather than
    // by shape, because i18n translation keys share the same camelCase form.
    // `dynamic: "storageKeys"` marks this category for set-based matching.
    dynamic: "storageKeys",
    hint: "chrome.storage / IndexedDB 的键名（来自审计工具的实际提取结果）",
  },
  {
    key: "background_handler",
    label: "消息处理器",
    // Matches `NAME: async (...) =>`, `NAME: async arg =>`, and `NAME: (...) =>`,
    // which covers every handler layer. Library constants and globals such as
    // Redux's PROBE_UNKNOWN_ACTION share that shape, so a deny-list keeps them
    // out of the protocol inventory.
    pattern: /^\s*([A-Z][A-Z0-9_]{3,60}):\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/,
    group: 1,
    exclude: /^(?:PROBE_UNKNOWN_ACTION|REDUX_DEVTOOLS_EXTENSION_COMPOSE__|SC_DISABLE_SPEEDY|RFC1738)$/,
    hint: "内容脚本/UI 通过消息调用或转发的入口（含后台、UI、内容脚本三层）",
  },
  {
    key: "tab_action",
    label: "标签页动作",
    // The actions the background sends to content scripts, matched by exact
    // string so the log-config storage key is not caught by a loose
    // `vcaptions_*` shape. Unlike the other categories this one scans long lines
    // too, because `vcaptions_assistant` only appears inside a large i18n blob.
    pattern:
      /(vcaptions_(?:mount|unmount|toggle_mount|subtitle_bar_mount|subtitle_bar_display|subtitle_bar_language_changed|assistant|log_config))/,
    group: 1,
    scanLongLines: true,
    hint: "后台下发给内容脚本的动作",
  },
  {
    key: "app_command",
    label: "应用内部命令",
    pattern: /((?:APP|BAR)_[A-Z0-9_]+)/,
    group: 1,
    hint: "应用层（字幕列表 ↔ 字幕条）定向消息",
  },
  {
    key: "i18n_key",
    label: "i18n 翻译键",
    // Translation keys live in the same namespaces as storage keys but always
    // carry an extra action suffix. Anything in these namespaces that is not in
    // the storage-key set is a translation key.
    pattern:
      /["']((?:chapterNavigation|videoControlBar|websiteConfigBtn|transcription|subtitleBar|sidePanel|common)_[A-Za-z0-9_]+)["']/,
    group: 1,
    dynamicExclude: "storageKeys",
    hint: "UI 文案的翻译键，不是存储键",
  },
  {
    key: "endpoint",
    label: "外部端点",
    pattern: /["'`]((?:https?:\/\/)[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]{8,120})["'`]/,
    group: 1,
    hint: "网络请求目标",
  },
  {
    key: "chrome_api",
    label: "Chrome API 调用",
    pattern: /(chrome\.[a-zA-Z]+(?:\.[a-zA-Z]+)?)/,
    group: 1,
    hint: "浏览器扩展能力调用点",
  },
  {
    key: "action_type",
    label: "Redux action / 消息类型",
    pattern: /type:\s*["']([a-zA-Z][A-Za-z0-9_\/]{3,60})["']/,
    group: 1,
    hint: "状态管理或消息分发的类型标识",
  },
];

/** Directories under src/readable/ that hold application code. */
function listBundles() {
  return fs
    .readdirSync(READABLE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Load the authoritative storage-key set from the audit output.
 *
 * Storage keys and i18n keys share a naming shape, so matching on shape alone
 * misclassifies them. `tools/audit.mjs` already extracts the real key set from
 * the bundles; reusing it keeps both tools in agreement by construction instead
 * of maintaining a second hard-coded list that can drift.
 */
function loadStorageKeys() {
  const auditFile = path.join(DOCS, "architecture.generated.json");
  if (!fs.existsSync(auditFile)) return null;
  try {
    const audit = JSON.parse(fs.readFileSync(auditFile, "utf8"));
    const keys = audit.storage_keys;
    return Array.isArray(keys) && keys.length ? new Set(keys) : null;
  } catch {
    return null;
  }
}

function scanFile(absFile, relFile, bundle, index, dynamicSets) {
  const text = fs.readFileSync(absFile, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Long lines are usually data tables, not code. Categories that genuinely
    // live in such blobs opt in via `scanLongLines`.
    const isLong = line.length > 400;
    for (const cat of CATEGORIES) {
      if (isLong && !cat.scanLongLines) continue;
      let value = null;

      if (cat.dynamic) {
        // Set-based matching: does this line contain a known member of the set?
        const set = dynamicSets[cat.dynamic];
        if (!set) continue;
        for (const candidate of set) {
          if (line.includes(`"${candidate}"`) || line.includes(`'${candidate}'`)) {
            value = candidate;
            break;
          }
        }
        if (!value) continue;
      } else {
        const m = line.match(cat.pattern);
        if (!m) continue;
        value = m[cat.group];
        if (!value) continue;
        if (cat.exclude && cat.exclude.test(value)) continue;
        if (cat.dynamicExclude && dynamicSets[cat.dynamicExclude]?.has(value)) continue;
      }

      const key = `${cat.key}\u0000${value}`;
      // A single token can match more than one category (for example
      // `vcaptions_log_config` is both a storage key and matches the tab-action
      // prefix). The first matching category in CATEGORIES order wins, so the
      // storage key is claimed before the looser tab-action pattern sees it.
      let claimed = false;
      for (const existingKey of index.keys()) {
        if (!existingKey.endsWith(`\u0000${value}`)) continue;
        const existing = index.get(existingKey);
        if (existing && existing.sites.some((s) => s.bundle === bundle && s.file === relFile && s.line === i + 1)) {
          claimed = true;
          break;
        }
      }
      if (claimed) continue;
      let entry = index.get(key);
      if (!entry) {
        entry = { category: cat.key, label: cat.label, value, hint: cat.hint, sites: [] };
        index.set(key, entry);
      }
      // Cap sites per symbol so the index stays useful rather than exhaustive.
      if (entry.sites.length < 12) {
        // For very long lines, record the match with surrounding context rather
        // than the line prefix, which would be an unreadable data blob.
        let context;
        if (isLong) {
          const at = line.indexOf(value);
          const from = Math.max(0, at - 40);
          context = line.slice(from, from + 140).trim();
        } else {
          context = line.trim().slice(0, 180);
        }
        entry.sites.push({
          bundle,
          file: relFile,
          line: i + 1,
          context,
        });
      }
      break; // one anchor category per line keeps the index clean
    }
  }
}

function main() {
  if (!fs.existsSync(READABLE)) {
    console.error("src/readable missing; run `npm run format` first.");
    process.exit(2);
  }

  // Storage keys come from the audit so both tools agree by construction.
  const storageKeys = loadStorageKeys();
  if (!storageKeys) {
    console.warn(
      "warning: docs/architecture.generated.json missing; run `npm run audit` first.\n" +
        "         Storage keys will be skipped until then.",
    );
  }
  const dynamicSets = { storageKeys };

  const index = new Map();
  const bundles = listBundles();

  for (const bundle of bundles) {
    const dir = path.join(READABLE, bundle);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".js")) continue;
      scanFile(path.join(dir, name), name, bundle, index, dynamicSets);
    }
  }

  const entries = [...index.values()].sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return b.sites.length - a.sites.length || a.value.localeCompare(b.value);
  });

  const byCategory = {};
  for (const e of entries) {
    (byCategory[e.category] ??= []).push(e);
  }

  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(
    path.join(DOCS, "symbol-index.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        generated_by: "tools/index-symbols.mjs",
        source: "src/readable/ (formatted from assets/baseline/extension-v2.4.6)",
        note: "Line numbers refer to the formatted readable tree, not the minified bundle.",
        categories: Object.fromEntries(
          CATEGORIES.map((c) => [c.key, { label: c.label, hint: c.hint, count: byCategory[c.key]?.length ?? 0 }]),
        ),
        entries,
      },
      null,
      2,
    ),
    "utf8",
  );

  // Markdown navigation aid
  const md = [];
  md.push("# 符号索引\n");
  md.push("从 `src/readable/` 自动生成。行号指向**格式化后**的可读代码，不是压缩产物。\n");
  md.push("用法：搜到消息名/存储键后，按下表跳到对应文件与行号。\n");
  for (const cat of CATEGORIES) {
    const list = byCategory[cat.key];
    if (!list?.length) continue;
    md.push(`## ${cat.label}（${list.length}）\n`);
    md.push(`> ${cat.hint}\n`);
    md.push("| 名称 | 出现位置 |");
    md.push("| --- | --- |");
    for (const e of list) {
      const sites = e.sites
        .slice(0, 4)
        .map((s) => `\`${s.bundle}/${s.file}:${s.line}\``)
        .join("<br>");
      md.push(`| \`${e.value}\` | ${sites} |`);
    }
    md.push("");
  }
  fs.writeFileSync(path.join(DOCS, "symbol-index.md"), md.join("\n"), "utf8");

  console.log(`bundles scanned: ${bundles.length}`);
  for (const cat of CATEGORIES) {
    console.log(`  ${cat.key.padEnd(20)} ${byCategory[cat.key]?.length ?? 0}`);
  }
  console.log(`\nwritten docs/symbol-index.json and docs/symbol-index.md`);
}

main();
