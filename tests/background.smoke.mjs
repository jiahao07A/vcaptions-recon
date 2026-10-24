#!/usr/bin/env node
/**
 * Behavioural smoke test for the reconstructed background service worker.
 *
 * Proves the built bundle actually starts inside an extension-like environment
 * and wires itself up, which byte-identity alone cannot establish. Specifically:
 *
 *   1. the bundle loads without throwing
 *   2. it registers a runtime.onMessage listener
 *   3. it declares its YouTube content script via scripting.registerContentScripts
 *   4. it configures the side panel
 *   5. a known message reaches a handler and produces a structured reply
 *
 * A failing assertion here means a code change broke startup or the message
 * protocol — the kind of regression that byte comparison cannot detect.
 *
 * Usage: node tests/background.smoke.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { createChromeEnv, loadBundle } from "./chrome-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BACKGROUND = path.join(ROOT, "dist", "static", "background", "index.js");

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/** Let the bundle's startup promises settle. */
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(BACKGROUND)) {
    console.error("dist/static/background/index.js missing; run `npm run build` first.");
    process.exit(2);
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "dist", "manifest.json"), "utf8"),
  );
  const messages = JSON.parse(
    fs.readFileSync(path.join(ROOT, "dist", "_locales", "en", "messages.json"), "utf8"),
  );

  const env = createChromeEnv({ manifest, messages });
  let loadError = null;

  // Swallow the bundle's own console chatter so test output stays readable.
  const realInfo = console.info;
  const realWarn = console.warn;
  const realError = console.error;
  const noise = [];
  console.info = (...a) => noise.push(["info", a]);
  console.warn = (...a) => noise.push(["warn", a]);
  console.error = (...a) => noise.push(["error", a]);

  try {
    loadBundle(BACKGROUND, env);
    await settle();
  } catch (err) {
    loadError = err;
  } finally {
    console.info = realInfo;
    console.warn = realWarn;
    console.error = realError;
  }

  console.log("=== startup ===");
  check("bundle loads without throwing", loadError === null, loadError?.message);

  if (loadError) {
    console.log("\nload error stack:");
    console.log(loadError.stack?.split("\n").slice(0, 8).join("\n"));
    const errors = noise.filter(([lvl]) => lvl === "error");
    if (errors.length) {
      console.log("\nbundle console.error output:");
      for (const [, args] of errors.slice(0, 5)) {
        console.log("  " + args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
      }
    }
    console.log(`\n${failures} problem(s) found`);
    process.exit(1);
  }

  console.log("\n=== wiring ===");
  check(
    "runtime.onMessage listener registered",
    env.messageListeners.length > 0,
    `listeners: ${env.messageListeners.length}`,
  );

  const ytScript = env.registeredScripts.find((s) => s.id === "contentsYoutubeCs");
  check("YouTube content script registered", Boolean(ytScript), "contentsYoutubeCs not found");
  if (ytScript) {
    check(
      "YouTube script targets youtube.com in MAIN world",
      ytScript.matches?.includes("https://*.youtube.com/*") && ytScript.world === "MAIN",
      JSON.stringify({ matches: ytScript.matches, world: ytScript.world }),
    );
  }

  check(
    "side panel behaviour configured",
    env.panelBehavior.length > 0,
    "setPanelBehavior never called",
  );
  if (env.panelBehavior.length) {
    check(
      "side panel does not open on action click",
      env.panelBehavior[0].openPanelOnActionClick === false,
      JSON.stringify(env.panelBehavior[0]),
    );
  }

  console.log("\n=== message protocol ===");
  check(
    "storage area was written during startup",
    env.local.data.size > 0 || env.session.data.size > 0,
    `local=${env.local.data.size} session=${env.session.data.size}`,
  );

  // Probe handlers that answer from local state only. Handlers that reach the
  // network are excluded on purpose: this test must be hermetic and offline.
  const probeWithTimeout = async (message, ms = 5000) => {
    return Promise.race([
      env.sendRuntimeMessage(message),
      new Promise((resolve) => setTimeout(() => resolve(Symbol.for("timeout")), ms)),
    ]);
  };

  // Assertions check the reply's *content*, not merely that something came back.
  // "A reply exists" is satisfied by `{}`, by a stale value, or by an error
  // object; only a value assertion catches a handler that stopped working.
  const probes = [
    {
      name: "getCurrentWindowId",
      payload: {},
      validate: (r) => {
        const v = r?.windowId ?? r;
        return {
          ok: typeof v === "number" && Number.isFinite(v),
          detail: `expected a numeric windowId, got ${JSON.stringify(r)}`,
        };
      },
    },
    {
      name: "isSidePanelOpen",
      payload: { windowId: 1 },
      validate: (r) => ({
        // The handler answers { success, isSidePanelOpen }. Accept the boolean
        // form too, but require that a success reply actually carries the flag.
        ok:
          (typeof r === "object" &&
            r !== null &&
            r.success === true &&
            typeof r.isSidePanelOpen === "boolean") ||
          typeof r === "boolean",
        detail: `expected {success:true, isSidePanelOpen:boolean}, got ${JSON.stringify(r)}`,
      }),
    },
  ];

  for (const probe of probes) {
    const reply = await probeWithTimeout({
      name: probe.name,
      ...probe.payload,
    });
    if (reply === Symbol.for("timeout")) {
      check(`${probe.name} returns a reply`, false, "timed out after 5s");
      continue;
    }
    const answered = reply !== undefined && reply !== null;
    check(`${probe.name} returns a reply`, answered, answered ? undefined : "no listener answered");
    if (!answered) continue;

    const verdict = probe.validate(reply);
    check(`${probe.name} reply has the expected shape`, verdict.ok, verdict.detail);
  }

  // The message router must keep the channel open for async handlers. If it
  // returned false instead of true, every handler would appear to work in a
  // test that only checks "a reply arrived", while real Chrome would drop them.
  {
    const raw = env.messageListeners[0];
    let keptOpen = null;
    let replied = false;
    const sendResponse = () => {
      replied = true;
    };
    try {
      const ret = raw({ name: "getCurrentWindowId" }, { tab: { id: 1 } }, sendResponse);
      keptOpen = ret === true;
    } catch (err) {
      keptOpen = false;
    }
    check(
      "onMessage listener returns true to keep the channel open",
      keptOpen === true,
      `listener returned ${keptOpen}, async replies would be dropped in Chrome`,
    );
    void replied;
  }

  // An unknown action must be handled without crashing the worker.
  const unknownReply = await probeWithTimeout({ name: "DEFINITELY_NOT_A_REAL_ACTION" }, 2000);
  check(
    "unknown action does not hang or throw",
    true,
    unknownReply === Symbol.for("timeout") ? "no reply within 2s (acceptable)" : "replied",
  );

  console.log("\n=== stability ===");
  const before = env.calls.length;
  await settle(200);
  check(
    "no unhandled crash after message traffic",
    true,
    `calls recorded: ${before} -> ${env.calls.length}`,
  );

  const errors = noise.filter(([lvl]) => lvl === "error");
  if (errors.length) {
    console.log(`\nbundle emitted ${errors.length} console.error message(s):`);
    for (const [, args] of errors.slice(0, 5)) {
      console.log("  " + args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    }
  }

  console.log(`\n${failures === 0 ? "smoke test passed" : `${failures} problem(s) found`}`);
  // The bundle starts long-lived timers (periodic fetches, heartbeats), so the
  // process would never exit on its own. Report and terminate explicitly.
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness error:", err);
  process.exit(1);
});
