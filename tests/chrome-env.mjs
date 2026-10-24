/**
 * Minimal Chrome extension environment for loading and exercising the built
 * bundles in Node.
 *
 * The reconstructed background bundle calls a specific, bounded set of extension
 * APIs. This harness provides those APIs with in-memory state, records every
 * call, and lets a test drive message handlers the way the browser would.
 *
 * It is deliberately a *test double*, not a Chrome emulator: it implements the
 * surface the extension actually touches, and throws on unknown access so a
 * missing stub fails loudly instead of silently returning undefined.
 */
import fs from "node:fs";
import path from "node:path";

/** An in-memory chrome.storage area with change notifications. */
class StorageArea {
  constructor(area, onChange) {
    this.area = area;
    this.data = new Map();
    this.onChange = onChange;
  }

  async get(keys) {
    // chrome.storage serialises values: a caller that mutates the object it got
    // back does NOT change what is stored. Returning the stored reference let a
    // handler appear to work while its write never persisted, so every read is
    // cloned here.
    const clone = (v) => (v === undefined ? undefined : structuredClone(v));

    // chrome.storage.get accepts undefined, a string, an array, or an object
    // of defaults. Support all four shapes because the bundle uses several.
    if (keys == null) {
      return Object.fromEntries([...this.data].map(([k, v]) => [k, clone(v)]));
    }
    if (typeof keys === "string") {
      return this.data.has(keys) ? { [keys]: clone(this.data.get(keys)) } : {};
    }
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (this.data.has(k)) out[k] = clone(this.data.get(k));
      return out;
    }
    const out = {};
    for (const [k, fallback] of Object.entries(keys)) {
      out[k] = this.data.has(k) ? clone(this.data.get(k)) : fallback;
    }
    return out;
  }

  async set(items) {
    const changes = {};
    for (const [k, v] of Object.entries(items)) {
      // Store a snapshot, not the caller's object. Otherwise a later mutation by
      // the caller would silently rewrite "stored" state.
      const stored = v === undefined ? undefined : structuredClone(v);
      changes[k] = { oldValue: this.data.get(k), newValue: stored };
      this.data.set(k, stored);
    }
    this.onChange?.(changes, this.area);
  }

  async remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of list) {
      if (!this.data.has(k)) continue;
      changes[k] = { oldValue: this.data.get(k), newValue: undefined };
      this.data.delete(k);
    }
    if (Object.keys(changes).length) this.onChange?.(changes, this.area);
  }

  async clear() {
    const changes = {};
    for (const [k, v] of this.data) changes[k] = { oldValue: v, newValue: undefined };
    this.data.clear();
    if (Object.keys(changes).length) this.onChange?.(changes, this.area);
  }

  async getBytesInUse() {
    return JSON.stringify(Object.fromEntries(this.data)).length;
  }
}

/** A listener registry that mirrors Chrome's event objects. */
class Event {
  constructor(name, log) {
    this.name = name;
    this.log = log;
    this.listeners = [];
  }

  addListener(fn) {
    this.listeners.push(fn);
    this.log.push(`${this.name}.addListener`);
  }

  removeListener(fn) {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }

  hasListener(fn) {
    return this.listeners.includes(fn);
  }

  /** Invoke every listener; used by tests to simulate browser events. */
  async emit(...args) {
    const results = [];
    for (const l of this.listeners) results.push(await l(...args));
    return results;
  }
}

/**
 * A very small IndexedDB stand-in.
 *
 * The background uses IndexedDB for large payloads (subtitles, transcripts).
 * A full implementation is unnecessary for a startup smoke test, but the object
 * must exist and behave plausibly so the extension's cleanup and open paths do
 * not fail with ReferenceError. Only the surface the bundle touches is modelled.
 */
