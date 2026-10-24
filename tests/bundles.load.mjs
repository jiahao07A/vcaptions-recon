#!/usr/bin/env node
/**
 * Loadability test for every built bundle, one process per bundle.
 *
 * Why a separate process per bundle: Parcel bundles register their modules on a
 * shared global (`parcelRequire4da4`). Loading several bundles into one realm
 * makes the second bundle reuse the first one's registry, so the later bundle's
 * own module bodies may never execute. Review round-1 confirmed the registry
 * object is literally the same instance after loading two bundles, which means a
 * single-process loader can silently skip the code it claims to test.
 *
 * Isolation is therefore structural: each bundle runs in its own child process,
 * so no registry can leak between them. A bundle that fails to start cannot be
 * masked by an earlier one having already provided a module id.
 *
 * Usage:
 *   node tests/bundles.load.mjs            run all bundles
 *   node tests/bundles.load.mjs --worker <file>   internal: load one bundle
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createChromeEnv, loadBundle } from "./chrome-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Every bundle the manifest loads, with what it needs to start. */
const BUNDLES = [
  { file: "MainCS.277dcde3.js", label: "内容脚本（主）" },
  { file: "IFrameCS.26275720.js", label: "内容脚本（IFrame）" },
  { file: "YoutubeCS.6bf33c81.js", label: "内容脚本（YouTube）" },
  { file: "WebappCS.8b5d7cd6.js", label: "内容脚本（Webapp）" },
  { file: "Main.00175a8f.js", label: "内容脚本（应用）" },
  { file: "SubtitleBar.f2dae354.js", label: "字幕条" },
  { file: "sidepanel.65d86198.js", label: "侧边栏" },
  { file: "options.6406b895.js", label: "设置页" },
  { file: "tabs/tab-main.1e0435ca.js", label: "标签页" },
];

/**
 * Install the smallest DOM that React can mount into.
 * Not jsdom: just enough surface for a first render.
 */
