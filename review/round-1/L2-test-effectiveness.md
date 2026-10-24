# L2 测试有效性 审查报告

审查者：subagent L2-test-effectiveness
审查范围：`tests/chrome-env.mjs`、`tests/background.smoke.mjs`、`tests/bundles.load.mjs`、`tests/overlay.check.mjs`、`tests/edit-safety.check.mjs`、`tests/validator.check.mjs`、`tests/package.check.mjs`、`tests/consistency.check.mjs`
审查时间：2026-10-21T16:13:23+08:00

## 结论摘要

这层测试的**覆盖面看起来是 7 个脚本，实际有效断言集中在 3 个**。`validator.check`、`package.check`、`consistency.check` 是真能捕获回归的；`background.smoke` 只对"处理器被删除"敏感，对返回值内容和 `return true` 契约完全无感；`bundles.load` 有一个结构性缺陷——它把 9 个 bundle 加载进同一个 realm，共享 `globalThis.parcelRequire4da4`，导致**9 个 bundle 里有 4 个（WebappCS、SubtitleBar、options、tab-main，共 96 个模块）完全无法被检测到回归**：把这些 bundle 里每一个模块体都改成 `throw`，测试仍然 9/9 全绿、退出码 0。

最严重的盲区不是"某个断言写错了"，而是 `overlay.check` 和 `edit-safety.check` 会**删除 `src/overlay/` 和 `release/` 下的用户已有内容**，且 `overlay.check` 还会在删除后打印"baseline is byte-identical"。这属于 P0：跑一次测试就可能丢掉未提交的工作。

## 发现

### [P0] `overlay.check` 和 `edit-safety.check` 无条件删除整个 `src/overlay/`，销毁用户未提交的编辑

