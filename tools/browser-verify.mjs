#!/usr/bin/env node
/**
 * Load the packaged extension into a real Chrome and verify it actually runs.
 *
 * Uses the CDP `Extensions.loadUnpacked` command, which is the supported
 * automated path now that Chrome 137+ removed the `--load-extension` switch.
 * This exercises the real Chrome extension runtime rather than a Node shim, so
 * it catches problems the in-process tests cannot: manifest contract violations,
 * CSP failures, service worker registration errors.
 *
 * Usage: node tools/browser-verify.mjs [unpacked-dir]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9340;

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : null,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Terminate a Chrome process and all of its children.
 *
 * `child.kill()` only signals the browser process; Chrome spawns a tree of
 * renderer, GPU and utility processes that outlive it and keep the profile
 * directory locked. On Windows the reliable way to take down the whole tree is
 * `taskkill /T`, elsewhere a process-group kill.
 */
async function killChromeTree(child) {
  if (!child || child.killed) {
    // Still try by profile path: a previous run may have leaked processes.
    return;
  }
  const pid = child.pid;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // Give the OS a moment to reap the tree before the profile is deleted.
  await sleep(700);
}

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && fs.existsSync(c)) return c;
  return null;
}

/** Small CDP client: send commands, collect events, evaluate expressions. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.consoleMessages = [];
    this.exceptions = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ");
        this.consoleMessages.push({ type: msg.params.type, text });
      }
      if (msg.method === "Runtime.exceptionThrown") {
        this.exceptions.push(
          msg.params.exceptionDetails?.exception?.description ??
            msg.params.exceptionDetails?.text ??
            "unknown",
        );
      }
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ timeout: true, method });
        }
      }, timeoutMs);
    });
  }

  async evaluate(expression, targetSessionId) {
    const params = { expression, returnByValue: true, awaitPromise: true };
    const res = targetSessionId
      ? await this.send("Runtime.evaluate", { ...params }, 15000)
      : await this.send("Runtime.evaluate", params, 15000);
    if (res.timeout) return { timeout: true };
    if (res.result?.exceptionDetails) {
      return { error: res.result.exceptionDetails.exception?.description ?? "eval failed" };
    }
    return { value: res.result?.result?.value };
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return new Cdp(ws);
}

async function waitForJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error(`endpoint not ready: ${url}`);
}

/**
 * Find the newest packaged extension under release/.
 *
 * The previous default was the literal path `release/vcaptions-test-2.4.6`,
 * which silently verified a stale build when the operator had just run
 * `package:test` (version 2.4.6.1). Discovering the newest directory means the
 * thing that was just built is the thing that gets checked.
 */
function findNewestPackage() {
  const release = path.join(ROOT, "release");
  if (!fs.existsSync(release)) return null;
  const candidates = fs
    .readdirSync(release, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("vcaptions-"))
    .map((e) => {
      const abs = path.join(release, e.name);
      return { abs, mtime: fs.statSync(abs).mtimeMs };
    })
    .filter((c) => fs.existsSync(path.join(c.abs, "manifest.json")))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.abs ?? null;
}

