// Verify the two overlay edge cases from round-1 review (P1-4, P1-5).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stripOverlayHeader, readOverlayBody } from "../tools/overlay.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
let failures = 0;
const report = (l = "") => process.stdout.write(`${l}\n`);
const check = (label, ok, detail) => {
  if (ok) report(`ok    ${label}`);
  else {
    failures++;
    report(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// --- P1-4: stripOverlayHeader must only remove the adopt header -------------
{
  const adoptHeader = `/*\n * Overlay module: hEvvs\n * Replaces the minified module in src/bundles/X/hEvvs.js\n */\nBODY_HERE`;
  check(
    "strips the adopt header",
    stripOverlayHeader(adoptHeader) === "BODY_HERE",
    JSON.stringify(stripOverlayHeader(adoptHeader)),
  );

  const licenseHeader = `/*! @preserve Some License v1 */\nBODY_HERE`;
  check(
    "keeps a leading license comment",
    stripOverlayHeader(licenseHeader) === licenseHeader,
    JSON.stringify(stripOverlayHeader(licenseHeader)),
  );

  const eslintHeader = `/* eslint-disable no-console */\nBODY_HERE`;
  check(
    "keeps a leading eslint directive",
    stripOverlayHeader(eslintHeader) === eslintHeader,
    JSON.stringify(stripOverlayHeader(eslintHeader)),
  );
}

// --- P1-5: a trailing line comment must not swallow the separator -----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-edge-"));
  const file = path.join(tmp, "m.js");
  fs.writeFileSync(file, `a.register("x",function(){}) // trailing comment\n`, "utf8");
  const body = readOverlayBody(file);
  check(
    "keeps a newline after a trailing line comment",
    body.endsWith("\n"),
    JSON.stringify(body.slice(-30)),
  );

  // Prove it matters: splice the body with a separator and parse the result.
  const spliced = `var a={register(){}};${body},a.register("y",function(){});`;
  let parses = true;
  let err = null;
  try {
    new Function(spliced);
  } catch (e) {
    parses = false;
    err = e.message;
  }
  check("spliced bundle with trailing comment parses", parses, err);

  // Control: document the actual failure mode, which was measured rather than
  // assumed. When the separator is absorbed by a `//` comment, the whole
  // registration expression becomes a comment: the bundle still parses, but the
  // module silently vanishes. That is why the guard matters — it protects
  // correctness, not syntax.
  const runCase = (source) => {
    const log = [];
    try {
      // `register` records its name; the module bodies are inert.
      new Function("log", `var a={register:function(n){log.push(n)}};${source};return log;`)(log);
      return { ok: true, log };
    } catch (e) {
      return { ok: false, log, error: e.message };
    }
  };

  const bodyFirst = `a.register("x")`;
  const bodySecond = `a.register("y")`;

  {
    // Newline terminates the comment, so the separator and second module survive.
    const r = runCase(`${bodyFirst} // trailing note\n,${bodySecond}`);
    check(
      "with the newline both modules register",
      r.ok && r.log.includes("x") && r.log.includes("y"),
      JSON.stringify(r),
    );
  }

  {
    // No newline: the comment swallows ",a.register(\"y\")".
    const r = runCase(`${bodyFirst} // trailing note,${bodySecond}`);
    check(
      "control: without the newline the second module is silently dropped",
      r.ok && r.log.includes("x") && !r.log.includes("y"),
      JSON.stringify(r),
    );
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- End to end: an overlay ending in a line comment must still build -------
{
  const bundle = "WebappCS.8b5d7cd6";
  const overlayDir = path.join(ROOT, "src", "overlay", bundle);
  const srcDir = path.join(ROOT, "src", "bundles", bundle);
  const stash = path.join(ROOT, "src", "overlay");
  let stashPath = null;
  if (fs.existsSync(stash)) {
    stashPath = `${stash}.stash-${process.pid}`;
    fs.renameSync(stash, stashPath);
  }

  try {
    fs.mkdirSync(overlayDir, { recursive: true });
    const man = JSON.parse(fs.readFileSync(path.join(srcDir, "modules.json"), "utf8"));
    const mod = man.modules[0];
    const raw = fs.readFileSync(path.join(srcDir, mod.file), "utf8");
    const body = raw.slice(raw.indexOf("\n") + 1);
    fs.writeFileSync(
      path.join(overlayDir, `${mod.id}.js`),
      `/*\n * Overlay module: ${mod.id}\n * Replaces the minified module in src/bundles/${bundle}/${mod.file}\n */\n${body} // end of module\n`,
      "utf8",
    );

    let out = "";
    let code = 0;
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, "tools", "build.mjs")], {
        encoding: "utf8",
        cwd: ROOT,
      });
    } catch (e) {
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      code = e.status ?? 1;
    }
    check(
      "build succeeds with a trailing line comment in the overlay",
      code === 0 && !/do not parse/.test(out),
      out.split("\n").filter((l) => l.includes("syntax")).join(" | "),
    );
  } finally {
    fs.rmSync(stash, { recursive: true, force: true });
    if (stashPath && fs.existsSync(stashPath)) fs.renameSync(stashPath, stash);
    try {
      execFileSync(process.execPath, [path.join(ROOT, "tools", "build.mjs")], {
        encoding: "utf8",
        cwd: ROOT,
      });
    } catch {
      /* reported elsewhere */
    }
  }
}

report(`\n${failures === 0 ? "overlay edge cases pass" : `${failures} problem(s) found`}`);
process.exit(failures === 0 ? 0 : 1);
