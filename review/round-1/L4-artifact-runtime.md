# L4 产物可运行性 审查报告

审查者：L4 subagent（产物可运行性）
审查范围：`dist/`、`release/`、`tools/check.mjs`、`tools/package.mjs`、`tools/browser-verify.mjs`、`dist/manifest.json` 及其引用的 HTML/CSS/JS 资源
审查时间：2026-10-23T11:54:28+08:00

## 结论摘要

产物**能真实运行**：`npm run release` 在 Chrome 156.0.8078.49 上通过了全部 11 项检查，扩展被接受、service worker 启动、React UI 真实渲染。但**验证脚本本身不可信**：`browser-verify.mjs` 只打开 `options.html` 一个页面，把 `sidepanel.html`（用户实际看到的主界面）和 `tabs/tab-main.html` 完全排除在观测之外，两者被破坏时脚本仍报 `browser verification passed`（P0）。同一盲区还覆盖了全部 5 个 content script 的注入行为、`--suffix` 越界产生的 Chrome 拒收版本号，以及权限名的拼写错误——后者会让 `chrome.storage` 整体消失而脚本依然全绿。

## 发现

### [P0] `browser-verify.mjs` 只探测 `options.html`，`sidepanel.html` 与 `tabs/tab-main.html` 完全未验证

- **位置**：`tools/browser-verify.mjs:283-287`（`const probePage = "options.html";`）
- **现象**：脚本注释声称 "sidepanel.html is the most representative"，然后选择了 `options.html`，理由是 "Chrome refuses to open side-panel pages as normal tabs in some versions"。实测该理由不成立：本次 Chrome 156 能正常以标签页打开 `sidepanel.html` 与 `tabs/tab-main.html`，两者都真实渲染出 React 内容（`rootChildren=1`）。
- **证据**：

  1. 把 `dist/sidepanel.html` 的 script src 改成不存在的文件：

     ```powershell
     $s1 = Join-Path $env:TEMP "l4-scratch\sidepanel-broken"
     Copy-Item -Recurse dist $s1
     (Get-Content "$s1\sidepanel.html" -Raw) -replace 'sidepanel\.65d86198\.js','sidepanel-DOES-NOT-EXIST.js' | Set-Content "$s1\sidepanel.html" -NoNewline
     node tools/browser-verify.mjs $s1
     ```

     输出：

     ```
     ok    Chrome accepts the unpacked extension
     ok    service worker is running
     ...
     ok    extension page opens
     ok    React root exists in the page
     ok    UI actually rendered
     ok    page has content
     ok    page rendered without uncaught exceptions

     browser verification passed
     EXIT=0
     ```

  2. 同样的破坏放在 `tabs/tab-main.html` 上，结果一致：`browser verification passed`，`EXIT=0`。

  3. 对照组：同样的破坏放在 `options.html` 上，脚本正确失败：

     ```
     FAIL  UI actually rendered — children=0
     FAIL  page has content — bodyLength=82
     2 problem(s) found
     EXIT=1
     ```

  4. 直接把这些页当标签页打开时，破坏是肉眼可见的（用 CDP 自己的探针测）：

     ```
     sidepanel.html: {"url":"...sidepanel.html","title":"__MSG_appName__","hasRoot":true,"rootChildren":0,"bodyLength":94,"bodyText":""}
     tabs/tab-main.html: {"url":"...tab-main.html","hasRoot":true,"rootChildren":0,"bodyLength":88,"bodyText":""}
     ```

     健康状态下这两个页分别是 `rootChildren=1`、`bodyLength=1220`（sidepanel，文本"获取页面信息中..."）和 `bodyLength=964`（tab-main，文本"绑定标签页中..."）——**说明"打开就能区分好坏"**，缺的只是脚本愿不愿意去打开。

  5. 进一步：把 `sidepanel.65d86198.js` 首行改成 `throw new Error('sidepanel bootstrap exploded');`（语法合法，所以 `check.mjs` 安然通过），`browser-verify.mjs` 仍然 `pass`。`tabs/tab-main.1e0435ca.js` 同理。

- **影响**：P0。`sidepanel.html` 是这个扩展的主要用户界面（manifest `side_panel.default_path`），`tabs/tab-main.html` 是工具栏按钮打开的页面（`background` 里 `runtime.getURL("tabs/tab-main.html?bindTabId=")`）。这两个入口的整条启动链——HTML 里的 script src、bundle 的顶层初始化、CSP 合规、React 挂载——都**没有任何自动化覆盖**。一个把 sidepanel 打成白屏的重构错误，`npm run release` 会一路绿灯通过并产出 `release/` 产物。这正好是本项目"重建"场景下最可能发生的错误类型（10 个 bundle 中 sidepanel 与 tab-main 各 60 模块、各 4.5 MB，是改动最密集的地方）。

- **建议**：
  1. 把 `probePage` 换成"遍历 `manifest` 里所有 HTML 入口"：`options_ui.page`、`options_page`、`side_panel.default_path`、以及 `getURL()` 调用点出现的 `tabs/tab-main.html`。每个页面都跑一遍现有的四条断言（`hasRoot` / `rootChildren>0` / `bodyLength>100` / 无未捕获异常）。
  2. 删掉"Chrome refuses to open side-panel pages"这条注释——它在 Chrome 156 上是错的，而且正是不做检查的理由。如果确实存在某些版本无法打开，应当"打不开就 FAIL"，而不是"换一个页面替代"。
  3. 对每个 content script 也应有覆盖（见下一条）。

- **置信度**：确定（4 组破坏实验 + 1 组健康对照，均在真实 Chrome 156 上完成）

---

### [P0] 5 个 content script 的注入行为完全没有被验证，全部破坏后仍 `pass`