function createIndexedDB() {
  const databases = new Map();

  class FakeRequest {
    constructor() {
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
      this.result = undefined;
      this.error = null;
    }
    _succeed(result) {
      this.result = result;
      queueMicrotask(() => this.onsuccess?.({ target: this }));
    }
  }

  class FakeTransaction {
    constructor(db, stores) {
      this.db = db;
      this.mode = "readonly";
      this.objectStoreNames = stores;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
    }
    objectStore(name) {
      return new FakeObjectStore(this.db, name, this);
    }
    abort() {
      queueMicrotask(() => this.onabort?.({ target: this }));
    }
  }

  class FakeObjectStore {
    constructor(db, name, tx) {
      this.db = db;
      this.name = name;
      this.transaction = tx;
      // idb and the extension both probe index existence before creating one.
      this.indexNames = {
        contains: (n) => this._indexes.has(n),
        length: 0,
        item: () => null,
        [Symbol.iterator]: () => this._indexes.keys(),
      };
      this._indexes = new Set();
    }
    _bucket() {
      const key = `${this.db.name}::${this.name}`;
      if (!this.db._data.has(key)) this.db._data.set(key, new Map());
      return this.db._data.get(key);
    }
    get(key) {
      const req = new FakeRequest();
      const bucket = this._bucket();
      req._succeed(bucket.get(key));
      return req;
    }
    getAll() {
      const req = new FakeRequest();
      req._succeed([...this._bucket().values()]);
      return req;
    }
    getAllKeys() {
      const req = new FakeRequest();
      req._succeed([...this._bucket().keys()]);
      return req;
    }
    put(value, key) {
      const req = new FakeRequest();
      const k = key ?? value?.id ?? value?.key;
      this._bucket().set(k, value);
      req._succeed(k);
      return req;
    }
    add(value, key) {
      return this.put(value, key);
    }
    delete(key) {
      const req = new FakeRequest();
      this._bucket().delete(key);
      req._succeed(undefined);
      return req;
    }
    clear() {
      const req = new FakeRequest();
      this._bucket().clear();
      req._succeed(undefined);
      return req;
    }
    count() {
      const req = new FakeRequest();
      req._succeed(this._bucket().size);
      return req;
    }
    createIndex(name) {
      this._indexes.add(name);
      return this;
    }
    index(name) {
      return this;
    }
    openCursor() {
      const req = new FakeRequest();
      req._succeed(null);
      return req;
    }
  }

  class FakeDatabase {
    constructor(name, version) {
      this.name = name;
      this.version = version;
      this._stores = new Set();
      this.objectStoreNames = {
        contains: (n) => this._stores.has(n),
        get length() {
          return this._stores?.size ?? 0;
        },
        item: () => null,
        [Symbol.iterator]: () => this._stores.keys(),
      };
      this._data = new Map();
      this.onversionchange = null;
      this.onclose = null;
    }
    createObjectStore(name) {
      this._stores.add(name);
      return new FakeObjectStore(this, name, null);
    }
    deleteObjectStore(name) {
      this._stores.delete(name);
    }
    transaction(stores) {
      const list = Array.isArray(stores) ? stores : [stores];
      return new FakeTransaction(this, list);
    }
    close() {}
  }

  return {
    /**
     * Open a database with real upgrade semantics.
     *
     * The previous version had three defects that let broken code pass:
     *   - `oldVersion` was reported as the *new* version, so an upgrade handler
     *     could not tell what it was migrating from
     *   - requesting a higher version did not raise the stored version, so a
     *     second open never re-ran the upgrade path
     *   - `_succeed` was called before the upgrade, firing `onsuccess` twice
     *
     * Real IndexedDB fires `upgradeneeded` only when `version` exceeds the
     * current one, then `success`. That ordering is reproduced here.
     */
    open(name, version = 1) {
      const req = new FakeRequest();
      let db = databases.get(name);
      const oldVersion = db ? db.version : 0;

      if (!db) {
        db = new FakeDatabase(name, version);
        databases.set(name, db);
      }

      const needsUpgrade = version > oldVersion;
      if (needsUpgrade) {
        db.version = version;
      }

      queueMicrotask(() => {
        if (needsUpgrade) {
          // `result` is the connection being upgraded, as in the spec.
          req.result = db;
          req.onupgradeneeded?.({ target: req, oldVersion, newVersion: version });
        }
        req._succeed(db);
      });
      return req;
    },
    deleteDatabase(name) {
      const req = new FakeRequest();
      databases.delete(name);
      req._succeed(undefined);
      return req;
    },
    databases: async () => [...databases.keys()].map((name) => ({ name, version: databases.get(name).version })),
  };
}

/**
 * Build a chrome API object plus bookkeeping the tests can inspect.
 *
 * @param {object} [options]
 * @param {object} [options.manifest] manifest to serve from runtime.getManifest
 * @param {string[]} [options.tabs] tab URLs returned by tabs.query
 */
