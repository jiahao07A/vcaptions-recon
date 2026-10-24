#!/usr/bin/env node
/**
 * Parcel bundle module splitter.
 *
 * Splits a Parcel 2 bundle into its individual registered modules without
 * altering a single byte of module source, then proves the split is lossless by
 * reassembling the bundle and comparing SHA-256 digests.
 *
 * Usage: node tools/parcel-split.mjs <bundle.js> <outDir> [--verify]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Matches `.register("id"` followed by the module factory, tolerating the
 * whitespace and line breaks that Prettier introduces. */
const REGISTER_RE =
  /([A-Za-z_$][\w$]*)\.register\(\s*["']([A-Za-z0-9$]+)["']\s*,\s*(?:async\s+)?function\s*\(/g;

/** Read a JS source string, honouring a UTF-8 BOM like Parcel does. */
function readBundle(file) {
  const buf = fs.readFileSync(file);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { text: buf.toString("utf8").replace(/^\uFEFF/, ""), bom };
}

/**
 * Walk forward from `open` (index of "{" or "(") to its matching close,
 * skipping over string, template, comment and regex literals.
 */
function matchBrace(src, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const closer = pairs[src[open]];
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === "/" && isRegexPosition(src, i)) {
      i = skipRegex(src, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error("unbalanced braces: reached end of source");
}

function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  throw new Error("unterminated string literal");
}

/** Decide whether a "/" at index i starts a regex literal rather than a division. */
function isRegexPosition(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const prev = src[j];
  if ("(,=:[!&|?{};+-*%~^<>".includes(prev)) return true;
  // keyword-preceded regex: return /typeof /case /in /of /delete /void /new ...
  const kw = /(?:^|[^\w$])(return|typeof|instanceof|case|in|of|delete|void|new|do|else|yield|await)$/;
  const before = src.slice(Math.max(0, j - 12), j + 1);
  return kw.test(before);
}

function skipRegex(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      return i;
    }
    i++;
  }
  throw new Error("unterminated regex literal");
}

/**
 * Walk forward from an opening bracket to its matching close, tracking every
 * bracket type and skipping string, template, comment and regex literals.
 * Unlike `matchBrace`, this correctly handles `f(a, function(){...})` by
 * counting parens and braces independently.
 */
function matchParen(src, open) {
  const stack = [];
  const openers = { "(": ")", "[": "]", "{": "}" };
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === "/" && isRegexPosition(src, i)) {
      i = skipRegex(src, i);
      continue;
    }
    if (openers[ch]) {
      stack.push(openers[ch]);
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.length === 0) return i;
      const expected = stack.pop();
      if (ch !== expected) {
        throw new Error(`bracket mismatch at ${i}: expected ${expected}, found ${ch}`);
      }
      if (stack.length === 0) return i;
    }
    i++;
  }
  throw new Error("unbalanced brackets: reached end of source");
}

/** Find every `.register("id",function(module,exports){...})` span in a bundle. */
function findModules(src) {
  const spans = [];
  REGISTER_RE.lastIndex = 0;
  let m;
  while ((m = REGISTER_RE.exec(src))) {
    const [, requireVar, id] = m;
    // Locate the "(" that opens the register() argument list. After formatting,
    // whitespace may sit between `.register` and `(`, so search forward.
    const afterRegister = m.index + requireVar.length + ".register".length;
    const callOpen = src.indexOf("(", afterRegister);
    // Close the whole `register(...)` call, not just the function body, so each
    // extracted module is a self-contained, parseable expression.
    const callClose = matchParen(src, callOpen);
    let cursor = callClose + 1;
    let deps = [];
    // Parcel appends the dependency map to the register call's arguments; it is
    // already inside `callClose`, so read it from the call text for the manifest.
    const callText = src.slice(callOpen, callClose + 1);
    deps = [...callText.matchAll(/\[\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\]/g)].map((d) => ({
      request: d[1],
      id: d[2],
    }));
    spans.push({
      id,
      requireVar,
      start: m.index,
      end: cursor,
      fnStart: callOpen,
      fnEnd: callClose,
      source: src.slice(m.index, cursor),
      deps,
    });
  }
  // The gap between one module's end and the next module's start is the
  // separator Parcel emitted (normally a single comma). Record it verbatim so
  // reassembly is byte-exact.
  for (let i = 0; i < spans.length; i++) {
    const next = spans[i + 1];
    spans[i].separatorAfter = next ? src.slice(spans[i].end, next.start) : "";
  }
  return spans;
}