- **位置**：`tools/browser-verify.mjs:287`（只开扩展页，从不开网页）；`tools/check.mjs:186-192`（只做 `new vm.Script` 语法解析）
- **现象**：`manifest.json` 声明了 5 个 content script（`MainCS`、`IFrameCS`、`WebappCS`、`Main`、`SubtitleBar`），其中最核心的 `MainCS.277dcde3.js` 匹配 `<all_urls>`——它是扩展"在任意网页上注入字幕列表 UI"的入口。`browser-verify.mjs` 从不打开任何 `http://` 或 `https://` 页面，因此注入是否成功、是否抛错、是否真的往页面里放了 UI，全都无从观测。
- **证据**：

  1. 在 `MainCS.277dcde3.js` 首行插入 `throw new Error('L4 content script deliberately broken');`（仍可解析，`check.mjs` 报 `all 10 JavaScript files parse` 并 `check passed`）：

     ```powershell
     $s4 = Join-Path $env:TEMP "l4-scratch\cs-broken"
     Copy-Item -Recurse dist $s4
     $orig = Get-Content "$s4\MainCS.277dcde3.js" -Raw
     Set-Content "$s4\MainCS.277dcde3.js" -Value ("throw new Error('L4 content script deliberately broken');" + $orig) -NoNewline
     node tools/browser-verify.mjs $s4
     ```

     输出：11 项全 `ok`，`browser verification passed`，`EXIT=0`。

  2. 用 CDP 在真实页面上对比健康/破坏两版，证明注入**确实发生且错误可捕获**：

     ```
     === healthy dist ===
     page: {"url":"http://127.0.0.1:8731/page.html",...}
     execution contexts (2):
       origin=chrome-extension://<id> name="vCaptions - 网站视频字幕列表" isDefault=false type=isolated
       origin=http://127.0.0.1:8731 name="" isDefault=true type=default
     exceptions (0):
     isolated world -> {"runtimeId":"<id>","hasStorage":true,"hasPlasmo":false}

     === broken content script ===
     exceptions (1):
       Uncaught: Error: L4 content script deliberately broken
         at chrome-extension://<id>/MainCS.277dcde3.js:1:7
     ```

     即：content script 在独立的 isolated world 里运行，`Runtime.exceptionThrown` 能抓到它的错误——**技术上完全可测，只是脚本没测**。

  3. 另一处相关盲区：`chrome.scripting.registerContentScripts` 动态注册的 `YoutubeCS.6bf33c81.js`（`world: "MAIN"`, `matches: https://*.youtube.com/*`）在 `background` 里是这样调的：

     ```js
     chrome.scripting.registerContentScripts([{ id: "contentsYoutubeCs", js: [...], matches: ["https://*.youtube.com/*"], world: "MAIN", allFrames: !0 }]).catch(I=>{})
     ```

     `.catch(()=>{})` 吞掉一切错误。实测在 Chrome 156 下注册成功（`chrome.scripting.getRegisteredContentScripts()` 返回 1 条，`js:["YoutubeCS.6bf33c81.js"]`），但这属于"这次碰巧成功"——脚本没有任何断言守着它。

- **影响**：P0。content script 是这个扩展的核心功能面（5 个脚本、34 个处理器、`<all_urls>` 注入）。当前状态是：10 个 bundle 里 4 个（`MainCS`、`IFrameCS`、`WebappCS`、`Main`）+ `YoutubeCS` 的**运行期**行为没有任何自动化验证。`check.mjs` 的语法解析只能证明"代码能编译"，不能证明"代码能跑"。

- **建议**：
  1. 在 `browser-verify.mjs` 里起一个本地 `http://127.0.0.1:<port>/` 页面，导航过去，然后：
     - 断言出现了 isolated world（`Runtime.executionContextCreated` 里 `auxData.type === "isolated"` 且 `origin` 是扩展 ID）；
     - 断言该 world 里 `chrome.runtime.id` 等于 `extId`；
     - 断言 `Runtime.exceptionThrown` 为空；
     - 断言页面 DOM 出现了预期标记（当前 `<div id="__plasmo">` 在网页里并不出现，需要先确认注入的可见特征，或至少断言"content script 之后页面没有崩溃"）。
  2. 在 worker 里调用 `chrome.scripting.getRegisteredContentScripts()` 并断言 `contentsYoutubeCs` 存在——这能补上 `.catch(()=>{})` 吞掉的那条路径。

- **置信度**：确定（破坏实验 + isolated world 直接观测，均在真实 Chrome 156 上）

---

### [P1] `package.mjs --suffix` 允许产出 Chrome 拒收的版本号，且仍打印 "package verified"

- **位置**：`tools/package.mjs:208-215`（`const clean = opts.suffix.replace(/[^0-9.]/g, "")` 后直接拼接，无段数/取值校验）；`tools/package.mjs:279-281`（成功横幅）
- **现象**：Chrome 要求 `version` 是 1-4 段、每段 0-65536 的整数。`--suffix` 把用户输入拼到 `2.4.6` 后面，段数直接相加；`--suffix 5.5.5` 产出 6 段 `2.4.6.5.5.5`，`--suffix 1.2` 产出 5 段 `2.4.6.1.2`，`--suffix 1.2.3.4` 产出 7 段。所有这些情况下 `package.mjs` 都 `exit 0` 并打印两行 `package verified: ...`。
- **证据**：

  ```powershell
  node tools/package.mjs --suffix 5.5.5
  ```

  ```
  packaged extension
    version:   2.4.6.5.5.5
    name:      __MSG_appName__
    files:     27
    unpacked:  18.24 MB  release\vcaptions-test-2.4.6.5.5.5
    zip:       7.65 MB  release\vcaptions-test-2.4.6.5.5.5.zip

  package verified: every manifest reference resolves
  package verified: every __MSG_ key resolves in the default locale
  EXIT=0
  ```

  交给 Chrome 立刻被拒：

  ```powershell
  node tools/browser-verify.mjs release\vcaptions-test-2.4.6.5.5.5
  ```

  ```
  FAIL  Chrome accepts the unpacked extension — {"id":1,"error":{"code":-32600,
    "message":"Required value 'version' is missing or invalid. It must be between
    1-4 dot-separated integers each between 0 and 65536."}}
  FAIL  verification ran to completion — loadUnpacked did not return an extension id
  EXIT=1
  ```

  `check.mjs` 指向同一目录时能正确报错（`FAIL version "2.4.6.5.5.5" is not 1-4 dot-separated integers`），说明**规则已经写在 `check.mjs:159` 里**，只是 `package.mjs` 产出的 manifest 从未过这道检查。

  段数越界矩阵（每行都是 `package.mjs` exit 0 + 两行 verified）：

  | `--suffix` | 产出 version | 段数 | Chrome |
  | --- | --- | --- | --- |
  | `test.1` | `2.4.6.1` | 4 | 接受 |
  | `1.2` | `2.4.6.1.2` | 5 | **拒收** |
  | `5.5.5` | `2.4.6.5.5.5` | 6 | **拒收** |
  | `1.2.3.4` | `2.4.6.1.2.3.4` | 7 | **拒收** |
  | `65536` / `65537` / `70000` | `2.4.6.65536` 等 | 4 | 接受（Chrome 实际接受 >65536，其错误文案与实现不一致） |