function installDomShim() {
  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
      toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
      get length() {
        return set.size;
      },
    };
  };

  class ShimNode {
    constructor(tagName = "div", ownerDocument = null) {
      this.tagName = String(tagName).toUpperCase();
      this.nodeName = this.tagName;
      this.nodeType = 1;
      this.ownerDocument = ownerDocument;
      this.childNodes = [];
      this.parentNode = null;
      this.attributes = {};
      this.style = {};
      this.classList = makeClassList();
      this.dataset = {};
      this.listeners = new Map();
      this._text = "";
      this.shadowRoot = null;
      this.id = "";
      this.className = "";
    }
    get children() {
      return this.childNodes.filter((n) => n.nodeType === 1);
    }
    get firstChild() {
      return this.childNodes[0] ?? null;
    }
    get textContent() {
      return this._text + this.childNodes.map((c) => c.textContent ?? "").join("");
    }
    set textContent(v) {
      this._text = String(v);
      this.childNodes = [];
    }
    get innerHTML() {
      return this.textContent;
    }
    set innerHTML(v) {
      this._text = String(v);
      this.childNodes = [];
    }
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    insertBefore(node, ref) {
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) return this.appendChild(node);
      node.parentNode = this;
      this.childNodes.splice(i, 0, node);
      return node;
    }
    removeChild(node) {
      const i = this.childNodes.indexOf(node);
      if (i >= 0) this.childNodes.splice(i, 1);
      node.parentNode = null;
      return node;
    }
    replaceChild(next, prev) {
      const i = this.childNodes.indexOf(prev);
      if (i >= 0) this.childNodes[i] = next;
      return prev;
    }
    remove() {
      this.parentNode?.removeChild(this);
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === "id") this.id = String(v);
      if (k === "class") this.className = String(v);
    }
    getAttribute(k) {
      return this.attributes[k] ?? null;
    }
    removeAttribute(k) {
      delete this.attributes[k];
    }
    hasAttribute(k) {
      return k in this.attributes;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    dispatchEvent(evt) {
      for (const fn of this.listeners.get(evt?.type) ?? []) fn(evt);
      return true;
    }
    attachShadow() {
      this.shadowRoot = new ShimNode("#shadow-root", this.ownerDocument);
      return this.shadowRoot;
    }
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }
    focus() {}
    blur() {}
    scrollIntoView() {}
    cloneNode() {
      return new ShimNode(this.tagName, this.ownerDocument);
    }
  }

  const body = new ShimNode("body");
  const head = new ShimNode("head");
  const documentElement = new ShimNode("html");
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const root = new ShimNode("div");
  root.setAttribute("id", "__plasmo");
  body.appendChild(root);

  const document = {
    nodeType: 9,
    documentElement,
    head,
    body,
    readyState: "complete",
    createElement: (tag) => new ShimNode(tag, document),
    createElementNS: (_ns, tag) => new ShimNode(tag, document),
    createTextNode: (text) => {
      const n = new ShimNode("#text", document);
      n.nodeType = 3;
      n.textContent = text;
      return n;
    },
    createDocumentFragment: () => new ShimNode("#fragment", document),
    getElementById: (id) => (id === "__plasmo" ? root : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({
      selectNodeContents: () => {},
      setStart: () => {},
      setEnd: () => {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      getClientRects: () => [],
    }),
    get activeElement() {
      return body;
    },
    location: { href: "https://www.youtube.com/watch?v=test", origin: "https://www.youtube.com" },
    title: "vCaptions",
    cookie: "",
    visibilityState: "visible",
    hidden: false,
  };

  const win = {
    document,
    location: document.location,
    navigator: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0",
      language: "en",
      languages: ["en"],
      platform: "Win32",
      product: "Gecko",
    },
    innerWidth: 1280,
    innerHeight: 800,
    outerWidth: 1280,
    outerHeight: 800,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    postMessage: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => "", fontSize: "16px" }),
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    performance: globalThis.performance,
    URL: globalThis.URL,
    Blob: globalThis.Blob,
    File: globalThis.File,
    FormData: globalThis.FormData,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    AbortController: globalThis.AbortController,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    XMLHttpRequest: class ShimXHR {
      constructor() {
        this.readyState = 0;
        this.status = 0;
        this.responseText = "";
        this.response = "";
        this.responseType = "";
        this.timeout = 0;
        this.withCredentials = false;
        this.upload = { addEventListener: () => {}, removeEventListener: () => {} };
        this._listeners = new Map();
        this._headers = {};
      }
      open(method, url) {
        this._method = method;
        this._url = url;
        this.readyState = 1;
      }
      send() {
        this.readyState = 4;
        this.status = 200;
        queueMicrotask(() => {
          this.dispatchEvent({ type: "load" });
          this.dispatchEvent({ type: "loadend" });
        });
      }
      abort() {
        this.dispatchEvent({ type: "abort" });
      }
      setRequestHeader(k, v) {
        this._headers[k] = v;
      }
      getResponseHeader() {
        return null;
      }
      getAllResponseHeaders() {
        return "";
      }
      overrideMimeType() {}
      addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
      }
      removeEventListener(type, fn) {
        this._listeners.get(type)?.delete(fn);
      }
      dispatchEvent(evt) {
        for (const fn of this._listeners.get(evt?.type) ?? []) fn(evt);
        const handler = this[`on${evt?.type}`];
        if (typeof handler === "function") handler(evt);
        return true;
      }
    },
    history: {
      length: 1,
      state: null,
      pushState: () => {},
      replaceState: () => {},
      back: () => {},
      forward: () => {},
      go: () => {},
    },
    getSelection: () => ({
      toString: () => "",
      removeAllRanges: () => {},
      addRange: () => {},
      getRangeAt: () => ({ cloneRange: () => ({}), collapse: () => {}, selectNodeContents: () => {} }),
      rangeCount: 0,
    }),
    HTMLElement: ShimNode,
    Element: ShimNode,
    Node: ShimNode,
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.parent = win;
  // Content scripts reach browser APIs through window.*
  win.fetch = globalThis.fetch;
  win.console = console;
  win.JSON = globalThis.JSON;
  win.Math = globalThis.Math;
  win.Date = globalThis.Date;
  win.Promise = globalThis.Promise;
  win.Object = globalThis.Object;
  win.Array = globalThis.Array;
  win.String = globalThis.String;
  win.Number = globalThis.Number;
  win.Boolean = globalThis.Boolean;
  win.Error = globalThis.Error;
  win.Map = globalThis.Map;
  win.Set = globalThis.Set;
  win.WeakMap = globalThis.WeakMap;
  win.Symbol = globalThis.Symbol;
  win.RegExp = globalThis.RegExp;

  return win;
}