- **位置**：`tests/overlay.check.mjs:53`（`cleanup()`）、`tests/overlay.check.mjs:61`、`tests/overlay.check.mjs:118`；`tests/edit-safety.check.mjs:62`、`tests/edit-safety.check.mjs:133`
- **现象**：两个测试都在开头执行 `fs.rmSync(OVERLAY_DIR, { recursive: true, force: true })`，在 `finally` 里再删一次。`src/overlay/` 是 `.gitignore` 明确声明"真实源码改动放在这里"的目录（`!src/overlay/`）。测试把用户的工作目录当成自己的草稿纸。
- **证据**：

  预置一个用户 overlay，然后跑测试：

  ```powershell
  # 预置用户编辑
  New-Item -ItemType Directory -Path "src\overlay\WebappCS.8b5d7cd6" -Force
  Set-Content "src\overlay\WebappCS.8b5d7cd6\hEvvs.js" -Value "// USER-EDIT-MARKER`n(function(){register(""hEvvs"",function(I,G){I.exports={}})})"
  Test-Path src\overlay\WebappCS.8b5d7cd6\hEvvs.js      # True

  node tests/overlay.check.mjs
  # note: pre-existing overlays found; restoring them after the test
  # ...
  # overlay check passed
  # EXIT=0

  Test-Path src\overlay\WebappCS.8b5d7cd6\hEvvs.js      # False  <-- 文件没了
  ```

  `overlay.check` 甚至**明确检测到了**预存 overlay 并打印 `note: pre-existing overlays found; restoring them after the test`，然后照样删掉、不还原。`edit-safety.check` 连这句提示都没有，直接静默删除（同样复现：预置 2 个 overlay 文件，跑完 `Test-Path src\overlay` 返回 `False`）。

- **影响**：`npm test` / `npm run ci` / `npm run release` 都会先跑这两个测试。开发者在 `src/overlay/` 里做的任何未提交修改（这正是项目文档推荐的工作流）会在跑测试时被静默清除。这是 `known-issues.md` 第 10 条"npm run verify 静默抹掉 src/bundles 手改"的同类问题，但严重程度更高：那条已被修复为"拒绝并指名文件"，而 overlay 这条路径**完全没有保护**，而且 `src/overlay/` 不在 git 跟踪保护范围内（它被 gitignore 的 `!src/overlay/` 例外包含，但未提交就等于没有）。
- **建议**：
  1. 测试开始时把 `src/overlay/` 整体移动到临时目录（`fs.renameSync`），结束后移回；不要 `rmSync`。
  2. 若确实需要干净起点，用独立的临时工程根（复制 `src/bundles` + `assets` 到 `os.tmpdir()`），而不是改真实工程树。
  3. 至少在删除前检查 `listOverlays()` 非空则 `process.exit(3)` 并提示"请先提交或暂存 overlay"。
- **置信度**：确定（已复现两次，含文件级 before/after 验证）。

---

### [P0] `bundles.load.mjs` 用单一 realm 加载全部 9 个 bundle，模块注册表互相覆盖，4 个 bundle 的回归完全不可检测

- **位置**：`tests/bundles.load.mjs:434-506`（`for (const entry of BUNDLES)` 循环）、`tests/chrome-env.mjs:557-577`（`loadBundle` 用 `new Function(code)()` 在当前 realm 执行）
- **现象**：9 个 bundle 全部通过 `new Function` 在同一个 Node realm 里求值。每个 bundle 的开头都是同一段 Parcel 引导代码：

  ```js
  var a = n.parcelRequire4da4;
  null == a && ((a = function(e){ if (e in o) return o[e].exports; ... }).register = ..., n.parcelRequire4da4 = a),
  a.register("hEvvs", function(r,s){ ... })
  ```

  `null == a` 只在**第一次**为真。后续 bundle 拿到的是前一个 bundle 的 `a`，`register` 只是往同一张表里塞。而 Parcel 的 `register` 语义是"懒执行"——模块体只有在被 `require` 时才跑。于是：如果模块 id 已被前一个 bundle 注册并实例化，后一个 bundle 里同名模块的**函数体根本不会执行**。

- **证据**：

  决定性实验——把每个 bundle 里**所有** `register("id",function(...){` 的模块体开头插入 `throw new Error("BROKEN_ALL_MODULES")`，然后跑 `tests/bundles.load.mjs`：

  ```
  MainCS.277dcde3.js               modules=  1  testDetects=YES
  IFrameCS.26275720.js             modules=  6  testDetects=YES
  YoutubeCS.6bf33c81.js            modules=  1  testDetects=YES
  WebappCS.8b5d7cd6.js             modules=  1  testDetects=NO  <-- ALL MASKED
  Main.00175a8f.js                 modules= 60  testDetects=YES
  SubtitleBar.f2dae354.js          modules= 16  testDetects=NO  <-- ALL MASKED
  sidepanel.65d86198.js            modules= 60  testDetects=YES
  options.6406b895.js              modules= 19  testDetects=NO  <-- ALL MASKED
  tabs/tab-main.1e0435ca.js        modules= 60  testDetects=NO  <-- ALL MASKED
  ```

  （`modules=` 是 `register(` 出现次数，`testDetects=NO` 表示测试仍然打印 `9 loaded, 0 skipped, 0 failed`、退出码 0。）

  最小复现（不依赖我写的脚本，直接对真实测试下手）：

  ```powershell
  # 在 WebappCS 唯一的模块体开头插入 throw
  node -e "const fs=require('fs');const p='dist/WebappCS.8b5d7cd6.js';const c=fs.readFileSync(p,'utf8');const m='a.register(\"hEvvs\",function(r,s){';const i=c.indexOf(m);fs.writeFileSync(p,c.slice(0,i+m.length)+'throw new Error(\"WEBAPP_HEVVS_BODY_BROKEN\");'+c.slice(i+m.length));"
  node tests/bundles.load.mjs
  # ok    内容脚本（主）
  # ok    内容脚本（IFrame）
  # ok    内容脚本（YouTube）
  # ok    内容脚本（Webapp）     <-- 模块体是 throw，仍然 ok
  # ...
  # 9 loaded, 0 skipped (harness gap), 0 failed
  # EXIT=0
  ```

  单独加载同一个被改坏的 WebappCS 则正常抛错，证明是"被前一个 bundle 遮蔽"而非"我的注入没生效"：

  ```
  A) corrupted WebappCS ALONE        -> THREW: WEBAPP_HEVVS_BODY_BROKEN
  B) MainCS THEN corrupted WebappCS  -> no error  <-- MASKED
  C) hEvvs identical before/after WebappCS load: true
  ```

  遮蔽范围统计（按 `bundles.load.mjs` 的加载顺序累加已注册 id）：

  ```
  bundle                                  total  shadowed  shadowed%
  MainCS.277dcde3.js                         1         0         0%
  IFrameCS.26275720.js                       6         1        17%
  YoutubeCS.6bf33c81.js                      1         0         0%
  WebappCS.8b5d7cd6.js                       1         1       100%
  Main.00175a8f.js                          60         6        10%
  SubtitleBar.f2dae354.js                   16        16       100%
  sidepanel.65d86198.js                     60         0         0%
  options.6406b895.js                       19        19       100%
  tabs/tab-main.1e0435ca.js                 60        60       100%
  TOTAL                                    224       103        46%
  ```

  而且这不是"同源代码、内容一致所以遮蔽无害"：77 个共享 id 里有 **36 个模块体字节不同**（`cNTJc`、`hEvvs`、`wvq7b`、`1nubv`、`9eGwG`、`8lWUo`、`dmk9i`、`U13Vh`、`7ELH8`、`l1F5h`、`770Tx`、`cqYZi`、`35oVN`、`b8cm`… 以及 options/sidepanel/tab 之间全部 19 个共享 id）。也就是说 WebappCS 实际跑的是 MainCS 的 `hEvvs`，tab-main 实际跑的是 sidepanel 的 60 个模块。

- **影响**：这是本层最严重的结构性问题。`bundles.load` 的卖点是"每个 bundle 都能被求值而不抛错"（文件头注释：`confirms that each bundle ... can be evaluated ... without throwing at load time`），但对 4 个 bundle 这个承诺是假的。任何发生在这些模块体内部的回归——初始化逻辑、`chrome.*` 调用、React 组件树构造——都不会被发现。叠加下面 [P1] 的 `harness gap` 规则，`overlay.check` 第 4 步还会把"bundle 坏了"报成 `ok all bundles load with the overlay in place`。
- **建议**：
  1. 每个 bundle 在独立的 `vm.createContext()`（或 `node:worker_threads`）里加载，不要共享 `globalThis`。这同时也让 `chrome-env` 的全局污染问题（见下）自然消失。
  2. 若暂时不改架构，至少在每次 `loadBundle` 前 `delete globalThis.parcelRequire4da4`，并断言加载后该 bundle 的每个 module id 都已被**本次**注册（可以通过包装 `register` 记录调用）。
  3. 加一条断言：`loaded` 数量必须等于 `BUNDLES.length`，且每个 bundle 都要报告"本次新增注册的模块数 > 0"。
- **置信度**：确定（两条独立路径复现：全模块 throw 扫描 + 单模块最小复现 + 单独加载对照）。

---

### [P1] `bundles.load.mjs` 的 "harness gap" 启发式把真实回归降级为不计失败的 skip

- **位置**：`tests/bundles.load.mjs:478-492`
- **现象**：

  ```js
  const envRelated =
    /is not defined|is not a function|Cannot read|document is not|window is not/i.test(msg) &&
    !/SyntaxError|ReferenceError: __/.test(msg);
  if (envRelated) { report(`skip ... harness gap`); skipped++; }
  else { report(`FAIL ...`); failures++; }
  ```

  这个正则匹配的错误信息里，`Cannot read` 和 `is not defined` 恰好是**最常见的一类真实 bug**（拼写错误、未定义变量、`null` 解引用）。更关键的是：`skipped` 不计入 `failures`，所以 `process.exit(failures ? 1 : 0)` 返回 0。

- **证据**：

  ```powershell
  # 在 bundle 顶部注入一个拼写错误的变量引用（典型真实回归）
  node -e "const fs=require('fs');const p='dist/WebappCS.8b5d7cd6.js';const c=fs.readFileSync(p,'utf8');fs.writeFileSync(p,c.replace('var e,r;','var e,r;nonExistentVariableTypo();'));"
  node tests/bundles.load.mjs
  # skip  内容脚本（Webapp） — harness gap: nonExistentVariableTypo is not defined
  # 8 loaded, 1 skipped (harness gap), 0 failed
  # EXIT=0
  ```

  同样地，注入 `null.x;`（报 `Cannot read properties of null`）与 `throw new Error("document is not defined")` 都走 skip 分支、退出码 0。

  更严重的是这条链：通过**文档推荐的工作流**（adopt 到 overlay）引入一个真实回归，两个测试都会放过：

  ```powershell
  New-Item -ItemType Directory -Path "src\overlay\WebappCS.8b5d7cd6" -Force
  Set-Content "src\overlay\WebappCS.8b5d7cd6\hEvvs.js" -Value "// regression`nundefinedThing.x;"
  node tools/build.mjs
  # build: 9/10 bundles byte-identical to baseline

  node tests/bundles.load.mjs
  # 8 loaded, 1 skipped (harness gap), 0 failed
  # EXIT=0

  node tests/overlay.check.mjs
  # ok    all bundles load with the overlay in place
  # overlay check passed
  # EXIT=0
  ```

- **影响**：`overlay.check` 第 4 步"overlay bundle still runs"是本项目**唯一**用来验证"改过的代码还能跑"的断言，它调用 `bundles.load.mjs` 并检查输出里是否含 `0 failed`。由于 skip 不计失败，一个完全跑不起来的 overlay 会被报成通过。这直接违背了 `overlay.check` 文件头声称的 `a build with that overlay still produces a runnable bundle`。
- **建议**：
  1. `skipped > 0` 就应当非零退出（或至少 `process.exitCode = 1`）。当前 9/9 全过、0 skip，说明 skip 分支在正常状态下从不触发，不需要为它保留"静默"。
  2. 把白名单从"错误信息正则"改成"显式的环境缺失清单"，例如先探测 `typeof window`/`typeof document`，缺失就跳过**并打印具体缺失项**，而不是根据异常文本猜。
  3. 另加一条 `overlay.check` 的断言：`loadLine.includes("0 skipped")`，而不只是 `0 failed`。
- **置信度**：确定。

---

### [P1] `background.smoke.mjs` 对消息处理器的断言只检查"有回复"，不检查回复内容，也不检查 `return true` 契约

- **位置**：`tests/background.smoke.mjs:143-158`；`tests/chrome-env.mjs:492-537`（`sendRuntimeMessage`）
- **现象**：两处断言过弱：

  1. `check(\`${probe.name} reply is structured\`, shaped, typeof reply)` 只判断 `typeof reply` 是 `object`/`string`/`number`。任何非空对象都算通过，包括 `{}`。
  2. `chrome-env` 的 `sendRuntimeMessage` 收集所有 listener 的返回值，只要有一个返回 `true` 就 `wantsAsync = true`，然后**无论返回什么**都会在 `sendResponse` 被调用时 resolve。Chrome 的真实语义是：listener 返回非 `true` 就关闭消息通道，异步 `sendResponse` 会被丢弃，发送方收到 `undefined`。

- **证据**：

  ```powershell
  # (a) 把两个被探测处理器的返回值换成垃圾
  # getCurrentWindowId: G.send({windowId:I.id})  ->  G.send({})
  # isSidePanelOpen:    G.send({success:!0,isSidePanelOpen:!!l?.windowId})  ->  G.send({bogus:1})
  node tests/background.smoke.mjs
  # ok    getCurrentWindowId returns a reply
  # ok    getCurrentWindowId reply is structured
  # ok    isSidePanelOpen returns a reply
  # ok    isSidePanelOpen reply is structured
  # smoke test passed
  # EXIT=0
  ```

  ```powershell
  # (b) 破坏 onMessage 路由的 return true
  # ...})}return!0}  ->  ...})}return!1}
  node tests/background.smoke.mjs
  # ok    getCurrentWindowId returns a reply
  # ok    getCurrentWindowId reply is structured
  # ok    isSidePanelOpen returns a reply
  # ok    isSidePanelOpen reply is structured
  # smoke test passed
  # EXIT=0
  ```

  在真实 Chrome 里 (b) 会让**全部 16 个 runtime 消息处理器**失效（通道被关闭，异步 `sendResponse` 被丢弃），但测试全绿。直接验证 shim 的语义：

  ```
  === sendRuntimeMessage: listener returns false ===
  resolved with: undefined (Chrome would deliver undefined to the sender)
  ```

  顺带确认 `isSidePanelOpen` 的探测只走到错误分支——测试传的 sender 是 `{ tab: { id: 1 }, id: ... }`，没有 `windowId`，所以处理器直接回 `{success:false,error:"sender has no windowId"}` 并返回：

  ```
  === isSidePanelOpen WITH windowId (the success path) ===
  reply: {"success":true,"isSidePanelOpen":false}
  === isSidePanelOpen WITHOUT windowId (what the smoke test sends) ===
  reply: {"success":false,"error":"sender has no windowId"}
  ```

  把成功分支改成 `G.send({success:!0,isSidePanelOpen:"TOTALLY-BROKEN"})`，测试仍然通过。

- **影响**：`background.smoke` 只能捕获"处理器整个消失"这一类回归（这一点确实有效，见下文"已确认能捕获"）。对于"处理器返回了错误数据"、"处理器返回了空对象"、"路由不再保持通道打开"这三类高频回归，它给出的是假阴性。考虑到这层测试的核心价值就是"字节一致之外的行为验证"，这个缺口很实质。
- **建议**：
  1. 对每个探测加具体字段断言：`reply.windowId === 1`、`reply.success === true && reply.isSidePanelOpen === false`。
  2. 给 `sendRuntimeMessage` 加一个 `strict` 模式：若所有 listener 都没有返回 `true`，直接 reject/断言失败，模拟 Chrome 的通道关闭。
  3. 探测时提供完整的 `sender`（含 `tab.windowId`），让成功路径真正被执行。
  4. 断言 `ping` 返回 `{message:"pong"}`——这是零依赖、零网络的理想探针，目前反而没被使用。
- **置信度**：确定。

---

### [P1] `chrome-env.mjs` 的 IndexedDB 模拟在版本语义上错误，可能掩盖升级逻辑回归

- **位置**：`tests/chrome-env.mjs:180-215`
- **现象**：`open(name, version)` 的实现是：

  ```js
  let db = databases.get(name);
  const isNew = !db;
  if (!db) { db = new FakeDatabase(name, version); databases.set(name, db); }
  req._succeed(db);
  queueMicrotask(() => {
    req.onupgradeneeded?.({ target: req, oldVersion: isNew ? 0 : version });
    req.onsuccess?.({ target: req });
  });
  ```

  三个问题：
  1. **先 `_succeed` 再 `onupgradeneeded`**：真实 IDB 的顺序是 `upgradeneeded` → （事务 complete）→ `success`。这里 `onsuccess` 在 `_succeed` 里已被排入 microtask 队列，`upgradeneeded` 又排一次，实际顺序是 `success` → `upgradeneeded` → `success`（见下方输出）。
  2. **`oldVersion` 传的是新版本号**：`isNew ? 0 : version`，其中 `version` 是本次请求的版本。真实语义是"升级前的版本"。
  3. **同版本 open 也会触发 `upgradeneeded`**：真实 IDB 只有在 `version > db.version` 时才触发。

- **证据**：

  ```js
  const req = idb.open("testdb", 2);
  req.onupgradeneeded = (e) => order.push(`upgradeneeded(oldVersion=${e.oldVersion})`);
  req.onsuccess = (e) => order.push(`success(...)`);
  // first open:        success(result=testdb) -> upgradeneeded(oldVersion=0) -> success(result=testdb)
  // upgrade 2->5:      success(version=2) -> upgradeneeded(oldVersion=5) -> success(version=2)
  // same-version open: success -> upgradeneeded -> success
  ```

  另外 `FakeDatabase.objectStoreNames.length` 的实现引用了构造期尚未赋值的 `this._stores`：

  ```js
  get length() { return this._stores?.size ?? 0; }
  ```

  实测 `createObjectStore` 两次后 `objectStoreNames.length` 仍是 `0`，而 `contains("one")` 返回 `true`。

- **影响**：项目里 `idb` 是已知依赖（`audit.mjs` 的 `LIB_SIGNATURES` 含 `idb`），背景用 IndexedDB 存字幕/转写这类大负载。如果将来有人改动 DB 升级逻辑（加 store、改索引、改 version），测试既不会按真实顺序触发，也看不到正确的 `oldVersion`，更不会因为"同版本重复升级"而失败。属于"测试能跑通但保真度不足"的典型。
- **建议**：
  1. 顺序改为 `queueMicrotask(() => { if (needsUpgrade) onupgradeneeded(...); else onsuccess(...) })`，且只在 `version > db.version` 时触发升级。
  2. `oldVersion` 用打开前的 `db.version`，并把 `db.version` 更新为请求的版本。
  3. 修 `objectStoreNames.length`（在构造器里先 `this._stores = new Set()`，或把 getter 绑定到闭包变量）。
  4. 给 `openCursor` 一个能真正遍历的实现——目前固定 `_succeed(null)`，任何依赖游标的代码都会静默走"空表"分支。
- **置信度**：确定（顺序/`oldVersion`/`length` 三项均已实测）。

---

### [P1] `chrome-env.mjs` 的 `StorageArea` 未做结构化克隆，返回值与存储共享引用

- **位置**：`tests/chrome-env.mjs:24-36`（`get`）、`tests/chrome-env.mjs:39-47`（`set`）
- **现象**：`set` 直接 `this.data.set(k, v)`，`get` 直接返回 `this.data.get(k)`。真实 `chrome.storage` 会经过结构化克隆（JSON 序列化往返），返回值与内部存储不共享引用，且不可序列化的值（函数、DOM 节点）会被拒绝或丢失。

- **证据**：

  ```
  === 2. structured clone isolation ===
  mutating the returned object changed the store: true

  === set() with a value that is not serializable ===
  set(fn) resolved; stored: function
  ```

- **影响**：如果被测代码依赖"读出来的是副本"这一语义（例如读配置 → 就地修改 → 不写回），测试会认为修改已持久化，真实浏览器里则不会。反向地，如果代码里误存了函数/DOM 对象，测试不报错，真实环境会静默丢弃。
- **建议**：`get` 返回 `structuredClone(value)`（Node 17+ 原生支持），`set` 前也 `structuredClone` 一次（对函数会抛 `DataCloneError`，正好模拟真实行为）。
- **置信度**：确定。

---

### [P1] `validator.check.mjs` 的 `accepts a clean build` 无法发现校验器"什么都不查"的退化

- **位置**：`tests/validator.check.mjs:85`（`scenario("accepts a clean build", () => {}, false)`）
- **现象**：这个正向场景只验证"干净树不报错"。它无法区分"校验器检查了全部 10 项且都通过"和"校验器一项都没检查"。整个 `validator.check` 的有效性完全依赖 9 个破坏场景，而这 9 个场景都是**针对 `check.mjs` 现有检查项的**——如果 `check.mjs` 新增一项检查（例如校验 `web_accessible_resources`），没有对应场景来证明它有效。
- **证据**：`check.mjs` 对一份**空 manifest** 返回通过：

  ```powershell
  $s="$env:TEMP\vc-da"; Copy-Item dist $s -Recurse
  Set-Content "$s\manifest.json" -Value '{}'
  $env:VCAPTIONS_DIST=$s; node tools/check.mjs
  # ok    options.html -> ...
  # ok    locale en parses
  # ok    locale zh_CN parses
  # check passed
  # EXIT=0
  ```

  删掉 `content_scripts`/`background`/`side_panel`/`options_ui`/`icons` 五个关键段，同样 `check passed`。原因很清楚：`check.mjs` 的 `referenced` 集合是**从 manifest 推导**的，manifest 为空则集合为空，`for (const rel of [...referenced])` 一次都不迭代。

  另外，`check.mjs` 不校验"manifest 必须声明某些段"，也不校验 `content_scripts` 的完整性——删掉 `YoutubeCS.6bf33c81.js`（它只通过 `scripting.registerContentScripts` 动态注册，不在 manifest 里）后 `check passed`、退出码 0。

- **影响**：这是"校验器有效性测试"自身的盲区。它证明了 9 条具体规则有效，但没有证明"校验器覆盖了产物应有的结构"。一个被误删成 `{}` 的 manifest 会一路通过 `check`、`package`（`package.mjs` 的 `need()` 对 `undefined` 直接 return）、直到 Chrome 加载时才炸。已知问题 #1 修的是"locale 缺失静默通过"，这是同一类问题的另一个面。
- **建议**：
  1. 增加正向断言：`check.mjs` 输出必须包含 `ok resource static/background/index.js`、`ok resource sidepanel.html`、`ok resource options.html` 等**具名**通过行，数量下限固定。这样"校验器不检查"就会失败。
  2. 增加场景：`manifest.json` 置为 `{}` 必须 FAIL；删除 `background`/`content_scripts` 段必须 FAIL。
  3. 在 `check.mjs` 里对 manifest 做 schema 最低要求校验（`manifest_version`、`name`、`version`、`background`、`content_scripts` 非空）。
  4. 增加场景覆盖 `scripting.registerContentScripts` 动态注册的 bundle（`YoutubeCS`）——它目前不在任何 manifest 引用里。
- **置信度**：确定。

---

### [P2] `package.check.mjs` 只对 zip 里一个条目做完整性抽查，且 `package.mjs` 写入的 CRC 从未被验证

- **位置**：`tests/package.check.mjs:172-186`（只抽 `sidepanel.65d86198.js`）、`tools/package.mjs:130-160`（`writeZip` 计算 CRC 并写入）
- **现象**：`check` 的"zip entry decompresses correctly"只比对**解压后的字节长度**是否等于磁盘文件大小。长度相同但内容被改坏的条目不会被发现。
- **证据**：在 `package.mjs` 里把 `sidepanel.65d86198.js` 的第 100/101 字节改成 `{`，保持长度不变，然后跑 `package.check`：

  ```
  ok    zip entry sidepanel.65d86198.js decompresses correctly
  package check passed
  EXIT=0
  ```

  用 Python 的 `zipfile.testzip()`（校验 CRC）检查该 zip 同样返回 `None`（无坏条目）——说明 `package.mjs` 写进 central directory 的 CRC 本身也基于被改坏的数据计算，所以 CRC 校验不会暴露问题；但这也意味着"CRC 正确"这条信息从未被任何测试断言过。
- **影响**：P2。zip 与 unpacked 目录的**文件名**集合是一致的（这条断言有效），但同名文件内容是否一致没有任何验证。如果 `writeZip` 的 deflate/offset 逻辑写错（例如把两个条目写串），只要长度恰好相同就会漏检。
- **建议**：
  1. 对每个 zip 条目都解压并与磁盘文件做 `Buffer.equals`（27 个条目、8 MB，成本可接受）。
  2. 或至少对每个条目校验 `extractEntry(...).length === statSync(...).size` 且抽样 3 个不同大小的文件做逐字节比较。
  3. 独立验证 CRC：用 `zlib.crc32`（Node 22+）重算解压后数据的 CRC，与 central directory 里的值比对。
- **置信度**：确定。

---

### [P2] `package.check.mjs` 会清空整个 `release/` 目录，包括与本次打包无关的产物

- **位置**：`tools/package.mjs:250`（`rmrf(RELEASE)`）、由 `tests/package.check.mjs:120` 间接触发
- **现象**：`package.mjs` 每次运行都 `rmrf(RELEASE)`，而 `package.check` 在一次运行里会调用它 4 次（默认、`--name-suffix`、`--suffix test.1`、再默认）。`release/` 下任何其他产物都会被删。
- **证据**：

  ```powershell
  Set-Content "release\MY-OTHER-BUILD.txt" -Value "important user artifact"
  node tests/package.check.mjs   # package check passed, EXIT=0
  Test-Path release\MY-OTHER-BUILD.txt   # False
  ```

  把 `rmrf(RELEASE)` 临时替换为打印语句，可见删除目标：

  ```
  WOULD-DELETE: MY-OTHER-BUILD, vcaptions-test-2.4.6, vcaptions-test-2.4.6.zip
  ```

- **影响**：P2（`release/` 是 gitignore 的构建产物，通常可重建；但若有人手工放了签名包、测试记录、对比基线，会被静默清掉）。与 [P0] 的 `src/overlay` 是同一类"测试越界写真实目录"的问题，只是数据价值低一档。
- **建议**：`package.mjs` 只删除自己要写的 `vcaptions-*` 前缀条目；`package.check` 用 `--out` 指向临时目录（当前 `package.mjs` 没有这个参数，需要新增）。
- **置信度**：确定。

---

### [P2] `background.smoke.mjs` 有两条恒真断言

- **位置**：`tests/background.smoke.mjs:163-167`、`tests/background.smoke.mjs:172-176`
- **现象**：

  ```js
  check(
    "unknown action does not hang or throw",
    true,
    unknownReply === Symbol.for("timeout") ? "no reply within 2s (acceptable)" : "replied",
  );
  ...
  check(
    "no unhandled crash after message traffic",
    true,
    `calls recorded: ${before} -> ${env.calls.length}`,
  );
  ```

  `condition` 直接写 `true`，第三个参数只是 detail 文本，不影响结果。这两条断言无论发生什么都通过。

- **证据**：两条在基线运行和全部破坏性实验中都是 `ok`。把路由改成 `default:return;`（未知 action 走提前返回）后仍然 `ok`。

- **影响**：P2。它们占用输出行数、制造"这里有覆盖"的错觉。`unknown action does not hang` 这个场景本身有价值，但当前实现没有检查任何东西（`unknownReply` 只用于生成 detail 字符串）。`no unhandled crash` 同理——要真正检测，应该挂 `process.on("unhandledRejection")` / `uncaughtException` 并断言计数为 0。
- **建议**：`unknown action` 改为断言 `unknownReply === undefined || typeof unknownReply === "object"`（未知 action 应无回复或结构化错误）；`no unhandled crash` 改为统计 `process.listenerCount` 或注册 `unhandledRejection` 钩子后断言为 0，否则删除该断言。
- **置信度**：确定。

---

### [P2] `consistency.check.mjs` 只比对两份预生成 JSON，不重新运行提取器

- **位置**：`tests/consistency.check.mjs:50-52`（`readJson`）、全篇
- **现象**：测试读取 `docs/architecture.generated.json` 和 `docs/symbol-index.json` 后直接互相比对，以及和 README/architecture.md 里的字符串比对。它**不会**重新运行 `tools/audit.mjs` 或 `tools/index-symbols.mjs`。所以它验证的是"上次生成的两份 JSON 彼此一致且文档引用了它们"，而不是"JSON 与当前 `dist/` 一致"。
- **证据**：

  ```powershell
  # 改坏 dist 里的一个处理器名，但不重新 audit
  # APP_HEARTBEAT:  ->  APP_HEARTBEAT_RENAMED:
  node tests/consistency.check.mjs
  # consistency check passed
  # EXIT=0

  # 重新 audit 后再跑
  node tools/audit.mjs          # all handlers (union):158
  node tests/consistency.check.mjs
  # FAIL  handler inventories agree — index-only=APP_HEARTBEAT audit-only=APP_HEARTBEAT_RENAMED
  # EXIT=1
  ```

  说明测试能捕获"两个提取器漂移"，但捕获不了"两份产物都过期"。`docs/architecture.generated.json` 里带 `generated_at` 时间戳，测试没有校验它是否比 `dist/` 新。

- **影响**：P2。这正是 `known-issues.md` 第 4 条"三处处理器计数不一致"那类问题的根因场景：如果有人改了 bundle 但忘了 `npm run audit`，文档会继续引用旧数字，而 `consistency.check` 全绿。`npm run ci` 的顺序是 `verify && build && check && test`，**不包含** `audit`/`index`，所以 CI 里这个测试实际上是拿仓库里提交的 JSON 自比。
- **建议**：
  1. 在测试开头比较 `arch.generated_at` 与 `dist/` 里最旧/最新文件的 mtime，过期则失败并提示 `npm run audit`。
  2. 或在 `consistency.check` 内部以子进程跑一次 `tools/audit.mjs` 到临时目录，再比对输出与提交的 JSON（audit 输出是确定性的——已实测两次运行除 `generated_at` 外完全一致）。
  3. 把 `npm run audit && npm run index` 加进 `ci` 脚本，或加 `--check` 模式。
- **置信度**：确定。

---

### [P2] `edit-safety.check.mjs` 的防护可被 `modules.json` 损坏/缺失绕过，且无信号处理器导致中断后残留

- **位置**：`tools/reconstruct.mjs:63-71`（`findHandEdits` 的 `try { JSON.parse } catch { continue; }`）、`tests/edit-safety.check.mjs` 无 `process.on("SIGINT")`
- **现象**：
  1. `findHandEdits()` 对 `index.json` 和每个 `modules.json` 都做了 `try { JSON.parse } catch { return/continue }`。解析失败就**静默跳过该 bundle 的所有编辑检测**。
  2. `edit-safety.check` 在测试过程中把 marker 写进 `src/bundles/.../epilogue.js`，靠 `finally` 还原。若进程被 Ctrl-C / SIGTERM / 崩溃杀掉，`finally` 不执行，marker 留在源码里。
- **证据**：

  ```powershell
  # 1) 损坏 modules.json，同时植入一个"珍贵编辑"
  Set-Content "src\bundles\WebappCS.8b5d7cd6\modules.json" -Value "{ broken json"
  # 在 epilogue.js 里写入 USER-PRECIOUS-EDIT
  node tools/reconstruct.mjs --verify
  # 10 bundles, 240 modules -> src\bundles
  # all bundles reassemble byte-for-byte
  # EXIT=0
  # did the edit survive? -> 没有，被覆盖了
  ```

  同样地，**删除** `modules.json` 后 `--verify` 仍然 `EXIT=0` 且 `edit survived: False`。

  ```powershell
  # 2) 中断残留：把 marker 写进 epilogue 后直接结束进程
  # src/bundles/WebappCS.8b5d7cd6/epilogue.js 里留下 "INTERRUPT-MARKER"
  # 之后任何 npm run verify 都会因"拒绝覆盖编辑"而失败
  ```

- **影响**：P2。`known-issues.md` 第 10 条声称已修复"静默抹掉 src/bundles 手改"，但修复依赖 `modules.json` 可解析——一个损坏的 `modules.json` 会让防护**完全失效且无任何提示**，正好回到修复前的行为。中断残留则是可用性问题：用户下次跑 `verify` 会看到一条指向他自己都不记得的编辑的报错。
- **建议**：
  1. `findHandEdits` 里 `JSON.parse` 失败应当 `fail hard`（"modules.json 损坏，请重新 split"），而不是 `continue`。
  2. `modules.json` 缺失也应当报错，而不是让该 bundle 逃过检查。
  3. `edit-safety.check` 注册 `process.on("SIGINT"/"SIGTERM")` 做同步还原；或用"写临时文件 + 原子 rename"而非就地覆盖 `epilogue.js`。
  4. 更彻底的做法：测试全程不碰 `src/bundles/`，在临时副本上跑 `reconstruct`/`build`（需要给工具加 `--root` 参数）。
- **置信度**：确定（两条路径均已复现）。

---

### [P2] `overlay.check` 的 `bundle reports as modified` 只断言"9/10"，不校验是哪一个 bundle

- **位置**：`tests/overlay.check.mjs:90-96`
- **现象**：`check("bundle reports as modified", withOverlay.identical.startsWith("9/10"))`。只要恰好有一个 bundle 变了就算通过，不管变的是不是被测的 `WebappCS.8b5d7cd6`。
- **证据**：测试开头会 `cleanup()` 删除所有 overlay，所以这条在实际运行中不会误报；但它也无法发现"adopt 写错了 bundle"或"build 把 overlay 应用到了错误的 bundle"这类错误。对比 `edit-safety.check` 做得好一些——它额外断言了 marker 出现在 `DIST_BUNDLE` 里（`tests/edit-safety.check.mjs:113`）。
- **影响**：P2。防护强度不对称：`edit-safety` 有内容级验证，`overlay` 只有计数级验证。
- **建议**：断言 `withOverlay.raw` 包含 `~ WebappCS.8b5d7cd6.js`（build 输出里有 `~` 前缀标记），或读 `build-report.json` 的 `modified_bundles` 精确比对。
- **置信度**：确定。

---

### [P3] `overlay.check` 用 `startsWith("10/10")` 与 `=== "1"` 混合，且 `overlays` 正则匹配脆弱

- **位置**：`tests/overlay.check.mjs:44`、`tests/overlay.check.mjs:73`、`tests/overlay.check.mjs:96`
- **现象**：`identical` 用 `startsWith`（前缀匹配），`overlays` 用严格相等。`build.mjs` 的输出格式是 `overlays in use: ${totalOverlaid} module(s)`，正则 `/(\d+)/` 取到的是数字字符串。若 `build.mjs` 将来改成 `overlays in use: 1 modules` 或加前缀，正则仍然工作；但若输出变成 `overlays in use: 0 (none)` 而实际有 1 个，`startsWith`/`===` 的组合不会交叉验证。
- **影响**：P3。风格与脆弱性，不是当前缺陷。
- **建议**：读 `build-report.json`（结构化）而不是解析 stdout 文本。
- **置信度**：确定（属代码阅读结论，非缺陷复现）。

---

### [P3] `bundles.load.mjs` 的 `0 failed` 断言存在子串误匹配

- **位置**：`tests/overlay.check.mjs:98`
- **现象**：`loadLine.includes("0 failed")`。`"9 loaded, 10 failed"` 也包含 `"0 failed"`（`1` + `0 failed`）。
- **证据**：

  ```
  node -e "console.log('9 loaded, 10 failed'.includes('0 failed'))"   # true
  node -e "console.log('10 failed'.includes('0 failed'))"             # true
  ```

- **影响**：P3。需要恰好 10/20/30… 个失败才误判，概率低但确实是逻辑漏洞。叠加 [P1] 的 skip 问题，这条断言本就不可靠。
- **建议**：解析 `/(\d+) failed/` 取数字并断言 `=== 0`，同时断言 `/(\d+) skipped/` 为 0。
- **置信度**：确定。

---

### [P3] `chrome-env.mjs` 的 `tabs.query` 忽略所有过滤条件，`tabs.get` 对未知 id 返回首个 tab

- **位置**：`tests/chrome-env.mjs:360-373`
- **现象**：`query: async (q) => { calls.push(...); return tabList; }` 完全不看 `q`。`get: async (id) => tabList.find(...) ?? tabList[0]`，未知 id 兜底返回第一个 tab。
- **证据**：

  ```
  query({url:'https://nothing-matches/*'}) -> [ 'https://a.example/1', 'https://b.example/2' ]
  query({active:true}) -> 2 tabs
  query({windowId:999}) -> 2 tabs
  tabs.get(12345) -> {"id":1,"url":"https://a.example/1",...}   (Chrome 会 reject)
  ```

  背景 bundle 里有 `tabs.query({url: optionsPageUrl})` 之类的调用（见 `epilogue.js` 的 `webappExtensionAuth` 处理器），依赖"只返回匹配的 tab"这一语义。
- **影响**：P3（当前没有被测代码依赖这个差异到会出错的程度，但属于保真度缺口）。
- **建议**：实现 `url`（glob 转 regex）、`active`、`windowId`、`currentWindow` 四个最常用过滤；`tabs.get` 未知 id 抛错。
- **置信度**：确定。

---

### [P3] `chrome-env.mjs` 的 `runtime.sendMessage` 不投递给 `onMessage`，`lastError` 永远 undefined

- **位置**：`tests/chrome-env.mjs:343-346`、`tests/chrome-env.mjs:330`
- **现象**：`sendMessage: async (msg) => { calls.push(...); return undefined; }` 只是记录，不路由到 `messageListeners`。`lastError: undefined` 是常量，`tabs.sendMessage` 向已关闭的 tab 发送也 resolve 成功。
- **证据**：

  ```
  === runtime.sendMessage never delivers to onMessage ===
  sendMessage reply: undefined | onMessage listener saw: null
  === runtime.lastError is never set ===
  tabs.sendMessage to a closed tab resolves: undefined
  ```

- **影响**：P3。任何"content script 发消息给背景、背景回消息"的端到端链路都无法在测试里走通；错误处理分支（`lastError` 存在时）永远不执行。
- **建议**：`runtime.sendMessage` 复用 `env.sendRuntimeMessage` 的实现；`tabs.sendMessage` 对不存在的 tabId 设置 `lastError` 并 reject。
- **置信度**：确定。

---

### [P3] `chrome-env.mjs` 声称"对未知访问抛错"，实际未实现

- **位置**：`tests/chrome-env.mjs:8-11`（文件头注释）
- **现象**：注释写 `throws on unknown access so a missing stub fails loudly instead of silently returning undefined`。实际 `chrome` 是普通对象，没有任何 `Proxy`；`chrome.foo.bar` 直接得到 `TypeError: Cannot read properties of undefined`（因为 `chrome.foo` 是 undefined），而不是一个可诊断的"缺少 stub"错误。更糟的是像 `chrome.storage.session` 这类**已定义但值为 undefined** 的成员会静默返回 undefined。
- **影响**：P3（注释与实现不符，会误导后续维护者）。实测中确实遇到过：给 `bundles.load` 注入 `null.x` 时报 `Cannot read properties of null`，被 `harness gap` 正则吃掉——两个问题叠加。
- **建议**：用 `Proxy` 包装 `chrome`，`get` 未命中时 `throw new Error(\`chrome-env: no stub for chrome.${path}\`)`；或修正注释。
- **置信度**：确定。

---

## 已确认能捕获的测试（破坏性实验）

以下每一项都是"故意破坏 → 测试失败"的实测结果。

| 测试 | 破坏方式 | 结果 |
| --- | --- | --- |
| `background.smoke` | 把 `case"getCurrentWindowId"` 改名 | **FAIL** `getCurrentWindowId returns a reply — timed out after 5s`，退出码 1 |
| `background.smoke` | `matches` 改 `example.com`、`world` 改 `ISOLATED` | **FAIL** `YouTube script targets youtube.com in MAIN world` |
| `background.smoke` | `openPanelOnActionClick` 改 `true` | **FAIL** `side panel does not open on action click` |
| `background.smoke` | `registerContentScripts` 改名（模拟 API 调用消失） | **FAIL** `bundle loads without throwing` |
| `bundles.load` | 在 bundle 末尾追加 `this is not javascript(((` | **FAIL** `1 failed`，退出码 1 |
| `bundles.load` | 删除文件 | **FAIL** `missing <file>` |
| `bundles.load` | MainCS / IFrameCS / YoutubeCS / Main / sidepanel 的模块体全部 throw | **FAIL**（这 5 个能捕获） |
| `validator.check` | 把 `check.mjs` 改成 `process.exit(0)` 立即返回 | **FAIL ×9**，全部 9 个场景报 `validator missed it` |
| `package.check` | 关闭 `--name-suffix` 分支 | **FAIL** `name becomes a literal string... — __MSG_appName__` |
| `package.check` | zip 生成后再往目录里加一个文件 | **FAIL** `zip contains exactly the unpacked files — disk=28 zip=27` |
| `package.check` | 删除 manifest 引用的图标 | **FAIL**（`package.mjs` 自己 exit 1，测试捕获） |
| `consistency.check` | README `158 个消息处理器` → `159` | **FAIL** `README quotes the handler total (158)` |
| `consistency.check` | README `后台 97` → `96` | **FAIL** `README quotes the background handler count (97)` |
| `consistency.check` | README `25 个端点`/`14 个存储键` 各 +1 | **FAIL ×2** |
| `consistency.check` | 篡改 `architecture.generated.json` 的 `all_handler_count`/`background_handler_count` | **FAIL ×3** |
| `consistency.check` | 改 dist 处理器名 + 重新 audit | **FAIL** `handler inventories agree — index-only=... audit-only=...` |
| `edit-safety.check` | 在 `src/bundles/.../epilogue.js` 写入 marker | **FAIL ×6**（verify 拒绝、拒绝信息含文件名与 adopt 提示、marker 存活、overlay 建立后 verify 通过、marker 进 dist、移除后恢复 10/10） |
| `overlay.check` | 删除 `dist/WebappCS` 等（间接由 build 捕获） | 见下"部分有效" |

## 已确认捕获不了的（破坏性实验）

| 测试 | 破坏方式 | 结果 | 对应发现 |
| --- | --- | --- | --- |
| `bundles.load` | WebappCS 唯一模块体 throw | `9 loaded, 0 skipped, 0 failed`，EXIT=0 | [P0] 模块遮蔽 |
| `bundles.load` | SubtitleBar 全部 16 个模块体 throw | 同上，EXIT=0 | [P0] 模块遮蔽 |
| `bundles.load` | options 全部 19 个模块体 throw | 同上，EXIT=0 | [P0] 模块遮蔽 |
| `bundles.load` | tab-main 全部 60 个模块体 throw | 同上，EXIT=0 | [P0] 模块遮蔽 |
| `bundles.load` | 注入 `nonExistentVariableTypo()` / `null.x` / `throw "document is not defined"` | `skip (harness gap)`，EXIT=0 | [P1] skip 降级 |
| `bundles.load` | MainCS 换成 `(function(){})();`（空壳） | `ok 内容脚本（主）`，EXIT=0 | 见"覆盖盲区" |
| `bundles.load` | 删掉 SubtitleBar 末尾的 `globalThis.define=` 赋值 | `9 loaded, 0 failed`，EXIT=0 | 尾部代码不敏感 |
| `background.smoke` | 两个探针的回复体换成 `{}` / `{bogus:1}` | `smoke test passed`，EXIT=0 | [P1] 断言过弱 |
| `background.smoke` | 路由 `return!0` → `return!1` | `smoke test passed`，EXIT=0 | [P1] `return true` 契约 |
| `background.smoke` | 路由加 `default:return;` | `smoke test passed`，EXIT=0 | [P1] 断言过弱 |
| `background.smoke` | `isSidePanelOpen` 成功分支返回 `"TOTALLY-BROKEN"` | `smoke test passed`，EXIT=0 | 只走错误分支 |
| `background.smoke` | `onMessageExternal` 改成抛异常 | `smoke test passed`，EXIT=0 | 未探测 |
| `validator.check` | `manifest.json` 置为 `{}` | `check passed`，EXIT=0 | [P1] 空 manifest |
| `validator.check` | 删 `content_scripts`/`background`/`side_panel`/`options_ui`/`icons` | `check passed`，EXIT=0 | [P1] 空 manifest |
| `validator.check` | 删 `YoutubeCS.6bf33c81.js`（动态注册） | `check passed`，EXIT=0 | 动态注册不在 manifest |
| `package.check` | 改坏 zip 内 `sidepanel` 内容但保持长度 | `zip entry ... decompresses correctly`，EXIT=0 | [P2] 只比长度 |
| `consistency.check` | 改 dist 处理器名但不重跑 audit | `consistency check passed`，EXIT=0 | [P2] 不重跑提取器 |
| `edit-safety.check` | 损坏/删除 `modules.json` 后植入编辑 | `--verify` EXIT=0，编辑被覆盖 | [P2] 防护可绕过 |

## 每个测试 × 能否捕获回归

| 测试 | 断言数 | 能捕获 | 捕获不了 | 净评价 |
| --- | --- | --- | --- | --- |
| `background.smoke` | 12（其中 2 条恒真） | 处理器被删除、content script 注册参数错、sidePanel 行为标志错、bundle 启动即抛错 | 返回值内容错、`return true` 契约破坏、未探测的 14/16 处理器、异步错误 | **部分有效**，仅覆盖"接线存在性" |
| `bundles.load` | 9 个 bundle 的加载结果 | 语法错误、文件缺失、5 个 bundle 的模块体运行时错误 | 4 个 bundle 的**全部**模块（96 个）、被 `harness gap` 正则命中的真实错误、空壳 bundle、尾部代码 | **结构性失效**，近半模块不可检测 |
| `overlay.check` | 11 | adopt 产物存在、格式化、`register` 保留、build 计数、edit 进 dist、移除后恢复 | 有 overlay 时 bundle 是否真能跑（被 skip 吞掉）、改的是哪个 bundle | **部分有效**，但会删用户数据 |
| `edit-safety.check` | 12 | 手改被拒绝且指名文件、adopt 后进 dist、移除后恢复 | `modules.json` 损坏/缺失时的防护、中断残留 | **有效**，但会删用户数据 |
| `validator.check` | 11 个 scenario | `check.mjs` 退化为 no-op、9 条具体规则失效 | 校验器"不检查任何东西"、manifest 为空/缺段、动态注册 bundle | **有效**，但只锁定现有规则 |
| `package.check` | 13 | `--name-suffix` 回归、zip/目录文件集合不一致、manifest 引用缺失、`__MSG_` 悬空 | zip 内单个文件内容损坏、CRC、`release/` 被清空 | **有效**，内容级验证偏弱 |
| `consistency.check` | 11 | 文档数字与实际 JSON 不符、两个提取器漂移、历史错误数字回归 | JSON 本身过期（未重跑 audit/index）、`src/readable` 与 `dist` 不一致 | **有效**，但验证的是"文档 vs 文档" |

## 模拟层保真度问题汇总

`tests/chrome-env.mjs` 与真实 Chrome 的差异，按影响排序：

1. **消息通道语义**：listener 返回非 `true` 时仍然接受异步 `sendResponse`（真实 Chrome 会关闭通道）。→ 掩盖了"忘记 `return true`"这一 MV3 最常见错误。
2. **单 realm 共享 `parcelRequire4da4`**：不是 Chrome API 差异，而是加载方式差异，但后果最重（见 [P0]）。
3. **IndexedDB 版本/事件顺序**：`success` 先于 `upgradeneeded`、`oldVersion` 用新版本号、同版本也升级、`objectStoreNames.length` 恒 0、`openCursor` 恒 null。
4. **`storage` 无结构化克隆**：读写共享引用，函数可存储。
5. **`storage.get` 的四种形式**：四种都支持（`undefined`/`string`/`array`/`object`），`null` 被当作 `undefined` 处理——这点与真实行为**一致**，已确认无问题。
6. **`tabs.query` 忽略过滤条件**、`tabs.get` 未知 id 兜底返回首个 tab、`tabs.sendMessage` 永不失败。
7. **`runtime.sendMessage` 不路由到 `onMessage`**，`lastError` 永远 undefined。
8. **`scripting.registerContentScripts`**：只记录参数，不校验 `id` 唯一性、不模拟重复注册报错、`getRegisteredContentScripts` 返回可变数组（测试拿到的是同一个引用，可被下游修改）。
9. **`i18n.getMessage`**：`subs` 替换用 `$1`/`$2` 直接 `String.replace`，真实 Chrome 支持 `$$`、`$1` 转义规则；缺 key 时返回 key 本身（与 Chrome 返回空字符串不同）。当前测试里 `messages` 来自真实 locale 文件，风险低。
10. **`browser` 指向 `chrome`**：让 polyfill 走"原生路径"，这是合理的，但意味着 polyfill 自身的包装逻辑（callback ↔ promise 转换）完全不被测。

## 覆盖盲区（按严重程度）

1. **96 个模块体（WebappCS/SubtitleBar/options/tab-main）从未被执行**（[P0]）。这 4 个 bundle 占 9 个 bundle 里的 4 个，且包含整个设置页、标签页和侧边栏 UI。
2. **DOM 渲染完全未验证**：`bundles.load` 的 DOM shim 里 `document.addEventListener` 是空函数，而 sidepanel/options/tab 的入口是 `document.addEventListener("DOMContentLoaded", () => { ... createRoot(...).render(...) })`。实测三个 UI bundle 加载后 `root.childNodes.length === 0`、`root.innerHTML === ""`、捕获的 console 输出 0 行。也就是说"React 能否挂载"这件事没有被测到，测试只证明了"bundle 顶层脚本不抛错"。
3. **16 个 runtime 处理器里只探测了 2 个**（`getCurrentWindowId`、`isSidePanelOpen`），且后者只走错误分支。`authMessages`、`getStorageData`、`setStorageData`、`trackAnalyticsEvent`、`openSidePanel`、`webappExtensionAuth` 等 14 个从未被调用。
4. **事件驱动路径全部未测**：`onInstalled`、`onStartup`、`onSuspend`、`tabs.onUpdated`、`tabs.onActivated`、`tabs.onRemoved`、`alarms.onAlarm`、`action.onClicked`、`commands.onCommand`、`contextMenus.onClicked` 在测试里从未 `emit`（`Event.emit` 实现了但全项目只有 `storage.onChanged` 用到，且是 shim 内部调用）。
5. **`src/` 与 `dist/` 的一致性无测试**：改 `src/bundles/` 后不 rebuild，所有测试仍然通过（实测：编辑 `MainCS/hEvvs.js` 后 `bundles.load` 9/9、`background.smoke` passed）。只有 `edit-safety.check` 会跑 `reconstruct --verify`，而它只覆盖 `WebappCS` 一个 bundle。
6. **`release/` 产物与 `dist/` 的一致性**：`package.check` 会重新打包，但没有断言"release 里的 manifest 除 name/version 外与 dist 完全一致"。

## 清理可靠性

| 测试 | 正常结束 | 断言失败 | 中途崩溃 | 被信号中断 |
| --- | --- | --- | --- | --- |
| `overlay.check` | 干净（`src/overlay` 删除、dist 重建 10/10） | `finally` 有效 | `finally` 有效（实测注入 `process.exit(7)` 后无残留） | **残留**（无 SIGINT 处理器） |
| `edit-safety.check` | 干净 | `finally` 有效（实测：植入编辑后 6 个 FAIL，`src/bundles` 与 `src/overlay` 均还原） | `finally` 有效 | **残留**（marker 留在 `src/bundles`，下次 `verify` 报错） |
| `validator.check` | 干净（临时目录 `fs.rmSync`） | `finally` 有效 | `finally` 有效 | 临时目录残留在 `os.tmpdir()`（`vcaptions-check-*`），不影响工程 |
| `package.check` | 干净（但清空 `release/`） | 可能残留中间包 | — | `release/` 被清空 |
| `background.smoke` | `process.exit()` 显式退出 | 同 | 同 | 无残留 |
| `bundles.load` | `process.exit()` 显式退出 | 同 | 同 | 无残留 |
| `consistency.check` | 只读 | 只读 | 只读 | 无残留 |

补充：`overlay.check` 的 `finally` 里 `try { buildSummary(); } catch {}` 会**吞掉**构建失败，所以即使还原后构建失败，测试也只报之前累积的 failures；如果之前没失败，这里会静默返回非 10/10 的状态而不报告。

## 未覆盖的范围

- **真实 Chrome 加载验证**：`tools/browser-verify.mjs` 不在本次 L2 范围（属 L4）。本报告所有"真实 Chrome 行为"的论断基于 Chrome 扩展 API 文档语义（`onMessage` 的 `return true` 契约、`storage` 的结构化克隆、IDB 升级事件顺序），未在真实浏览器里逐条对照。
- **`tests/` 之外的测试基础设施**：无。项目没有测试框架（无 `vitest`/`jest`），7 个脚本是手写 `check()` 断言，`package.json` 的 `test` 用 `&&` 串联。
- **性能/超时行为**：`background.smoke` 的 `settle(400)` 与 5s 超时在慢机器上是否稳定未做压力测试；`bundles.load` 对 DOM bundle 等 500ms 是否足够渲染也未验证（实测渲染 0 节点，无法判断是 shim 不足还是时间不够）。
- **并发**：7 个测试都被设计成串行（`npm test` 用 `&&`），未测试并行运行时的相互干扰（`overlay`/`edit-safety` 都会改写 `src/`，并行必然冲突）。

## 附：破坏性实验后的还原确认

所有实验结束后已核对：

- `dist/` 9 个 bundle + `manifest.json` 的 SHA-256 与实验前完全一致（`tools/build.mjs` 报 `10/10 bundles byte-identical to baseline`）。
- `src/bundles/` 240 个模块的 body 摘要与 `modules.json` 记录的 `sha256` 全部匹配（`modules checked: 240 mismatched: 0`）。
- `src/overlay/` 不存在（测试前也不存在）。
- `release/` 仅含 `vcaptions-test-2.4.6` 与 `.zip`。
- `docs/architecture.generated.json` 重新 audit 后除 `generated_at` 外与实验前逐字节一致。
- `tools/check.mjs`、`tools/build.mjs`、`tools/package.mjs`、`README.md`、`tests/bundles.load.mjs` 均已还原（与备份逐字节比对通过）。