- **影响**：P1。`docs/testing-in-browser.md:78` 与 `package.json` 的 `package:test` 用的是 `test.1`（安全），所以默认路径不会踩到。但 `--suffix` 是公开参数，任何想打"`--suffix 0.1.2`"标记的人都会得到一个 Chrome 拒收的包，而工具会明确告诉他 "package verified"。这是**验证器给出反向保证**，比不给保证更糟。更关键的是它暴露了 `package.mjs` 的验证范围问题：它只校验"manifest 引用的文件存在"和"`__MSG_` 键能解析"，不校验 manifest 的语法契约。

- **建议**：
  1. 拼接后立即用 `check.mjs:159` 的同一条正则校验，不匹配就 `exit 2` 并说明段数来源（"base version has 3 segments, suffix may add at most 1"）。
  2. 更好的做法：把 `check.mjs` 的 manifest 契约检查抽成一个可复用函数，让 `package.mjs` 在写 manifest 之后、写 zip 之前调用它。
  3. 顺带：`--suffix` 缺值（`--suffix` 作为最后一个参数）会静默退化成 `2.4.6`（`argv[++i]` 取到 `undefined`），也应报错。

- **置信度**：确定（三组越界实测 Chrome 拒收 + 三组边界值实测）

---

### [P1] 权限名拼写错误无法被任何环节发现，`chrome.storage` 整体消失而验证全绿

- **位置**：`tools/check.mjs:140-192`（manifest 校验段，无 permission 白名单）；`tools/browser-verify.mjs`（全脚本无 permission 相关断言）
- **现象**：把 `manifest.permissions` 里的 `storage` 改成 `stoarge`，Chrome 接受该扩展（未知权限名被忽略，不报错），`check.mjs` 报 `check passed`，`browser-verify.mjs` 报 11 项全 `ok`。而运行时 `chrome.storage` 变成 `undefined`。
- **证据**：

  ```powershell
  $s = Join-Path $env:TEMP "l4-perm3"; Copy-Item -Recurse dist $s
  node -e "const fs=require('fs');const p=process.argv[1]+'/manifest.json';const m=JSON.parse(fs.readFileSync(p,'utf8'));m.permissions=m.permissions.map(x=>x==='storage'?'stoarge':x);fs.writeFileSync(p,JSON.stringify(m,null,2))" "$s"
  node tools/browser-verify.mjs $s
  ```

  ```
  ok    Chrome accepts the unpacked extension
  ok    service worker is running
  ... （共 11 项 ok）
  browser verification passed
  EXIT=0
  ```

  但在 worker 里直接探测：

  | 版本 | `chrome.storage` | `chrome.storage.local` | `local.set()` |
  | --- | --- | --- | --- |
  | 健康 `dist` | `true` | `true` | `ok`，`get` 返回 `{"l4probe":1}` |
  | `stoarge` 拼写 | `false` | `false` | `THREW: TypeError: Cannot read properties of undefined (reading 'local')` |

  同理，凭空添加 `totallyBogusPermission` 也 `check passed` + `browser verification passed`。

- **影响**：P1。这类错误会让扩展彻底失去配置持久化（16 个存储键全部失效），但 UI 依然渲染、worker 依然启动、日志里可能只有下游的 `TypeError`。对一个以"重建正确性"为目标的工程，权限声明是 manifest 契约里唯一还没被验证的部分，而它恰好是"拼错不报错"的那种。

- **建议**：
  1. `check.mjs` 加一张已知权限白名单（Chrome 的 `permissions` 是封闭枚举）。白名单之外的条目直接 FAIL。这比"校验存在"更有效，因为它同时抓出拼写错误和已废弃权限。
  2. `browser-verify.mjs` 里加一条断言：worker 内 `typeof chrome.storage.local.get === "function"`，以及 `chrome.sidePanel`、`chrome.scripting` 的存在性——直接把"声明的权限真的到了运行时"这件事测掉。

- **置信度**：确定（两组权限变异实测 + worker 内直接探测）

---

### [P1] `browser-verify.mjs` 使用固定端口 9340，会连上别人的浏览器并在错误的位置验证

- **位置**：`tools/browser-verify.mjs:19`（`const PORT = 9340;`）、`tools/browser-verify.mjs:150`（`waitForJson` 只轮询该端口，不校验响应者是不是自己 spawn 的进程）
- **现象**：脚本 spawn 一个 Chrome 后，直接 `fetch("http://127.0.0.1:9340/json/version")` 并连上返回的 `webSocketDebuggerUrl`。如果这个端口已被另一个 Chrome 占用（前一次崩溃的残留、用户自己的调试实例、并发的另一个验证任务），脚本会连到**那个**浏览器，把扩展装进它的 profile，并在那里跑完所有断言。
- **证据**：

  1. 先手工起一个 Chrome 占住 9340，再跑验证器：

     ```powershell
     $fp = Start-Process chrome -ArgumentList @("--user-data-dir=$env:TEMP\l4-foreign-profile","--remote-debugging-port=9340","about:blank") -PassThru
     node tools/browser-verify.mjs
     ```

     结果 `browser verification passed`，同时：

     ```
     外来的 Chrome 进程仍存活: 11 procs
     验证器自己创建的 profile 里 Default/Extensions = []   ← 空的
     ```

     扩展实际装进了外来 profile（`Default/Extensions` 出现了新的 32 位 ID 目录），验证器自己 `mkdtempSync` 出来的 profile 全程没被用过。

  2. 这个"装错地方"本身还不算致命，真正的风险是**验证对象错位**：外来浏览器里可能已经装着**旧版本**的同一路径扩展。构造该场景（先往残留浏览器里装好版本，再改坏磁盘上的 `options.html`，然后跑验证器）时，脚本报 `FAIL UI actually rendered — children=0`——说明这次它确实读了磁盘上的新文件。但脚本没有任何机制**保证**这一点：`Extensions.loadUnpacked` 对同一路径会返回既有 ID 并复用内存中的旧副本，而脚本的断言全部跑在那个可能陈旧的副本上。

  3. 并发场景：同时跑两个验证（一个好产物、一个坏产物），两者都连到同一个浏览器，各自 `loadUnpacked` 不同路径，最终 2 个结果都正确——但这是因为两次扩展 ID 不同。若两次验证的是**同一路径的不同内容**，后者会拿到前者的旧副本。