/**
 * Worker mode: load exactly one bundle and report the outcome as JSON.
 *
 * Runs in its own process so the Parcel module registry starts empty. Anything
 * the bundle registers dies with this process.
 */
async function runWorker(relFile) {
  const abs = path.join(ROOT, "dist", relFile);
  const result = { file: relFile, ok: false, error: null, phase: "init" };

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "manifest.json"), "utf8"));
  const messages = JSON.parse(
    fs.readFileSync(path.join(ROOT, "dist", "_locales", "en", "messages.json"), "utf8"),
  );
  const env = createChromeEnv({ manifest, messages });

  // Silence bundle logging; the parent only needs the verdict.
  const noise = [];
  const realLog = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  console.info = (...a) => noise.push(a);
  console.warn = (...a) => noise.push(a);
  console.error = (...a) => noise.push(a);
  console.log = (...a) => noise.push(a);

  try {
    const win = installDomShim();
    const setGlobal = (name, value) => {
      try {
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
      } catch {
        globalThis[name] = value;
      }
    };
    for (const key of [
      "window", "document", "navigator", "location", "history", "HTMLElement", "Element",
      "Node", "Event", "CustomEvent", "XMLHttpRequest", "requestAnimationFrame",
      "cancelAnimationFrame", "ResizeObserver", "MutationObserver", "IntersectionObserver",
      "matchMedia", "getComputedStyle", "getSelection",
    ]) {
      setGlobal(key, key === "window" ? win : win[key]);
    }

    result.phase = "load";
    loadBundle(abs, env);
    await new Promise((r) => setTimeout(r, 500));

    // A bundle that throws inside an async callback still counts as loaded; only
    // a synchronous throw during evaluation fails it. Record both.
    result.phase = "settled";
    result.ok = true;
    result.errors = noise
      .filter((a) => typeof a[0] === "string" && /error/i.test(a[0]))
      .slice(0, 3)
      .map((a) => String(a[0]).slice(0, 160));
  } catch (err) {
    result.error = err.message ?? String(err);
  } finally {
    Object.assign(console, realLog);
  }

  process.stdout.write(`__RESULT__${JSON.stringify(result)}\n`);
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    runWorker(args[1]).catch((err) => {
      process.stdout.write(
        `__RESULT__${JSON.stringify({ ok: false, error: err.message, phase: "harness" })}\n`,
      );
      process.exit(0);
    });
    return;
  }

  if (!fs.existsSync(path.join(ROOT, "dist", "manifest.json"))) {
    process.stderr.write("dist/ missing; run `npm run build` first\n");
    process.exit(2);
  }

  let failures = 0;
  let passed = 0;

  for (const entry of BUNDLES) {
    const abs = path.join(ROOT, "dist", entry.file);
    if (!fs.existsSync(abs)) {
      process.stdout.write(`FAIL  ${entry.label} — missing ${entry.file}\n`);
      failures++;
      continue;
    }

    let verdict = null;
    try {
      const out = execFileSync(
        process.execPath,
        [path.join(ROOT, "tests", "bundles.load.mjs"), "--worker", entry.file],
        { encoding: "utf8", cwd: ROOT, timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
      );
      const line = out.split("\n").find((l) => l.startsWith("__RESULT__"));
      verdict = line ? JSON.parse(line.slice("__RESULT__".length)) : null;
    } catch (err) {
      const out = `${err.stdout ?? ""}`;
      const line = out.split("\n").find((l) => l.startsWith("__RESULT__"));
      verdict = line ? JSON.parse(line.slice("__RESULT__".length)) : { ok: false, error: err.message };
    }

    if (!verdict) {
      process.stdout.write(`FAIL  ${entry.label} — worker produced no verdict\n`);
      failures++;
      continue;
    }

    if (verdict.ok) {
      process.stdout.write(`ok    ${entry.label}\n`);
      passed++;
    } else {
      // No "harness gap" downgrade: an exception during load is a real failure.
      // The previous version treated `Cannot read`/`is not defined` as skips,
      // which hid genuine regressions.
      process.stdout.write(
        `FAIL  ${entry.label} — ${String(verdict.error).slice(0, 140)} ` +
          `(phase: ${verdict.phase})\n`,
      );
      failures++;
    }
  }

  process.stdout.write(`\n${passed} loaded, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