export function createChromeEnv(options = {}) {
  const calls = [];
  const log = [];
  const messageListeners = [];
  const externalMessageListeners = [];
  const sentTabMessages = [];
  const registeredScripts = [];
  const panelBehavior = [];

  const record = (name) => (...args) => {
    calls.push({ name, args });
    return undefined;
  };

  const onChange = new Event("storage.onChanged", log);
  const local = new StorageArea("local", (changes, area) => {
    onChange.emit(changes, area);
  });
  const session = new StorageArea("session", (changes, area) => {
    onChange.emit(changes, area);
  });

  const tabList = (options.tabs ?? ["https://www.youtube.com/watch?v=test"]).map((url, i) => ({
    id: i + 1,
    url,
    active: i === 0,
    windowId: 1,
  }));

  const chrome = {
    runtime: {
      id: "bciglihaegkdhoogebcdblfhppoilclp",
      getURL: (p) => `chrome-extension://bciglihaegkdhoogebcdblfhppoilclp/${String(p).replace(/^\//, "")}`,
      getManifest: () => options.manifest ?? { version: "2.4.6", manifest_version: 3 },
      getPlatformInfo: async () => ({ os: "win", arch: "x86-64" }),
      lastError: undefined,
      onMessage: {
        addListener: (fn) => {
          messageListeners.push(fn);
          log.push("runtime.onMessage.addListener");
        },
        removeListener: (fn) => {
          const i = messageListeners.indexOf(fn);
          if (i >= 0) messageListeners.splice(i, 1);
        },
        hasListener: (fn) => messageListeners.includes(fn),
      },
      onMessageExternal: {
        addListener: (fn) => externalMessageListeners.push(fn),
        removeListener: () => {},
      },
      onConnect: new Event("runtime.onConnect", log),
      onInstalled: new Event("runtime.onInstalled", log),
      onStartup: new Event("runtime.onStartup", log),
      onSuspend: new Event("runtime.onSuspend", log),
      sendMessage: async (msg) => {
        calls.push({ name: "runtime.sendMessage", args: [msg] });
        return undefined;
      },
      connect: () => ({ postMessage: record("runtime.port.postMessage"), disconnect: () => {} }),
      openOptionsPage: async () => {
        calls.push({ name: "runtime.openOptionsPage", args: [] });
      },
    },
    storage: {
      local,
      session,
      sync: new StorageArea("sync", (c, a) => onChange.emit(c, a)),
      onChanged: onChange,
    },
    tabs: {
      query: async (q) => {
        calls.push({ name: "tabs.query", args: [q] });
        return tabList;
      },
      get: async (id) => tabList.find((t) => t.id === id) ?? tabList[0],
      sendMessage: async (tabId, msg) => {
        sentTabMessages.push({ tabId, msg });
        calls.push({ name: "tabs.sendMessage", args: [tabId, msg] });
        return undefined;
      },
      create: async (props) => {
        calls.push({ name: "tabs.create", args: [props] });
        return { id: 99, ...props };
      },
      update: async (id, props) => {
        calls.push({ name: "tabs.update", args: [id, props] });
        return { id, ...props };
      },
      remove: async (id) => {
        calls.push({ name: "tabs.remove", args: [id] });
      },
      onRemoved: new Event("tabs.onRemoved", log),
      onUpdated: new Event("tabs.onUpdated", log),
      onActivated: new Event("tabs.onActivated", log),
      onCreated: new Event("tabs.onCreated", log),
    },
    scripting: {
      registerContentScripts: async (scripts) => {
        registeredScripts.push(...scripts);
        calls.push({ name: "scripting.registerContentScripts", args: [scripts] });
      },
      unregisterContentScripts: async () => {
        calls.push({ name: "scripting.unregisterContentScripts", args: [] });
      },
      getRegisteredContentScripts: async () => registeredScripts,
      executeScript: async (opts) => {
        calls.push({ name: "scripting.executeScript", args: [opts] });
        return [];
      },
    },
    sidePanel: {
      setPanelBehavior: async (opts) => {
        panelBehavior.push(opts);
        calls.push({ name: "sidePanel.setPanelBehavior", args: [opts] });
      },
      open: async (opts) => {
        calls.push({ name: "sidePanel.open", args: [opts] });
      },
      onOpened: new Event("sidePanel.onOpened", log),
      onClosed: new Event("sidePanel.onClosed", log),
    },
    action: {
      onClicked: new Event("action.onClicked", log),
      setBadgeText: async (o) => {
        calls.push({ name: "action.setBadgeText", args: [o] });
      },
      setBadgeBackgroundColor: async (o) => {
        calls.push({ name: "action.setBadgeBackgroundColor", args: [o] });
      },
      setIcon: async (o) => {
        calls.push({ name: "action.setIcon", args: [o] });
      },
      setTitle: async (o) => {
        calls.push({ name: "action.setTitle", args: [o] });
      },
      openPopup: async () => {
        calls.push({ name: "action.openPopup", args: [] });
      },
    },
    commands: {
      onCommand: new Event("commands.onCommand", log),
      getAll: async () => [],
    },
    i18n: {
      getMessage: (key, subs) => {
        const table = options.messages ?? {};
        const entry = table[key];
        if (!entry) return key;
        let text = entry.message ?? String(entry);
        if (subs) {
          const arr = Array.isArray(subs) ? subs : [subs];
          arr.forEach((v, i) => {
            text = text.replace(new RegExp(`\\$${i + 1}`, "g"), String(v));
          });
        }
        return text;
      },
      getUILanguage: () => options.locale ?? "en",
    },
    windows: {
      getCurrent: async () => ({ id: 1 }),
      get: async (id) => ({ id, type: "normal" }),
      create: async (p) => {
        calls.push({ name: "windows.create", args: [p] });
        return { id: 2 };
      },
      onFocusChanged: new Event("windows.onFocusChanged", log),
      onRemoved: new Event("windows.onRemoved", log),
    },
    alarms: {
      create: (name, info) => {
        calls.push({ name: "alarms.create", args: [name, info] });
      },
      clear: async () => true,
      onAlarm: new Event("alarms.onAlarm", log),
    },
    notifications: {
      create: async (id, opts) => {
        calls.push({ name: "notifications.create", args: [id, opts] });
      },
      onClicked: new Event("notifications.onClicked", log),
    },
    contextMenus: {
      create: (o) => {
        calls.push({ name: "contextMenus.create", args: [o] });
      },
      removeAll: (cb) => cb?.(),
      onClicked: new Event("contextMenus.onClicked", log),
    },
  };

  // `browser` is what webextension-polyfill prefers when present; point it at
  // the same object so the polyfill takes the native path instead of wrapping.
  const env = {
    chrome,
    browser: chrome,
    indexedDB: createIndexedDB(),
    calls,
    log,
    messageListeners,
    externalMessageListeners,
    sentTabMessages,
    registeredScripts,
    panelBehavior,
    local,
    session,
  };

  /**
   * Deliver a message to the registered onMessage listeners, the way Chrome
   * does. The extension replies through the `sendResponse` callback and returns
   * `true` to keep the channel open, so the reply is always asynchronous here.
   */
  // Default sender models a real content-script call: Chrome always supplies
  // both `tab.id` and `tab.windowId`. Omitting windowId made handlers that guard
  // on it take their error branch, so a probe could "reply" without ever
  // exercising the success path.
  env.sendRuntimeMessage = async (
    message,
    sender = { tab: { id: 1, windowId: 1 }, id: chrome.runtime.id, url: tabList[0]?.url },
  ) => {
    return new Promise((resolve, reject) => {
      let settled = false;
      const sendResponse = (response) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      let wantsAsync = false;
      for (const listener of messageListeners) {
        try {
          const result = listener(message, sender, sendResponse);
          if (result === true) wantsAsync = true;
          else if (result && typeof result.then === "function") {
            wantsAsync = true;
            result.catch(reject);
          }
        } catch (err) {
          reject(err);
          return;
        }
      }
      if (!wantsAsync) {
        // No listener kept the channel open; give it a tick in case one replied
        // synchronously through sendResponse, then resolve with undefined.
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(undefined);
          }
        }, 0);
      }
    });
  };

  return env;
}