- **影响**：P1。这是"验证结论可能描述的不是你刚构建的产物"这一类问题。它在 CI 上（干净的容器、单任务）不会触发，但在开发者本机上——尤其是上一次验证崩溃留下进程时（见下一条）——正是最可能发生的组合。

- **建议**：
  1. 改为 `--remote-debugging-port=0`（Chrome 自动分配），从 `DevToolsActivePort` 文件读实际端口，再连接。这样既避免碰撞，也保证连的是自己 spawn 的进程。
  2. 若坚持固定端口，至少在 spawn 前探测该端口：已被占用则 `exit 2` 并提示"另一个浏览器占用了 9340"，绝不"连上去继续"。
  3. 用 `child.pid` 与 `/json/version` 的响应做一次绑定校验（比较 `webSocketDebuggerUrl` 的端口是否为 Chrome 写进 `DevToolsActivePort` 的那个）。

- **置信度**：确定（外来浏览器劫持 + profile 归属实测；"验证旧副本"部分为较高，因为依赖 `loadUnpacked` 的既有行为）

---

### [P1] 进程被强杀时 `os.tmpdir()` 里的 Chrome profile 会永久残留（每次约 15 MB）

- **位置**：`tools/browser-verify.mjs:339-343`（`finally` 里 `fs.rmSync(profile, ...)`，只在正常/异常退出路径执行）
- **现象**：`finally` 对 `throw` 和正常返回有效（实测 `killChromeTree` 能带走整个 Chrome 进程树，`chrome=0` 在 1 秒内达成），但对 `SIGKILL` / 任务管理器结束进程 / `Stop-Process -Force` 无效。此时 Chrome 子进程会被系统连带清理，但 `mkdtempSync` 创建的 profile 目录无人删除。
- **证据**：

  ```powershell
  # 用独立进程启动（不用 Start-Job，避免 PowerShell 作业对象代为清理）
  $p = Start-Process -FilePath node -ArgumentList @("tools/browser-verify.mjs","dist") -PassThru
  # 等 profile 出现后只杀 node 进程
  Stop-Process -Id $p.Id -Force
  ```

  ```
  chrome procs (profile-bound): 11
    +1 s -> chrome=0        ← Chrome 进程树被系统带走，无残留进程
    +2 s -> chrome=0
    +4 s -> chrome=0
    +8 s -> chrome=0

  leftover profile dirs: 1
     vcaptions-verify-giqCY1: 367 files, 14.5 MB
  ```

  重复多次后 `vcaptions-verify-*` 会持续累积。正常退出路径是干净的（连跑两次 `node tools/browser-verify.mjs` 后 `profiles=0`），所以这不是"每次都漏"，而是"崩一次漏一个"。

- **影响**：P1（`known-issues.md` 第 3 条已修的是"Chrome 进程树泄漏"，这里是同一防御的另一半：**目录**泄漏）。每次约 15 MB，且目录里含该扩展的完整 IndexedDB / localStorage 副本。结合上一条（端口固定），残留的 profile 会通过"上一次没关干净的 Chrome"直接污染下一次验证。

- **建议**：
  1. 在脚本启动时先扫 `os.tmpdir()` 下 `vcaptions-verify-*`，对每个目录尝试删除；能删说明无进程占用，删不掉就明确报告"Skipping verification: profile X is locked by a running Chrome"。
  2. profile 前缀里带上 `process.pid`，启动时清理所有 `pid` 已不存在的目录（这是崩溃后再也无人收尸的唯一可靠判据）。
  3. 或者干脆把 profile 放进项目内的 `release/.verify-profile/`，让 `.gitignore` 与 `npm run clean` 统一管理，避免污染用户临时目录。

- **置信度**：确定（独立进程实测，`chrome` 归零但目录残留 14.5 MB）

---

### [P1] `package.mjs` 在校验之前就写出 `release/` 产物，失败时留下"看起来可用"的包

- **位置**：`tools/package.mjs:242`（`writeZip`）早于 `tools/package.mjs:255-277`（`missing` 检查与 `exit 1`）
- **现象**：`package.mjs` 的顺序是：拷树 → 写 manifest → 写 zip → 打印 "packaged extension / files / zip / sha256" → **然后**才校验 manifest 引用是否缺失。校验失败时 `exit 1`，但目录和 zip 已经躺在 `release/` 里了。
- **证据**：

  ```powershell
  Remove-Item release -Recurse -Force
  Move-Item dist\sidepanel.html $env:TEMP\sidepanel.html.bak
  node tools/package.mjs
  ```

  ```
  packaged extension
    version:   2.4.6
    files:     26
    zip:       7.65 MB  release\vcaptions-test-2.4.6.zip
  package is INCOMPLETE — missing: sidepanel.html
  EXIT=1
  ```

  失败后：

  ```
  release/
    vcaptions-test-2.4.6/        ← 26 个文件的残缺包，仍然存在
    vcaptions-test-2.4.6.zip     ← 同样残缺，仍然存在
  ```

- **影响**：P1。`exit 1` 能阻止 `npm run release` 链条继续（`check` 在前，正常情况下不会走到这里），但**不能阻止人手滑**：`release/vcaptions-test-2.4.6/` 是文档里明确要求"导入这个目录"的路径（`docs/testing-in-browser.md:18`）。一次失败的打包会在那里留下一个缺页面的包，读者按文档操作会加载到残缺产物。另外 zip 的 sha256 已经打印出来了，容易被误当成"通过校验的产物"记录下来。