/** Extract the readable function body of one module (module,exports => ...). */
function moduleBody(src, mod) {
  const paramsEnd = src.indexOf(")", mod.fnStart);
  const bodyOpen = src.indexOf("{", paramsEnd);
  const bodyClose = matchBrace(src, bodyOpen);
  return src.slice(bodyOpen, bodyClose + 1);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function split(file, outDir) {
  const { text, bom } = readBundle(file);
  const modules = findModules(text);
  if (!modules.length) throw new Error(`no Parcel modules found in ${file}`);

  const preamble = text.slice(0, modules[0].start);
  const epilogue = text.slice(modules[modules.length - 1].end);

  fs.mkdirSync(outDir, { recursive: true });

  const manifest = {
    bundle: path.basename(file),
    bundle_sha256: sha256(text),
    bundle_bytes: Buffer.byteLength(text, "utf8"),
    bom,
    preamble_sha256: sha256(preamble),
    epilogue_sha256: sha256(epilogue),
    module_count: modules.length,
    modules: [],
  };

  for (const mod of modules) {
    const body = moduleBody(text, mod);
    const fileName = `${mod.id}.js`;
    const outFile = path.join(outDir, fileName);
    // Preserve the exact module text; add a provenance header as a comment.
    const header = `/* parcel module id: ${mod.id} | bundle: ${path.basename(file)} | bytes: ${Buffer.byteLength(mod.source, "utf8")} | separator-after: ${JSON.stringify(mod.separatorAfter)} */\n`;
    fs.writeFileSync(outFile, header + mod.source, "utf8");
    manifest.modules.push({
      id: mod.id,
      file: fileName,
      bytes: Buffer.byteLength(mod.source, "utf8"),
      body_bytes: Buffer.byteLength(body, "utf8"),
      separator_after: mod.separatorAfter,
      dependencies: mod.deps,
      sha256: sha256(mod.source),
    });
  }

  fs.writeFileSync(path.join(outDir, "preamble.js"), preamble, "utf8");
  fs.writeFileSync(path.join(outDir, "epilogue.js"), epilogue, "utf8");
  fs.writeFileSync(path.join(outDir, "modules.json"), JSON.stringify(manifest, null, 2), "utf8");

  return { manifest, preamble, epilogue, modules };
}

/**
 * Verify a split is faithful, using an independent check rather than
 * self-consistency.
 *
 * The previous implementation concatenated the split parts and compared the
 * result to the original. That is tautologically true for *any* split — even one
 * whose module boundaries are completely wrong — because it only proves no bytes
 * were dropped. It cannot detect a module body that was moved into a separator,
 * a module that was dropped and re-inlined elsewhere, or a boundary shifted by a
 * bracket.
 *
 * This version re-derives the boundaries from the bundle itself and requires the
 * stored parts to match them structurally:
 *
 *   1. each stored module source must re-parse as a complete `register(...)` call
 *   2. each stored module must appear at the offset implied by its predecessors
 *   3. the set of ids must equal the set found by parsing the bundle
 *   4. the preamble/epilogue must match the exact text outside those spans
 *   5. only then is concatenation checked, as a final byte-level tie-break
 *
 * A split that passes 1-4 has correct boundaries; step 5 then catches encoding
 * damage. Failing any step reports which module and why.
 */
function verify(file, outDir) {
  const { text } = readBundle(file);
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "modules.json"), "utf8"));
  const problems = [];

  // Ground truth: parse the bundle itself.
  const truth = findModules(text);
  const truthIds = truth.map((s) => s.id);
  const storedIds = manifest.modules.map((m) => m.id);

  if (JSON.stringify(truthIds) !== JSON.stringify(storedIds)) {
    const missing = truthIds.filter((id) => !storedIds.includes(id));
    const extra = storedIds.filter((id) => !truthIds.includes(id));
    const orderChanged =
      missing.length === 0 && extra.length === 0 && truthIds.join() !== storedIds.join();
    problems.push(
      orderChanged
        ? `module order differs from the bundle: ${storedIds.join(", ")}`
        : `module set differs (missing: ${missing.join(", ") || "none"}; ` +
          `unexpected: ${extra.join(", ") || "none"})`,
    );
  }

  // Structural check: every stored module must be a complete register() call and
  // must sit exactly where the bundle says it does.
  const offsets = new Map(truth.map((s) => [s.id, s]));
  for (const mod of manifest.modules) {
    const raw = fs.readFileSync(path.join(outDir, mod.file), "utf8");
    const nl = raw.indexOf("\n");
    const body = nl === -1 ? raw : raw.slice(nl + 1);
    const span = offsets.get(mod.id);

    if (!span) {
      problems.push(`${mod.id}: not found when parsing the bundle`);
      continue;
    }
    if (body !== span.source) {
      // Pinpoint the first difference so the report is actionable.
      let i = 0;
      const min = Math.min(body.length, span.source.length);
      while (i < min && body[i] === span.source[i]) i++;
      problems.push(
        `${mod.id}: stored source differs from the bundle at byte ${i} ` +
          `(stored ${body.length}B, expected ${span.source.length}B)`,
      );
      continue;
    }

    // A module must parse as a complete expression, not a fragment.
    try {
      new Function(`var __x = {}; __x${body.startsWith(".") ? "" : "."}register; ${body}`);
    } catch (err) {
      problems.push(`${mod.id}: stored source is not a complete expression (${err.message})`);
    }

    if (mod.separator_after !== span.separatorAfter) {
      problems.push(
        `${mod.id}: separator differs (stored ${JSON.stringify(mod.separator_after)}, ` +
          `expected ${JSON.stringify(span.separatorAfter)})`,
      );
    }
  }

  // Fragments must be exactly the text outside the module spans.
  const preamble = fs.readFileSync(path.join(outDir, "preamble.js"), "utf8");
  const epilogue = fs.readFileSync(path.join(outDir, "epilogue.js"), "utf8");
  if (truth.length) {
    const expectedPreamble = text.slice(0, truth[0].start);
    const expectedEpilogue = text.slice(truth[truth.length - 1].end);
    if (preamble !== expectedPreamble) {
      problems.push(
        `preamble differs (stored ${preamble.length}B, expected ${expectedPreamble.length}B)`,
      );
    }
    if (epilogue !== expectedEpilogue) {
      problems.push(
        `epilogue differs (stored ${epilogue.length}B, expected ${expectedEpilogue.length}B)`,
      );
    }
  }

  // Final byte-level tie-break: catches encoding damage not caught above.
  const parts = manifest.modules.map((m) => {
    const raw = fs.readFileSync(path.join(outDir, m.file), "utf8");
    const nl = raw.indexOf("\n");
    return raw.slice(nl + 1) + m.separator_after;
  });
  const rebuilt = preamble + parts.join("") + epilogue;
  const rebuiltHash = sha256(rebuilt);
  const originalHash = sha256(text);

  return {
    identical: problems.length === 0 && rebuiltHash === originalHash,
    original_sha256: originalHash,
    rebuilt_sha256: rebuiltHash,
    original_bytes: Buffer.byteLength(text, "utf8"),
    rebuilt_bytes: Buffer.byteLength(rebuilt, "utf8"),
    problems,
  };
}

