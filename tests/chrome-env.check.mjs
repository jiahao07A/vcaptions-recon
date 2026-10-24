#!/usr/bin/env node
/**
 * Fidelity test for the Chrome environment stand-in.
 *
 * The stand-in is what every behavioural test runs against, so a wrong model
 * produces false confidence. Two defects found in round-1 review are pinned here:
 *
 *   P1-7  IndexedDB reported the wrong `oldVersion`, never raised the stored
 *         version, and fired `onsuccess` twice — so upgrade code could not be
 *         tested at all.
 *   P1-8  StorageArea handed out live references instead of serialised copies,
 *         so a handler could mutate "stored" state by accident and a test would
 *         not notice that nothing was persisted.
 *
 * Usage: node tests/chrome-env.check.mjs
 */
import { createChromeEnv } from "./chrome-env.mjs";

let failures = 0;
const report = (l = "") => process.stdout.write(`${l}\n`);
const check = (label, ok, detail) => {
  if (ok) report(`ok    ${label}`);
  else {
    failures++;
    report(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  report("=== storage: values are serialised, not shared ===\n");
  {
    const env = createChromeEnv({ manifest: { version: "2.4.6" }, messages: {} });

    await env.local.set({ config: { nested: { count: 1 } } });
    const first = await env.local.get("config");

    // Mutating the returned object must not change stored state.
    first.config.nested.count = 999;
    const second = await env.local.get("config");
    check(
      "mutating a read result does not change stored state",
      second.config.nested.count === 1,
      `got ${second.config.nested.count}`,
    );

    // Mutating the object after set() must not change stored state either.
    const source = { nested: { count: 5 } };
    await env.local.set({ other: source });
    source.nested.count = 777;
    const third = await env.local.get("other");
    check(
      "mutating the object after set() does not change stored state",
      third.other.nested.count === 5,
      `got ${third.other.nested.count}`,
    );

    // The four documented get() shapes still work.
    await env.local.set({ a: 1, b: 2 });
    const byArray = await env.local.get(["a", "b", "missing"]);
    check("get(array) returns present keys only", byArray.a === 1 && !("missing" in byArray));
    const byDefault = await env.local.get({ a: 0, missing: 42 });
    check(
      "get(object) applies defaults",
      byDefault.a === 1 && byDefault.missing === 42,
      JSON.stringify(byDefault),
    );
    const all = await env.local.get(null);
    check("get(null) returns everything", Object.keys(all).length >= 2);
  }

  report("\n=== IndexedDB: upgrade lifecycle ===\n");
  {
    const env = createChromeEnv({ manifest: { version: "2.4.6" }, messages: {} });

    // First open: oldVersion 0, upgrade fires once, success fires once.
    const events = [];
    const open1 = env.indexedDB.open("db", 1);
    open1.onupgradeneeded = (e) => events.push(["upgrade", e.oldVersion, e.newVersion]);
    open1.onsuccess = () => events.push(["success"]);
    await tick();
    check(
      "first open reports oldVersion 0",
      events.some(([k, o]) => k === "upgrade" && o === 0),
      JSON.stringify(events),
    );
    check(
      "first open fires success exactly once",
      events.filter(([k]) => k === "success").length === 1,
      JSON.stringify(events),
    );

    // Second open at the same version: no upgrade.
    const events2 = [];
    const open2 = env.indexedDB.open("db", 1);
    open2.onupgradeneeded = (e) => events2.push(["upgrade", e.oldVersion]);
    open2.onsuccess = () => events2.push(["success"]);
    await tick();
    check(
      "reopening at the same version does not upgrade",
      !events2.some(([k]) => k === "upgrade"),
      JSON.stringify(events2),
    );

    // Third open at a higher version: upgrade fires with the previous version.
    const events3 = [];
    const open3 = env.indexedDB.open("db", 3);
    open3.onupgradeneeded = (e) => events3.push(["upgrade", e.oldVersion, e.newVersion]);
    open3.onsuccess = () => events3.push(["success"]);
    await tick();
    check(
      "raising the version upgrades from the previous version",
      events3.some(([k, o, n]) => k === "upgrade" && o === 1 && n === 3),
      JSON.stringify(events3),
    );

    const dbs = await env.indexedDB.databases();
    check(
      "stored version reflects the upgrade",
      dbs.find((d) => d.name === "db")?.version === 3,
      JSON.stringify(dbs),
    );
  }

  report("\n=== message sender shape ===\n");
  {
    const env = createChromeEnv({ manifest: { version: "2.4.6" }, messages: {} });
    let seen = null;
    env.messageListeners.push((msg, sender) => {
      seen = sender;
      return false;
    });
    await env.sendRuntimeMessage({ name: "probe" });
    check(
      "default sender carries tab.id and tab.windowId",
      seen?.tab?.id !== undefined && seen?.tab?.windowId !== undefined,
      JSON.stringify(seen),
    );
  }

  report(`\n${failures === 0 ? "chrome-env check passed" : `${failures} problem(s) found`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