- **建议**：
  1. 把 manifest 引用检查、`__MSG_` 解析检查移到 `copyTree` 之后、`writeZip` 之前。
  2. 失败时 `rmrf(pkgDir)` + 删除 zip，或先写到 `release/.tmp-<pid>/` 再 `rename`。
  3. 把 "packaged extension / files / zip / sha256" 这几行摘要移到**所有**校验通过之后，避免"先报成功再报失败"。

- **置信度**：确定

---

### [P1] `browser-verify.mjs` 的异常过滤器会吞掉真实的致命错误

- **位置**：`tools/browser-verify.mjs:325-327`

  ```js
  const pageErrors = page.exceptions.filter(
    (e) => !/network|fetch|ERR_|Failed to fetch|api\.vcaptions/i.test(e),
  );
  ```

- **现象**：过滤意图是"忽略网络噪声"，实现却是对**整段错误文本**做子串匹配。任何消息里含 `fetch` / `network` / `ERR_` 的真实应用异常都会被当成噪声丢弃——包括 `Failed to fetch` 以外的、开发者自己写进 `Error` 消息的词。worker 侧同样（`browser-verify.mjs:272-276`）。
- **证据**：

  1. 延迟到渲染完成后抛出的致命错误，消息含 `Failed to fetch`：

     ```js
     // 追加到 options.6406b895.js 首行
     setTimeout(() => { throw new Error('Renderer crashed: Failed to fetch state'); }, 500);
     ```

     ```
     ok    UI actually rendered
     ok    page has content
     ok    page rendered without uncaught exceptions
     browser verification passed
     EXIT=0
     ```

  2. 同样的抛出位置，消息不含过滤词：

     ```js
     setTimeout(() => { throw new Error('Renderer crashed later on'); }, 500);
     ```

     ```
     FAIL  page rendered without uncaught exceptions — Error: Renderer crashed later on
     1 problem(s) found
     EXIT=1
     ```

     两者唯一的差别是错误消息里的措辞，一个通过一个失败。

  3. 顺带确认这不是"时机"问题：把 `throw` 放在页面最早期（`<body>` 后第一个 `<script src="/early.js">`）也能被抓到（`FAIL ... EARLY-ERROR-BEFORE-RUNTIME-ENABLE`），说明 `Runtime.enable` 在导航后调用仍然捕获到了早于它的异常。所以问题纯粹在过滤规则。

- **影响**：P1。这是"验证器给出反向保证"的第二种形态。真实的 fetch 失败在扩展里通常表现为 `console.error` 或已被业务代码 catch，而不是 `uncaught exception`；真正会走到 `Runtime.exceptionThrown` 的多半是**没被处理的致命 bug**——恰恰是最该报出来的。当前规则让"错误消息里出现 fetch 字样"变成一个隐藏通道。

- **建议**：
  1. 只按 `exceptionDetails.exception.className === "TypeError"` 且消息精确匹配已知网络错误（如 `Failed to fetch`）时忽略，并**记录为 warning** 打印出来，而不是静默丢弃。
  2. 更好的做法：把网络请求在验证环境里禁掉（例如让 `api.vcaptions.com` 走本地黑洞），这样"网络错误"根本不会产生，过滤器可以整体删除。
  3. 无论如何都应该打印被过滤掉的条数与原文，让复核者能判断过滤是否合理。

- **置信度**：确定（对照实验，唯一变量是错误消息措辞）

---

### [P2] `dist/` 的陈旧文件会静默通过 build + check + package，只在最末端被 Chrome 偶然挡住

- **位置**：`tools/build.mjs`（非 `--clean` 时不清理 `dist/`）；`tools/check.mjs`（只校验 manifest 与 HTML 引用的资源存在，不校验"dist 里有未声明的文件"）；`tools/package.mjs:53,64`（`EXCLUDE` 只排除 3 个固定文件名）
- **现象**：`build.mjs` 不清理 `dist/`，`package.mjs` 把 `dist/` 里的一切（除 3 个黑名单名）打进 `release/`。因此任何遗留在 `dist/` 的文件都会进入发布包，而 `build` 报 `10/10`、`check` 报 `passed`、`package` 报 `package verified`。
- **证据**：

  1. 放入 `dist/old-notes.txt`（一个扩展不需要的文件）：

     ```
     build: 10/10 bundles byte-identical to baseline
     check passed
     files:     28               ← 变成 28，多出来的就是 old-notes.txt
     package verified: every manifest reference resolves
     browser verification passed    ← 依然通过
     包内存在 old-notes.txt: True
     ```

  2. 放入 `dist/__stale-from-old-build.js`（下划线开头）：

     ```
     build: 10/10 ... / check passed / files: 29 / zip 已生成
     browser verification passed? → FAIL
       Chrome: Cannot load extension with file or directory name __stale-from-old-build.js.
               Filenames starting with "_" are reserved for use by the system.
     ```

     也就是说，**只有"下划线开头的文件名"这一种偶然情况会被 Chrome 挡住**，普通陈旧文件会一路进包。

- **影响**：P2。当前 `dist/` 是干净的（`npm run build:clean` 后无残留），而且 `dist/` 在 `.gitignore` 里，所以这不是活跃缺陷。但它意味着"发布包里有什么"缺少一条不变量：没有任何环节断言 `dist/` 的文件集合等于"构建应产出的集合"。一旦有人手工往 `dist/` 放了调试脚本（很常见的做法），或某次构建改名后旧文件留下，`npm run release` 会带着它一起发布。

- **建议**：
  1. `build.mjs` 默认行为改为清理（或至少把"清理产出的文件清单"与"实际 dist 文件清单"做差集，非空即报警）。
  2. 或者 `package.mjs` 加一条断言：`dist/` 的文件集合必须等于 `build-report.json` 里记录的 `bundles` + `STATIC_FILES`，不匹配就 `exit 1`。

- **置信度**：确定

---

### [P2] `sidepanel.html` / `tabs/tab-main.html` 的 `<title>` 是未替换的 i18n 占位符