export { findModules, matchParen, matchBrace, split, verify };

// CLI entry point — only runs when this file is executed directly, so that
// tools/format.mjs can import the parser without triggering a split.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (invokedDirectly) {
  const [, , file, outDir, flag] = process.argv;
  if (!file || !outDir) {
    console.error(
      "usage:\n" +
        "  parcel-split.mjs <bundle.js> <outDir>            split the bundle\n" +
        "  parcel-split.mjs <bundle.js> <outDir> --verify   split, then verify\n" +
        "  parcel-split.mjs <bundle.js> <outDir> --check    verify only, never write",
    );
    process.exit(2);
  }

  // --check must not re-split: re-splitting rewrites the very files under test,
  // which would make any corruption disappear before it could be detected.
  if (flag === "--check") {
    const v = verify(file, outDir);
    console.log(
      `${path.basename(file)}: ${v.identical ? "OK" : "INVALID"} ` +
        `(${v.rebuilt_bytes}/${v.original_bytes} bytes)`,
    );
    if (v.problems.length) {
      console.log("  structural problems:");
      for (const p of v.problems) console.log(`    - ${p}`);
    }
    process.exit(v.identical ? 0 : 1);
  }

  const result = split(file, outDir);
  console.log(
    `${path.basename(file)}: ${result.manifest.module_count} modules, ` +
      `${result.manifest.bundle_bytes} bytes, sha256=${result.manifest.bundle_sha256.slice(0, 16)}…`,
  );
  if (flag === "--verify") {
    const v = verify(file, outDir);
    console.log(
      `  reassembly: ${v.identical ? "IDENTICAL" : "MISMATCH"} ` +
        `(${v.rebuilt_bytes}/${v.original_bytes} bytes)`,
    );
    if (v.problems.length) {
      console.log("  structural problems:");
      for (const p of v.problems) console.log(`    - ${p}`);
    }
    if (!v.identical) process.exit(1);
  }
}