/**
 * Load a bundle into a sandboxed function scope with the given environment
 * installed as globals.
 *
 * @param {string} file absolute path to the bundle
 * @param {object} env result of createChromeEnv
 */
export function loadBundle(file, env) {
  const code = fs.readFileSync(file, "utf8");
  const g = globalThis;
  const saved = {
    chrome: g.chrome,
    browser: g.browser,
    self: g.self,
    window: g.window,
    define: g.define,
    indexedDB: g.indexedDB,
    IDBKeyRange: g.IDBKeyRange,
    fetch: g.fetch,
  };
  g.chrome = env.chrome;
  g.browser = env.browser;
  g.self = g;
  g.define = undefined;
  g.indexedDB = env.indexedDB;
  g.IDBKeyRange = { only: (v) => v, bound: (a, b) => [a, b], lowerBound: (v) => v, upperBound: (v) => v };
  // Block real network access: this test must stay hermetic. The extension's
  // settings fetch and analytics calls simply fail, which the bundle tolerates.
  g.fetch = async (url) => {
    env.calls.push({ name: "fetch", args: [url] });
    throw new Error(`network disabled in test harness: ${url}`);
  };

  try {
    // Bundles are scripts, not modules; run them in the current realm so they
    // can see the injected globals.
    new Function(code)();
  } finally {
    // Leave the globals in place: the bundle keeps running (timers, listeners)
    // and needs them for later callbacks. The test process exits when done.
    void saved;
  }
  return env;
}

/** Convenience: read a built bundle from dist/. */
export function distPath(root, rel) {
  return path.join(root, "dist", rel);
}