- **位置**：`dist/sidepanel.html:1`、`dist/tabs/tab-main.html:1`（均为 `<title>__MSG_appName__</title>`）
- **现象**：Chrome 的 i18n 替换只作用于 `manifest.json` 和 CSS 的 `__MSG_*__`，**不作用于 HTML**。因此这两个页面在 React 覆盖 `document.title` 之前，浏览器标签页标题显示的是字面量 `__MSG_appName__`。
- **证据**：

  ```powershell
  node tools/browser-verify.mjs  # 正常通过
  # 用 CDP 打开各页面并读取 document.title：
  ```

  ```
  options.html:          title = "vCaptions - 网站视频字幕列表"   ← React 已覆盖
  sidepanel.html:        title = "__MSG_appName__"               ← 未被覆盖（停在 loading 态）
  tabs/tab-main.html:    title = "vCaptions - 网站视频字幕列表"   ← React 已覆盖
  ```

  `sidepanel.html` 在作为独立标签页打开、且停在"获取页面信息中..."时，标题就是原始占位符。基线文件的字节与 `assets/baseline/extension-v2.4.6/sidepanel.html` 完全一致（`identical: true`），所以这是**基线继承的问题**，不是重建引入的。

  另一个相关现象：正常通过验证的那次运行里，`sidepanel.html` 产生了 3 条未捕获异常：

  ```
  Error: disconnected  at sidepanel.65d86198.js:85:20097
  console.error: [APP:Hook:Message] Failed to send message: Could not establish connection.
  ```

  这是 sidepanel 作为独立标签页打开（而非真正的侧边栏）时的正常退化行为（它试图向某个不存在的接收端发消息），不是缺陷——但它说明**如果把 sidepanel 加进验证，必须先把"独立标签页模式下的预期异常"白名单化**，否则会得到假阳性。

- **影响**：P3（视觉/文案层面）。`sidepanel` 作为真正的侧边栏打开时，React 会覆盖标题，用户看不到占位符；只有当它以标签页形式打开并卡在加载态时才可见。不过，如果把它加进 `browser-verify.mjs` 的探测列表（P0 那条的建议），这个 `document.title` 就会变成一个稳定可断言的信号。

- **建议**：
  1. 接受现状（与商店版一致），在 `known-issues.md` 记为已知限制。
  2. 或在 React 挂载前的 HTML 里写死标题，代价是偏离基线字节。

- **置信度**：确定（`Get-FileHash` 与基线一致 + CDP 读取 `document.title`）

---

### [P2] `web_accessible_resources` 的 `*.css` 通配符规则让 `check.mjs` 失去校验能力

- **位置**：`tools/check.mjs:181-190`（`if (pattern.includes("*")) continue;`）；`dist/manifest.json`（`web_accessible_resources[0].resources = ["*.css"]`）
- **现象**：`check.mjs` 对含 `*` 的模式直接跳过。当前 manifest 的 WAR 只有一条 `["*.css"]`，因此**该检查目前一项都没在检查**——输出里确实没有 `web_accessible_resource ...` 这类 ok 行。
- **证据**：

  ```powershell
  # 把 patterns 改成明显无意义的 "*.cssx"
  node tools/check.mjs   → check passed
  node tools/browser-verify.mjs → browser verification passed
  ```

  而实际运行时，`*.css` 这个通配符的确生效（在普通网页里用 `fetch` 探测扩展资源）：

  ```
  style.css                    {"status":200,"bytes":993}
  subtitleBar.css              {"status":200,"bytes":282}
  daisyui.css                  {"status":200,"bytes":1761}
  options.css                  {"status":200,"bytes":60}
  options.d68fb9df.css         {"status":200,"bytes":40}
  tabs/tab-main.64262913.css   {"status":200,"bytes":187490}
  sidepanel.html               {"error":"TypeError: Failed to fetch"}   ← 正确拒绝
  icon16.plasmo.00ac8b83.png   {"error":"TypeError: Failed to fetch"}   ← 正确拒绝
  manifest.json                {"error":"TypeError: Failed to fetch"}   ← 正确拒绝
  ```

  即：**当前 WAR 配置是对的**，但没有任何自动化在验证它，也没有在验证"通配符没有过宽"。

- **影响**：P2。功能上没问题（实测 6 个 CSS 全部可被网页读取，HTML/PNG/manifest 正确地不可读）。风险在"将来"：如果重构时把 `*.css` 扩成 `["*"]`，或者删掉 WAR 导致 CSS 404，`check` 与 `browser-verify` 都不会有任何反应。而扩展里 CSS 是通过 `insertCSS` / `link` 注入到网页的，WAR 失效的表现是"样式全丢"，很显眼但很难定位。

- **建议**：
  1. 在 `browser-verify.mjs` 里加一次 WAR 探活：在普通网页上下文中 `fetch` 几个关键 CSS，断言 200；同时 `fetch` 一个非 WAR 文件（如 `manifest.json`），断言抛错。这是唯一能真实验证 WAR 的方式，成本很低。
  2. `check.mjs` 对通配符至少做形态校验（如 `*.css` 必须能匹配到 dist 中至少一个文件）。

- **置信度**：确定

---

### [P2] `release/` 每次打包都被整体删除，历史产物（含基线对照包）无提示消失

- **位置**：`tools/package.mjs:228`（`rmrf(RELEASE)`）
- **现象**：`package.mjs` 无条件删除整个 `release/`。这意味着上一轮留下的 `vcaptions-test-2.4.6.65536`（本工程实验前 `release/` 里唯一的内容）在跑一次 `node tools/package.mjs` 后就消失了，只剩新名字的目录。
- **证据**：

  ```powershell
  node tools/package.mjs        # 生成 vcaptions-test-2.4.6
  node tools/package.mjs --suffix test.1
  # release/ 内容：
  #   vcaptions-test-2.4.6.1
  #   vcaptions-test-2.4.6.1.zip
  # 原来的 vcaptions-test-2.4.6 已不存在：Test-Path → False
  ```

- **影响**：P2（`release/` 是 gitignore 的构建产物，可重建；但若有人放了签名包、对比样本、测试记录，会被静默清掉）。此问题 L2 报告第 372 行已记录为"`package.check` 会清空 release"，**本条补充的是 `package.mjs` 自身的行为**——只要跑一次打包就会丢，不需要跑测试。属于已知问题的延伸。

- **建议**：只删除本次要写的同名目录与 zip，其余保留；或提供 `--clean` 开关。

- **置信度**：确定

---