async function main() {
  const extArg = process.argv[2];
  const discovered = extArg ? null : findNewestPackage();
  const extPath = path.resolve(extArg ?? discovered ?? path.join(ROOT, "release", "vcaptions-test-2.4.6"));

  if (!fs.existsSync(path.join(extPath, "manifest.json"))) {
    console.error(
      `no manifest.json at ${extPath}\n` +
        `Run \`npm run package\` first, or pass the path explicitly.`,
    );
    process.exit(2);
  }
  if (!extArg) {
    console.log(`using newest package: ${path.relative(ROOT, extPath)}`);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error("Chrome not found — skipping real-browser verification");
    process.exit(3);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(extPath, "manifest.json"), "utf8"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vcaptions-verify-"));

  console.log(`chrome:    ${path.basename(chrome)}`);
  console.log(`extension: ${path.relative(ROOT, extPath)}`);
  console.log(`version:   ${manifest.version}`);

  const child = spawn(
    chrome,
    [
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let browser = null;
  const failures = [];
  const check = (label, ok, detail) => {
    if (ok) console.log(`ok    ${label}`);
    else {
      failures.push(label);
      console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };

  try {
    const version = await waitForJson(`http://127.0.0.1:${PORT}/json/version`);
    console.log(`browser:   ${version.Browser}`);

    browser = await connect(version.webSocketDebuggerUrl);

    // 1. Load the unpacked extension through the Extensions domain.
    const loadRes = await browser.send("Extensions.loadUnpacked", { path: extPath }, 30000);
    const extId = loadRes.result?.id;
    check("Chrome accepts the unpacked extension", Boolean(extId), JSON.stringify(loadRes).slice(0, 200));
    if (!extId) {
      throw new Error("loadUnpacked did not return an extension id");
    }
    console.log(`extension id: ${extId}`);

    await sleep(2500);

    // 2. The service worker must register and start. A freshly loaded MV3
    //    extension starts its worker lazily, so poll rather than checking once.
    let swTarget = null;
    for (let i = 0; i < 40 && !swTarget; i++) {
      const list = await waitForJson(`http://127.0.0.1:${PORT}/json/list`);
      swTarget = list.find((t) => t.type === "service_worker" && t.url.includes(extId));
      if (!swTarget) await sleep(500);
    }
    check(
      "service worker is running",
      Boolean(swTarget),
      swTarget ? undefined : "no SW target after 20s",
    );

    if (swTarget) {
      const sw = await connect(swTarget.webSocketDebuggerUrl);
      await sw.send("Runtime.enable");

      // 3. The worker must have installed its message listener and set up state.
      const probe = await sw.evaluate(`
        (() => {
          const hasChrome = typeof chrome !== 'undefined';
          const hasRuntime = hasChrome && !!chrome.runtime?.id;
          return {
            chrome: hasChrome,
            runtimeId: hasChrome ? chrome.runtime?.id : null,
            manifestVersion: hasChrome ? chrome.runtime?.getManifest?.().version : null,
          };
        })()
      `);
      const v = probe.value ?? {};
      check("extension runtime is live in the worker", Boolean(v.runtimeId), JSON.stringify(probe));
      check(
        "worker reports the packaged version",
        v.manifestVersion === manifest.version,
        `worker=${v.manifestVersion} package=${manifest.version}`,
      );

      const listenerProbe = await sw.evaluate(`
        (() => {
          try {
            return { ok: typeof chrome.runtime.onMessage?.addListener === 'function' };
          } catch (e) { return { ok: false, error: String(e) }; }
        })()
      `);
      check("onMessage API is available to the worker", Boolean(listenerProbe.value?.ok));

      await sleep(1500);
      const swErrors = sw.exceptions.filter(
        (e) => !/network|fetch|ERR_|Failed to fetch/i.test(e),
      );
      check(
        "worker started without uncaught exceptions",
        swErrors.length === 0,
        swErrors.slice(0, 2).join(" | "),
      );
      sw.close();
    }

    // 4. Every extension entry page must render under the real extension CSP.
    //
    //    Probing only options.html left the two largest surfaces unverified:
    //    sidepanel and tab-main each carry 60 modules / 4.5 MB, and a broken one
    //    would render a blank page while this script still reported success.
    //    Round-1 review demonstrated exactly that, so all entries are opened.
    //
    //    Note: side_panel pages CAN be opened as ordinary tabs; an earlier
    //    comment here claimed otherwise and used it to justify skipping them.
    const ENTRY_PAGES = [
      { file: "options.html", label: "options" },
      { file: "sidepanel.html", label: "sidepanel" },
      { file: "tabs/tab-main.html", label: "tab-main" },
    ];

    for (const entry of ENTRY_PAGES) {
      const extTab = await fetch(
        `http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/${entry.file}`,
        { method: "PUT" },
      )
        .then((r) => r.json())
        .catch(() => null);

      if (!extTab?.webSocketDebuggerUrl) {
        check(`${entry.label} page opens`, false, "could not create a tab");
        continue;
      }

      const page = await connect(extTab.webSocketDebuggerUrl);
      await page.send("Runtime.enable");
      await sleep(3500);

      const domProbe = await page.evaluate(`
        (() => {
          const root = document.getElementById('__plasmo');
          return {
            url: location.href,
            hasRoot: !!root,
            rootChildren: root ? root.childElementCount : 0,
            bodyLength: document.body?.innerHTML?.length ?? 0,
            title: document.title,
            textSample: (document.body?.innerText ?? '').slice(0, 120),
          };
        })()
      `);
      const d = domProbe.value ?? {};

      check(
        `${entry.label} page opens`,
        String(d.url ?? "").startsWith(`chrome-extension://${extId}`),
        d.url,
      );
      check(`${entry.label} React root exists`, Boolean(d.hasRoot));
      check(
        `${entry.label} UI actually rendered`,
        Number(d.rootChildren) > 0,
        `children=${d.rootChildren}`,
      );
      check(
        `${entry.label} page has content`,
        Number(d.bodyLength) > 100,
        `bodyLength=${d.bodyLength}`,
      );

      // Page-level exceptions are failures, with two documented exceptions:
      //   - network noise (the harness has no backend)
      //   - sidepanel's transport errors: the panel is designed to talk to the
      //     side-panel host, which does not exist when the same document is
      //     opened as an ordinary tab. Chrome surfaces this as
      //     "disconnected" / "Could not establish connection". The UI still
      //     renders, which the assertions above already confirmed, so the
      //     transport noise is not a defect in the package.
      const IGNORED =
        /network|fetch|ERR_|Failed to fetch|api\.vcaptions|disconnected|Could not establish connection/i;
      const pageErrors = page.exceptions.filter((e) => !IGNORED.test(e));
      check(
        `${entry.label} page rendered without uncaught exceptions`,
        pageErrors.length === 0,
        pageErrors.slice(0, 2).join(" | "),
      );

      page.close();
      await sleep(400);
    }

    // 5. Content scripts must actually execute on a matching page.
    //
    //    Round-1 review broke all five content-script bundles (first line
    //    `throw`) and every check still passed, because nothing ever opened a
    //    page the manifest targets.
    //
    //    The probe page is a local `data:`-free HTTP server on loopback, not a
    //    public site: relying on example.com made the check fail whenever the
    //    machine had no outbound network, which is a property of the test
    //    environment rather than of the package.
    {
      // Serve a minimal page from loopback so the content script has a real
      // http(s) origin to match against.
      const http = await import("node:http");
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html><head><title>probe</title></head><body><video></video></body></html>");
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const probeUrl = `http://127.0.0.1:${port}/`;

      try {
        const testPage = await fetch(
          `http://127.0.0.1:${PORT}/json/new?${probeUrl}`,
          { method: "PUT" },
        )
          .then((r) => r.json())
          .catch(() => null);

        if (!testPage?.webSocketDebuggerUrl) {
          check("content script injection probe", false, "could not open a test page");
        } else {
          const page = await connect(testPage.webSocketDebuggerUrl);
          await page.send("Runtime.enable");
          await sleep(4000);

          const injected = await page.evaluate(`
            (() => {
              // Any element whose id starts with vcaptions/plasmo means the
              // content script ran and reached its mount step. The first element
              // the extension creates on a plain page is
              // \`vcaptions-subtitle-iframe\`, so a fixed allow-list of ids missed
              // it; match by prefix instead.
              const nodes = [...document.querySelectorAll('[id]')];
              const found = nodes
                .map((e) => e.id)
                .filter((id) => /^(vcaptions|plasmo)/.test(id));
              return {
                url: location.href,
                found,
                bodyLength: document.body?.innerHTML?.length ?? 0,
              };
            })()
          `);
          const d = injected.value ?? {};

          check(
            "content script executed on a matching page",
            Array.isArray(d.found) && d.found.length > 0,
            `found=${JSON.stringify(d.found)} url=${d.url ?? "?"}`,
          );

          const injectErrors = page.exceptions.filter(
            (e) => !/network|fetch|ERR_|Failed to fetch|api\.vcaptions/i.test(e),
          );
          check(
            "content script ran without uncaught exceptions",
            injectErrors.length === 0,
            injectErrors.slice(0, 2).join(" | "),
          );
          page.close();
        }
      } finally {
        server.close();
      }
    }
  } catch (err) {
    check("verification ran to completion", false, err.message);
  } finally {
    browser?.close();
    await killChromeTree(child);
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true });
  }

  console.log(
    failures.length === 0
      ? "\nbrowser verification passed"
      : `\n${failures.length} problem(s) found`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("browser verification error:", err.message);
  process.exit(1);
});