### [P2] `browser-verify.mjs` 默认路径写死 `vcaptions-test-2.4.6`，与 `package:test` 的产物名不一致

- **位置**：`tools/browser-verify.mjs:165`（`path.join(ROOT, "release", "vcaptions-test-2.4.6")`）
- **现象**：`npm run package:test`（`--suffix test.1`）只产出 `release/vcaptions-test-2.4.6.1`。此时不带参数跑 `npm run verify:browser` 会 `exit 2` 并报 `no manifest.json at release\vcaptions-test-2.4.6`。
- **证据**：

  ```powershell
  node tools/package.mjs --suffix test.1     # 产出 vcaptions-test-2.4.6.1
  node tools/browser-verify.mjs
  ```

  ```
  no manifest.json at D:\DEV\3_Projects\LP\vCaptions\release\vcaptions-test-2.4.6
  EXIT=2
  ```

  这是 `docs/testing-in-browser.md:78` 教用户的流程（"打包一个带版本后缀的变体"→"随时可以自己复验 `npm run verify:browser`"）的直接后果：照文档做，复验命令会失败。

- **影响**：P2。不会产出错误结论（是明确的 `exit 2`），但会让文档里那条"随时可以自己复验"失效，读者需要自己发现要带参数。`npm run release` 走的是不带 `--suffix` 的路径，所以主链路不受影响。

- **建议**：默认路径改为"`release/` 下唯一（或最新）的 `vcaptions-test-*` 目录"，多个时列出来要求显式指定。

- **置信度**：确定

---

### [P3] zip 不可复现：同样输入每次产出不同 sha256

- **位置**：`tools/package.mjs:76-168`（自定义 ZIP 写入器）
- **现象**：连续三次 `node tools/package.mjs`（`dist/` 未变），zip 的 sha256 三次不同。
- **证据**：

  ```
  zip sha256: 4225e2f52377aa3d...
  zip sha256: 8131654847945343...
  zip sha256: 36014013c660cc4a...
  ```

  原因是 ZIP 头里的 DOS 时间戳取自文件 `mtime`，而 `copyTree` 用 `fs.copyFileSync` 会刷新 mtime。

  同时确认 zip 的内容是正确的：用 `Expand-Archive` 解开后，27 个文件与 `release/vcaptions-test-2.4.6/` **逐字节一致**（`zip roundtrip mismatches: 0`）。

- **影响**：P3。功能无损，但 `package.mjs` 打印了 `zip sha256` 并暗示它具有身份含义——实际上它对同样的代码每次都不一样，无法用于"这份 zip 是不是同一个构建"的判断。

- **建议**：要么固定时间戳（用 `dist/` 里文件的 mtime 或一个常量），要么在输出里注明"sha256 因时间戳而每次不同，不是构建指纹"。

- **置信度**：确定

---

## 已确认无问题的部分

以下每一项都在真实 Chrome 156.0.8078.49 上实测过。

1. **产物能真实加载并运行。** `npm run release` 全流程 `exit 0`：

   ```
   build: 10/10 bundles byte-identical to baseline
   check passed
   guard / smoke / bundles.load (9 loaded, 0 failed) / overlay / edit-safety /
   validator / package / consistency check 全部 passed
   packaged extension: 2.4.6 / 27 files
   ok    Chrome accepts the unpacked extension
   ok    service worker is running
   ok    extension runtime is live in the worker
   ok    worker reports the packaged version
   ok    onMessage API is available to the worker
   ok    worker started without uncaught exceptions
   ok    extension page opens / React root exists / UI actually rendered /
         page has content / page rendered without uncaught exceptions
   browser verification passed
   ```

2. **三个 HTML 入口单独打开都能正常渲染。** `options.html`（`rootChildren=1`，`bodyLength=179911`，中文设置界面完整）、`sidepanel.html`（`bodyLength=1220`，"获取页面信息中..."）、`tabs/tab-main.html`（`bodyLength=964`，"绑定标签页中..."）。**"Chrome 拒绝把 sidepanel 当标签页打开"是不成立的**——这直接推翻了脚本里那句注释的前提。

3. **MV3 CSP 未被违反。** 用独立探针扩展（页面脚本 + service worker 脚本，而非 CDP `Runtime.evaluate`，因为后者绕过 CSP）实测：

   ```
   页面脚本: {"eval":"BLOCKED: EvalError","newFunction":"BLOCKED: EvalError","functionCtor":"BLOCKED: EvalError"}
   worker:   {"eval":"BLOCKED: EvalError","newFunction":"BLOCKED: EvalError"}
   ```

   而 `dist/` 里 7 个 bundle 中的 `Function("return this")()` 全部位于 `typeof globalThis === "object" ? globalThis : ... || Function("return this")()` 这类 **短路兜底** 里：前面的 `typeof self === "object"` 在浏览器/worker 中都为真，`Function` 分支永不执行。所以"产物里有 `Function` 构造器"不违反 CSP。**数量统计**：`eval` 0 处，`new Function` 0 处，`Function("...")` 兜底 10 处（7 个文件）。

4. **content script 确实注入到了网页里。** 打开 `http://127.0.0.1:<port>/page.html` 后出现了两个 execution context：一个是页面默认 world，另一个是 `origin = chrome-extension://<id>`、`name = "vCaptions - 网站视频字幕列表"` 的 isolated world，其中 `chrome.runtime.id` 与 `chrome.storage` 均可用。`MainCS`（`<all_urls>`）与 `IFrameCS`（`all_frames`）的注入是有效的。

5. **`chrome.scripting.registerContentScripts` 动态注册成功。** worker 内 `chrome.scripting.getRegisteredContentScripts()` 返回：

   ```json
   [{"id":"contentsYoutubeCs","js":["YoutubeCS.6bf33c81.js"],
     "matches":["https://*.youtube.com/*"],"world":"MAIN","allFrames":true}]
   ```

   即 `YoutubeCS.6bf33c81.js` 虽然不在 `manifest.content_scripts` 里，但通过动态注册被正确挂载——`check.mjs` 把它当作普通脚本解析也是对的（它确实会被加载）。

6. **manifest 的 MV3 契约在真实 Chrome 下成立。** `manifest_version: 3`、`version: 2.4.6`、5 条 `content_scripts` 的 `<all_urls>` / `https://*.vcaptions.com/*` 模式、`side_panel.default_path`、`options_ui.page`、`background.service_worker`、`web_accessible_resources` 全部被 Chrome 接受。用 6 个变异版本做了反向验证，`check.mjs` 与 Chrome 的判定一致性如下：

   | 变异 | `check.mjs` | Chrome | 一致 |
   | --- | --- | --- | --- |
   | `side_panel.default_path` 指向不存在文件 | FAIL | 拒收（"Side panel file path must exist."） | ✓ |
   | `content_scripts.matches` 改成 `not-a-pattern://*` | FAIL | 拒收（"Invalid scheme."） | ✓ |
   | `manifest_version: 2` | FAIL | 拒收（WAR 结构不符） | ✓ |
   | WAR 指向不存在文件（无通配符） | FAIL | — | ✓ |
   | 权限名拼写 `stoarge` | **pass** | 接受（但 storage 失效） | ✗（见 P1） |
   | 凭空添加 `thisKeyDoesNotExist` | **pass** | 接受（Chrome 忽略未知键） | 可接受 |

7. **worker 启动失败会被发现。** 在 `static/background/index.js` 首行插入 `throw`：`check passed`（语法合法），但 `browser-verify` 报 `FAIL service worker is running — no SW target after 20s`，`exit 1`。说明 SW 这一环的检测是真实有效的。

8. **`web_accessible_resources` 的实际行为正确。** 从普通网页 `fetch` 扩展资源：6 个 `.css` 全部 200（`style.css` 993B、`subtitleBar.css` 282B、`daisyui.css` 1761B、`options.css` 60B、`options.d68fb9df.css` 40B、`tabs/tab-main.64262913.css` 187490B）；`sidepanel.html`、`icon16.*.png`、`manifest.json` 全部 `TypeError: Failed to fetch`（正确不可读）。

9. **`package.mjs` 的 `--name-suffix` 正确。** `--name-suffix --suffix test.1` 产出 `name = "vCaptions - Video Caption List (test)"`（真实解析后的字符串，无 `__MSG_` 残留），`default_locale` 保留，剩余 `__MSG_` 键（`appDescription`、两个 `command*`）仍能解析。`known-issues.md` 第 2 条的修复是彻底的。

10. **`--suffix beta`（无数字）会明确报错** `--suffix must contain digits, got "beta"`，`exit 2`。这一点是对的。

11. **zip 内容正确。** 27 个文件全部与目录版逐字节一致，`Expand-Archive` 无报错，大文件（`sidepanel.65d86198.js` 4.5 MB）解压后大小正确。

12. **正常退出路径的清理是彻底的。** 连跑两次 `node tools/browser-verify.mjs`：`chrome procs = 0`、`vcaptions-verify-*` 目录数 `= 0`。`killChromeTree` 的 `taskkill /T /F` 修复（`known-issues.md` 第 3 条）确实有效——强杀 node 后 Chrome 进程树也在 1 秒内归零。

13. **`build.mjs` 的语法检查有效。** 破坏 bundle 使其无法解析时 `build` 会 `exit 1`（对应 `SUMMARY-round-2.md` 中"`build.mjs` 对语法无效产物 exit 0"的修复）。`check.mjs` 也确实解析了全部 10 个 JS（`ok all 10 JavaScript files parse`）。

14. **`release/` 目录树可完整还原。** 所有破坏性实验后，`release/vcaptions-test-2.4.6.65536/` 的 27 个文件哈希与实验前快照**逐个一致**。

## 未覆盖的范围

1. **真实网页上的功能行为**。本次只验证了"content script 注入了、没抛错"，没有验证字幕列表 UI 是否在 YouTube / Bilibili 上真的渲染出来、字幕能否抓取。这需要联网访问真实视频站点，且依赖 `api.vcaptions.com` 的服务可用性——超出"产物可运行性"的静态范围，属于功能验收。

2. **`Options` / `sidepanel` / `tab-main` 的交互路径**。没有点击任何按钮、切换任何设置、触发任何 AI/翻译请求。只验证到"React 挂载 + 首屏渲染"。

3. **CRX 打包与商店安装**。只测了"Load unpacked"（`Extensions.loadUnpacked`），没有生成 `.crx`、没有验证签名、没有验证 `update_url` 指向的更新流程。`_metadata/verified_contents.json` 有意不打包（`known-issues.md` 已记录），未做额外验证。

4. **非 Chrome 浏览器**。只在 Chrome 156.0.8078.49 上测。`docs/testing-in-browser.md` 声称也支持 Edge，未验证。

5. **macOS / Linux**。`killChromeTree` 的 POSIX 分支（`process.kill(-pid)`）未实测；`browser-verify.mjs` 的 Chrome 路径候选里 `/usr/bin/google-chrome` 等未验证。

6. **`check.mjs` 对 CSS 的校验**。`check.mjs` 只校验 HTML 引用的 `<link href>` 文件存在，不解析 CSS 内容、不校验 `url()` 引用的资源。`options.d68fb9df.css`（40 字节，与 `options.css` 内容重复）属于 `known-issues.md` 的"待观察"，未深究。

7. **`release/` 之外的 `dist/` 与基线逐字节比对**。`build.mjs` 已对 10 个 bundle 做 SHA-256 比对（`10/10 byte-identical`），16 个静态文件由 `findOmittedBaselineFiles` 覆盖存在性，但本次没有独立复核每个静态文件的字节一致性（只在 `sidepanel.html` 上做过一次 `Get-FileHash` 对比）。

8. **`--suffix` 的完整取值空间**。测了 `test.1`、`1.2`、`5.5.5`、`1.2.3.4`、`65536`、`65537`、`70000`、`beta`、缺值、空串、`..`、`.5`、`a1b2`。Chrome 文档写"each between 0 and 65536"，但实测 70000 被接受——这个上限的真实语义未进一步确认（存疑，不影响 P1 结论：段数是硬性拒绝）。

9. **`npm run verify:browser` 在 CI 环境（无 GUI、无 Chrome）下的行为**。`exit 3` 分支（`Chrome not found — skipping real-browser verification`）未实测，因此不清楚它会阻断 CI 还是静默跳过整个发布门禁。
