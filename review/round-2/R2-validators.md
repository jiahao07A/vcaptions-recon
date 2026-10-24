# R2 校验器与自检测试 审查报告

审查者：R2-validators subagent
审查范围：`tools/check.mjs`、`tests/consistency.check.mjs`、`tests/validator.check.mjs`（含与 `tools/audit.mjs`、`tools/index-symbols.mjs`、`docs/*`、`README.md` 的接口处）
审查时间：2026-10-23T16:48:00+08:00

## 结论摘要

**这三个文件里，"独立验证"只完成了一半，而且完成的那一半没有测试锁住。** `check.mjs` 新增的 8 项检查本身逻辑基本正确（对真实破坏能报错），但 `tests/validator.check.mjs` 的 10 个场景只锁住了其中 4 项——把 `manifest_version`、`version` 格式、权限白名单、API/权限交叉检查、matches 校验、WAR 展开、locale 存在性、locale 可解析 **逐个改成 `if (false)`，`validator.check` 依然 `validator check passed`（EXIT=0）**。`consistency.check` 的 storage-key 断言确实回到了产物（不再是循环论证），但它只做了**单向**验证（报告的键必须能被找到），漏掉的键和新增的键都检测不到；文档数字断言仍是 `String.includes` 子串匹配，`116 个存储键` 能通过 `16 个存储键` 的断言。

最严重的单项：**`check.mjs` 删除 `daisyui.css` / `style.css` / `subtitleBar.css` 三个运行时样式表仍然 `check passed`**，因为 `*.css` 通配符只要有任意一个 css 存在就算"resolve"。

## 发现

### [P1] `validator.check` 的 10 个场景只锁住 4 项检查，其余 8 项可被逐个改成恒假而全绿

- **位置**：`tests/validator.check.mjs:82-125`；被漏检的检查位于 `tools/check.mjs:153`（manifest_version）、`159`（version 格式）、`187-202`（权限白名单）、`219-247`（API→权限）、`250-260`（matches）、`268-306`（WAR 展开）、`90-101`（locale 存在）、`102-116`（locale 可解析）
- **现象**：声称「破坏 10 种情况验证 check.mjs 有效」。实测：把 `check.mjs` 里**任意一项**新增检查的条件改成恒假，只要不改动被 4 个既有场景覆盖的那几条（parse sweep、HTML 引用、`__MSG_` 键、manifest 引用存在性），`validator.check` 仍然 10/10 通过并 exit 0。也就是说，本轮声称新增的 manifest_version / version 格式 / 权限白名单 / API 交叉检查 / matches / WAR 展开 / locale 存在性 / locale 可解析 **8 项全部没有对应的破坏性场景**。
- **证据**：在临时副本里逐项中和 `check.mjs` 的规则，再跑真实的 `validator.check`。判定行取 `ok`/`FAIL` + 4/2 空格开头的场景行。

  ```
  control: exit=0, scenarios=10, failed=0

  DETECTED   N1 10-file parse sweep (vm.Script)
               FAIL  catches syntax error in bundle — validator missed it
  DETECTED   N2 HTML src/href existence
               FAIL  catches missing stylesheet referenced by HTML — validator missed it
  UNDETECTED N3 manifest_version === 3
  UNDETECTED N4 version format
  UNDETECTED N5 permission whitelist
  UNDETECTED N6 API -> permission cross check
  UNDETECTED N7 content_scripts matches
  UNDETECTED N8 web_accessible_resources expansion
  UNDETECTED N9 locale file presence (fatal)
  UNDETECTED N10 all locales parse
  DETECTED   N11 manifest __MSG_ keys defined
  DETECTED   N12 manifest-referenced resources exist

  undetected checks: 8/12
  ```

  复现方式（PowerShell，逐项）：把 `dist/`、`tools/check.mjs`、`tests/validator.check.mjs` 拷到临时目录，把目标规则的条件替换成 `if (false)`（或把 `new vm.Script(...)` 换成空语句），运行 `node tests/validator.check.mjs`，观察退出码仍为 0。

  最尖锐的一例是 N9。中性化「default locale 文件必须存在」后，`catches missing default locale` 仍然报 `ok`——因为默认 locale 被删除后，下面的 `JSON.parse` 读不到文件抛 ENOENT，被"locale 可解析"那条捕获了：

  ```
  scenario verdict: ok    catches missing default locale
  the failure it actually observed: FAIL  _locales/en/messages.json is not valid JSON: ENOENT: ...
  → the scenario passes although the locale-presence rule no longer exists
  ```

  这恰好是「用另一个检查的副产物冒充本检查有效」。
- **影响**：`SUMMARY-round-3/4` 把这些检查列为已验证（"验证：`tests/validator.check.mjs`"）。实际状态是：这 8 条规则今天能工作，但只要有人在下一次重构中删掉或写错，测试不会变红。这和第一轮 `verify()` 恒真是同一类失效——守卫存在，但没有守卫守卫它。
- **建议**：
  1. 为每条规则补一个场景，并用 `scenario` 的名字与被测规则一一对应（`manifest_version: 2`、`version: "2.4.6.7.8"`、`permissions: ["stoarge"]`、删 `storage` 权限但保留 `chrome.storage.*` 调用、`matches: ["total garbage"]`、`web_accessible_resources: ["*.nonexistent"]`、非默认 locale 写成 `{ broken`）。
  2. 让 `scenario` 断言的是**具体的 FAIL 文案**，而不只是退出码非零。现在 `catches missing default locale` 靠 `code !== 0` 判定，任何别的规则报错都能让它通过。
  3. 在 `check` 脚本里维护一个「规则 → 场景名」的清单，缺场景就失败。
- **置信度**：确定（8/12 逐项实测，control 与 4 个 DETECTED 作对照）

### [P1] `check.mjs` 的 `*.css` 通配符只要有任意一个 css 存在就通过，三个运行时样式表可被静默删除

- **位置**：`tools/check.mjs:268-306`（`expandWarPattern` + `warChecked` 累计）
- **现象**：`web_accessible_resources` 的 `*.css` 展开后得到 5 个文件，但断言写的是「pattern 至少匹配到一个文件」（`if (matches.length === 0) fail(...)`）。删掉 `daisyui.css`、`style.css`、`subtitleBar.css` 三个文件后，pattern 仍匹配到 2 个（`options.css`、`options.d68fb9df.css`），于是输出 `ok 2 web_accessible_resources files resolve`、`check passed`。这三个文件是产物里真实存在、被内容脚本注入样式用的样式表（`daisyui.css` 以 `#vcaptions-subtitle` 开头，`subtitleBar.css` 是 `:host` 规则，`style.css` 1021 字节），删掉后扩展能加载但悬浮字幕条没有样式。
- **证据**：

  ```
  deleted: daisyui.css, style.css, subtitleBar.css
  check.mjs exit=0
    ok    2 web_accessible_resources files resolve
    check passed

  remaining css in package: options.css, options.d68fb9df.css
  ```

  另外，把 pattern 换成 `**/*.css` 时展开结果是 `1`（只命中 `tabs/tab-main.64262913.css`），此时删掉 5 个顶层 css 里的 5 个中的 4 个也一样通过——`**` 在 `check.mjs` 的实现里被当作 `[^/]*` 拼接，等价于 `*/*.css`，并非 Chrome 文档描述的"递归"。对照实测：

  ```
  *.css                baseline          exit=0  ok    5 web_accessible_resources files resolve
  **/*.css             recursive glob    exit=0  ok    1 web_accessible_resources files resolve
  tabs/*.css           subdir            exit=0  ok    1 web_accessible_resources files resolve
  ```

- **影响**：`SUMMARY-round-4` 的第 4 项声称「`web_accessible_resources` 的 `*.css` 通配符……正常时报告 5 个文件」，把"报告了 5 个"当成了覆盖证据。实际断言只保证"至少 1 个"，删 4 个仍绿。这是「检查了数量 ≠ 检查了完整性」。
- **建议**：
  1. 对 `web_accessible_resources` 里**非通配符**的条目做逐个存在性校验；对通配符条目，要求匹配数 ≥ 该 pattern 在基线里的匹配数（把 27 文件清单的期望值固化），或至少要求 `*.css` 匹配数等于 dist 里 css 文件总数。
  2. `**` 与 `*` 的转换要分别处理：Chrome 文档中 `"/images/*"` 是递归的，`*` 在资源路径里可跨目录；现在用 `[^/]*` 把 `**/*.css` 变成了错误语义，属于"校验器的语义比 Chrome 窄"，会给出假阳性/假阴性混合的结论。
- **置信度**：确定（删除 3 个文件、命令与输出均已记录）

### [P1] 权限白名单有 5 个字符的"跳过"后门：`storage/`、`storage:*` 之类的拼写不进入白名单校验

- **位置**：`tools/check.mjs:188-190`
- **现象**：`unknownPermissions` 的过滤器里有一行 `if (/[:/*<>]/.test(p)) return false; // host pattern, not a permission name`。任何名字只要包含 `:`、`/`、`*`、`<`、`>` 就被当作主机模式放行，不再查白名单。于是 `"storage/"`、`"storage:*"`、`"storage<"`、`"storage>foo"` 全部通过，且**同时**让 API 交叉检查也通过（因为 `declared.includes("storage")` 为假……实测见下）。
- **证据**：

  ```
  control:  5 declared permissions are recognised      exit=0
  storage/     exit=0 → accepted (whitelist skipped it)
  storage:*    exit=0 → accepted (whitelist skipped it)
  storage<     exit=0 → accepted (whitelist skipped it)
  storage>     exit=0 → accepted (whitelist skipped it)
  storage/foo  exit=0 → accepted (whitelist skipped it)
  ```

  这里值得注意：`storage/` 既不是合法权限名，也不是合法的 host pattern（权限数组里不接受 host pattern，host 要在 `host_permissions`）。也就是说这一行本意是"放过主机模式"，但在 `permissions` 数组的语境下，任何包含这些字符的名字都不可能是合法权限——这条豁免只会削弱校验。
- **影响**：真正想防的错拼（`stoarge`）能拦住，但"看起来像模式"的错拼（`storage/`，从 `host_permissions` 复制粘贴时的常见错误）完全拦不住。Chrome 会静默忽略未知权限，`chrome.storage` 变 undefined，与第 3 轮 P1-4 描述的故障一模一样。
- **建议**：`permissions` 数组里不该有任何 host pattern（那是 `host_permissions` / `optional_host_permissions` 的位置）。删掉这行豁免，改为：若发现权限名含 `/`、`:`、`*`，直接报 `FAIL` 并提示"host pattern belongs in host_permissions"。若要兼容历史写法，用一张显式的 scheme 前缀白名单（`http://`、`https://`、`*://`）而不是字符集合。
- **置信度**：确定

### [P1] API→权限交叉检查的 `API_PERMISSION` 只覆盖 12 个命名空间，且扫描正则看不见本项目最常用的两种写法

- **位置**：`tools/check.mjs:212`（扫描正则）、`219-247`（映射与遍历）
- **现象**：两部分都不完整。

  (a) **映射漏项**：`API_PERMISSION` 只有 `storage`、`tabs`、`scripting`、`sidePanel`、`contextMenus`、`notifications`、`alarms`、`cookies`、`downloads`、`history`、`bookmarks`、`webNavigation` 12 项，而且 `if (!required) continue` 会静默跳过所有未映射的命名空间。实测往 bundle 里注入 16 个 **Chrome 官方要求权限**的 API 调用，全部漏检：

  ```
  Injected API use (no matching permission declared):
    identity               MISSED (check passed)
    offscreen              MISSED (check passed)
    declarativeNetRequest  MISSED (check passed)
    management             MISSED (check passed)
    proxy                  MISSED (check passed)
    webRequest             MISSED (check passed)
    clipboardRead          MISSED (check passed)
    fontSettings           MISSED (check passed)
    browsingData           MISSED (check passed)
    idle                   MISSED (check passed)
    topSites               MISSED (check passed)
    sessions               MISSED (check passed)
    tabGroups              MISSED (check passed)
    pageCapture            MISSED (check passed)
    tts                    MISSED (check passed)
    privacy                MISSED (check passed)
  ```

  (b) **扫描看不见真实写法**：本项目的 `chrome.storage` 全部写成 `chrome.storage[I].get(...)`（区域名是变量），`chrome.sidePanel` 全部写成 `GC(Gz).sidePanel.open(...)`（通过 polyfill 取 `chrome`）。实测产物里 `chrome.storage` 的字面量出现 15 次，但 `chrome\.([a-zA-Z]+)\.` 正则一次都没匹配上：

  ```
  Main.00175a8f.js:  raw chrome.storage count 3   → regex namespaces: runtime
  options.6406b895.js: raw chrome.storage count 3 → regex namespaces: runtime
  sidepanel.65d86198.js: raw chrome.storage count 3 → regex namespaces: runtime
  static/background/index.js: count 3 → regex namespaces: runtime,scripting
  ```

  因此当前 `usedApis` 只有 `{runtime, scripting}`，`storage`、`tabs`、`sidePanel` 三个真正需要的权限从未被这条规则见证过。把 `storage` / `tabs` / `sidePanel` / `activeTab` 从 manifest 里删掉，`check.mjs` 全部 `check passed`：

  ```
  移除 storage   → check passed, EXIT=0
  移除 tabs      → check passed, EXIT=0
  移除 sidePanel → check passed, EXIT=0
  移除 activeTab → check passed, EXIT=0
  移除 scripting → FAIL  code uses these APIs but the permissions are not declared: scripting -> scripting
  ```

  唯一能拦住的是 `scripting`——因为它是产物里唯一一处 `chrome.scripting.registerContentScripts(...)` 的直写形态。
- **影响**：`SUMMARY-round-3` 的 P1-4 声称「权限名拼错（`stoarge`）后 `chrome.storage` 变 undefined，任何环节都不报错 → `check.mjs` 校验权限名，并交叉检查『代码用到的 API 是否都有对应权限』」。前半（拼错名字）成立，后半在**本项目自己的代码形态下不成立**：14/15 处 storage 调用对这条规则不可见。报告里的 `ok every chrome.* API used by the bundles has its permission declared` 是**真空真**（`usedApis` 里根本没有 storage/tabs/sidePanel）。
- **建议**：
  1. 扫描正则扩到 `chrome\.storage\.`、`chrome\.storage\[`、`\.storage\.(?:local|session|sync)`、`\bstorage\.(?:local|session|sync)\.` 三种形态；对 polyfill 形态（`X.tabs.`、`X.sidePanel.`）至少在别名已知时识别。
  2. `API_PERMISSION` 覆盖完整（Chrome 官方 permissions 列表里凡是"Gives access to the chrome.X API"的都要有），未映射的命名空间若要放过，必须列显式 allow-list（如 `runtime`、`i18n`、`action`），否则报"unmapped namespace"。
  3. 把"未声明但被用到"与"声明了但没用"分开报告；后者正是 §2 的 over-permission 检查，现在完全没有。
- **置信度**：确定（注入 16 个 API + 逐个删权限，均实测）

### [P1] `manifest.json` 的结构性缺失全部通过：`background`、`content_scripts`、`side_panel`、`options_ui` 被删仍 `check passed`

- **位置**：`tools/check.mjs:38-48`（`referenced` 从 manifest 自身推导）
- **现象**：`referenced` 集合完全由 manifest 内容生成，manifest 里没有的段就不会产生待校验路径，循环一次都不执行。实测删掉四段关键结构、甚至只留一个"最小可加载"的外壳，全部 `check passed`：

  ```
  background key removed                          exit=0 | (check passed)
  content_scripts all removed                     exit=0 | (check passed)
  side_panel section removed                      exit=0 | (check passed)
  options_ui removed                              exit=0 | (check passed)
  minimal valid-looking manifest, no background / content_scripts   exit=0 | (check passed)
  content_scripts js:[] css:[] (Chrome rejects the entry)           exit=0 | (check passed)
  ```

  同时还有 6 个 manifest 字段会引用文件、但 `check.mjs` 从不看：

  ```
  chrome_url_overrides points at a missing page      exit=0 | (check passed)
  action.default_popup points at a missing page      exit=0 | (check passed)
  devtools_page points at a missing page             exit=0 | (check passed)
  sandbox.pages points at a missing page             exit=0 | (check passed)
  declarative_net_request rule_resources missing     exit=0 | (check passed)
  host_permissions has a garbage pattern             exit=0 | (check passed)
  ```

  另外 HTML 内联资源只匹配双引号（`/(?:src|href)="([^"]+)"/g`），改成单引号后既不校验也不报错：

  ```
  html points at a missing script (single-quoted)   exit=0 | (check passed)
  ```
- **影响**：这是第一轮 L2 报告里已指出的「空 manifest 通过」，第 3/4 轮声称"改为解析全部 10 个 JS、加入 manifest_version/version/matches/WAR/权限/API"之后，**结构性缺失这一面仍未修**：新加的都是"manifest 里已有某项时检查它的值"，没有一条是"manifest 必须具备某项"。这一项在 `known-issues.md` 里没有登记，`validator.check` 也没有对应场景，属于可回归的缺口。
- **建议**：加一个 REQUIRED_MANIFEST 清单（`manifest_version`、`name`、`version`、`background.service_worker`、非空 `content_scripts`、`side_panel.default_path`、`options_ui.page`、`icons["128"]`），缺失即 FAIL；把 `chrome_url_overrides`、`action.default_popup`、`devtools_page`、`sandbox.pages`、`declarative_net_request.rule_resources[*].path` 纳入 `referenced`；HTML 的 `(src|href)` 正则同时接受单引号。
- **置信度**：确定

### [P1] `check.mjs` 的 WAR 通配符展开可被 `../` 穿越出 dist，把一个 dist 之外的文件判为"resolve"

- **位置**：`tools/check.mjs:268-293`（`expandWarPattern` 的 `fs.existsSync(path.join(DIST, rel))`）
- **现象**：`resources` 里的 pattern 未经过任何规范化或越界检查，`../` 直接拼到 `DIST` 后面。当 `dist/` 的兄弟目录里恰好存在同名文件时，校验通过：

  ```
  web_accessible_resources ../package.json (dist sibling exists)   exit=0 | ok 1 web_accessible_resources files resolve
  web_accessible_resources ..\package.json (backslash)             exit=0 | ok 1 web_accessible_resources files resolve
  web_accessible_resources sub/../../package.json                  exit=0 | ok 1 web_accessible_resources files resolve
  ```

  在真实工程里 `dist/` 旁边就有 `package.json`、`README.md`、`build-report.json`，所以这不是纯理论：`"../package.json"` 会通过。绝对路径（`C:/Windows/win.ini`）会被拦住，说明只是"相对穿越"这一路漏了。
- **影响**：这条校验的目的（"资源不会在运行时 404"）被绕过：一个越界 pattern 在 Chrome 里是无效的资源声明（资源必须在扩展根目录内），却在本地被判定为"有匹配文件"。它也会掩盖"本该匹配 `*.css` 的 pattern 被误写成 `../../something`"这类事故。
- **建议**：`expandWarPattern` 入口先 `path.resolve(DIST, rel)`，断言 `resolved.startsWith(DIST + path.sep)`，否则 `fail("web_accessible_resources entry escapes the package root")`；同时把 `\` 统一成 `/` 后再做 glob。注意 Chrome 文档写明资源路径是"从扩展根目录出发的相对路径"，越界本身就是非法 manifest。
- **置信度**：确定

### [P2] `validator.check` 在 `dist/` 之外完全隔离（环境变量有效），但换一个 `VCAPTIONS_DIST` 会让它"测试另一个东西"而仍然通过

- **位置**：`tests/validator.check.mjs:34-42`（`runCheckOn` 注入 `VCAPTIONS_DIST`）、`56-58`（`copyTree(DIST, scratch)` 用的是**硬编码的** `ROOT/dist`）
- **现象**：先确认题面关心的点：`check.mjs` **确实**尊重 `VCAPTIONS_DIST`，把它指向空目录会立刻 `FAIL dist/manifest.json missing`、exit 1。所以不存在"测试实际在测真实 dist 从而永远通过"的缺陷。同时把 `check.mjs` 的 DIST 解析改成忽略该变量，`validator.check` 会立刻 9 项全 FAIL —— 这是一个有效的元测试信号：

  ```
  === 1) check.mjs ignores VCAPTIONS_DIST ===
      patch applied: true
      exit=1
      ok    accepts a clean build
      FAIL  catches missing default locale — validator missed it
      FAIL  catches invalid locale JSON — validator missed it
      ...（共 9 项 FAIL）
  ```

  但这个隔离是**单向**的，另有两个真问题：

  **(a) 测试读的是 `ROOT/dist`，被测的是 `scratch`。** `copyTree(DIST, scratch)` 里的 `DIST` 是 `path.join(ROOT, "dist")`，硬编码。若外部设置 `VCAPTIONS_DIST=某空目录` 运行 `tests/validator.check.mjs`（CI 里很容易这么写），`scenario` 仍然从真实 `dist/` 复制，然后每次都把 `VCAPTIONS_DIST` 覆盖成自己的 `scratch`——测试全绿，但外部指定的目录从未被测。实测：

  ```
  VCAPTIONS_DIST=<empty dir> node tests/validator.check.mjs
  ok    accepts a clean build
  ok    catches missing default locale
  ...
  validator check passed
  EXIT=0
  ```

  也就是说"让 VCAPTIONS_DIST 指向空目录，测试应全 FAIL"这个预期**不成立**，但不是 `check.mjs` 忽略变量，而是元测试自己忽略了变量。这是一个假的隔离信号。

  **(b) `scenario` 的 `mutate` 抛异常会让整套测试崩溃或静默跳过。** `mutate` 在 `try/finally` 里执行，异常向上冒泡；若删除的文件已不存在（例如 bundle 改了内容哈希），`fs.rmSync(..., {force:true})` 不会抛，但 `fs.rmSync(path.join(d,"MainCS...js"))` 遇到目标不存在时，`force:true` 会吞掉——可是本 case 里 `fs.rmSync` 没传 force 的地方（`_locales` 场景）会抛 ENOENT，导致整个测试以 Node 栈退出、后面的场景一条都不跑。实测把 bundle 重命名（模拟 Parcel 重新出哈希）后：

  ```
  check.mjs on renamed bundle: exit=0
  validator.check: exit=1 — Error: ENOENT: no such file or directory, lstat '...\MainCS.277dcde3.js'
  (the whole suite aborts; no per-scenario verdict at all)
  ```

  注意这里 `check.mjs` 仍然 exit 0（因为 manifest 里的引用被同步改了），而元测试直接崩掉——崩溃被 CI 当成"测试失败"，但失败原因与它声称验证的东西无关。
- **影响**：`validator.check` 目前能证明"破坏被捕获"，但它的场景全部**硬编码了当前产物的文件名**（`MainCS.277dcde3.js`、`WebappCS.8b5d7cd6.js`、`tabs/tab-main.64262913.css`）。Parcel 的哈希一变（重建、改一行再 build），这套测试要么崩要么空转，而它正是用来保证 `check.mjs` 有效的那个测试。
- **建议**：
  1. `scenario` 内 `copyTree(DIST, scratch)` 改为复制"当前被测树"，并让 `DIST` 也从 `process.env.VCAPTIONS_DIST ?? ROOT/dist` 解析，与 `check.mjs` 保持同一口径；或者在检测到外部 `VCAPTIONS_DIST` 时直接拒绝运行（fail-closed）。
  2. 文件名不要硬编码：从 manifest 里取 `content_scripts[0].js[0]`、`background.service_worker`、HTML 里第一个 `.css` 引用，找不到就报"测试环境与预期结构不符"。
  3. `scenario` 里包一层 `try/catch`，异常计入 failures 并继续跑，避免一条场景吞掉其余 9 条。
- **置信度**：确定（(a)(b) 均实测）

### [P2] `consistency.check` 的 storage-key 断言仍只做单向验证：漏键、增键都检测不到

- **位置**：`tests/consistency.check.mjs:114-138`
- **现象**：这一项确实从"两份 JSON 互相比对"改成了"回到产物找字面量"，方向是对的。但断言只有 `every reported storage key appears at a storage call site`（对**已报告**的键做过滤），没有反向断言。实测：

  ```
  A) 真实键从 audit+index 里删掉（dist 仍在用）：
     consistency.check exit=0 → (all assertions passed)
     videoInfo is still read at: true

  B) dist 里新增一个真实 storage 调用（audit/index/README 都没动）：
     consistency.check exit=0 → consistency check passed

  C) audit 只报 1 个键（index 与 README 同步改成 1）：
     consistency.check exit=0 → (passed — 15 real keys can vanish silently)
  ```

  (C) 尤其严重：把 `storage_keys` 缩到只剩 `vcaptions_log_config`，索引和 README 同步改，全部断言通过。L3 第一轮报的"漏掉 11 个真实键"如果重演，这个测试不会红。
- **影响**：`SUMMARY-round-2` 的 P1-8 声称"改为独立验证：直接扫产物，确认每个键出现在 storage 调用点或作为命名常量传入"。独立是真的，"验证"只覆盖了报告侧的假阳性，没有覆盖漏报。第一轮的核心抱怨恰恰是"漏掉 11 个真实键"，那一半没有守住。
- **建议**：加反向断言——用与 `tools/audit.mjs` **不同**的规则扫 dist（例如按 `storage.local.get|set|remove` 的参数位提取字面量，加上 `vcaptions-` 前缀常量），得到一个独立的键集合 `observed`，断言 `observed ⊆ audit.storage_keys`（允许一张显式的 `KNOWN_DYNAMIC` 例外表，如 `vcaptions-website:<domain>`、`persist:redux`）。这样 (A)(B)(C) 都会红。
- **置信度**：确定
- **已知问题的延伸**：`SUMMARY-round-4` 末尾承认"经多层变量传递的键会漏"。本条指出的是更基础的：**连"漏了"这件事本身都检测不到**。

### [P2] storage-key 的"佐证"是 1000 字符窗口启发式，可被一行无关代码满足

- **位置**：`tests/consistency.check.mjs:117-130`
- **现象**：`atCallSite` 判据是「键字面量前后 500 字符内出现过 `storage.(local|session|sync)`」；`declaredWithNamespaced` 是「附近出现过 `vcaptions-(auth-token|env|temp|global-settings|log_config)`」。任何紧邻这些内容的虚构键都会被判为"已佐证"。实测：

  ```
  把 `storage.local.get("x");var K="chapterNavigation_injected";t("chapterNavigation_injected");`
  追加进 dist，并把 chapterNavigation_injected 塞进 storage_keys：
    consistency.check exit=0 (no FAIL)
  ```

  这正是第一轮 L3 报的原始缺陷形态（i18n 键被当成存储键），换成一个"恰好靠近 storage 调用"的位置就能复现。另一路 `viaVariable` 用单字母名（`e`、`t`、`I` 是压缩产物的常态）会命中任何同名局部变量的 `storage.local.get(e)`，实测：

  ```
  var e="zzInventedKey";  + 把它写进 storage_keys
    exit=0 → PASSES
  ```
- **影响**：这个断言能挡住"完全无依据的虚构键"（B 组实测 `totallyInventedStorageKey` 会 FAIL），但挡不住"有依据位置的虚构键"。作为"审计漏报/误报"的守门员，它的强度低于声称。
- **建议**：把窗口启发式换成结构判据：在 bundle 文本里定位 `storage.(local|session|sync).(get|set|remove)(` 的**参数表达式**边界（括号配对），只接受参数位置上的字面量或已解析常量；`declaredWithNamespaced` 改成"与已知命名空间键在同一个逗号分隔的赋值链里"，而不是"1200 字符窗口内"。
- **置信度**：确定

### [P2] i18n 断言恒为假（永远不会触发）：切片把开引号一起算进 `before`，`t(` 后永远跟一个 `"`

- **位置**：`tests/consistency.check.mjs:141-151`
- **现象**：`i18nAsStorage` 的两条分支都要求 `near` 或 `near.slice(0, near.indexOf(k))` 以 `t(` 或 `i18n.t(` **结尾**。两个分支都不可能成立：

  1. **分支 A**（`near` 结尾）：`near` 是 `idx-60..idx+60` 的窗口，结尾是键之后的文本（通常是 `"),`），永远不以 `t(` 结尾。
  2. **分支 B**（`before` 结尾）：`near.indexOf(k)` 用的是**不带引号**的键名，而窗口里键名前面有一个开引号。于是 `slice(0, indexOf(k))` 得到的字符串以 `t("` 结尾，而不是 `t(`。正则 `(?:\bt|i18n\.t)\(\s*$` 要求 `t(` 之后直接是行尾或空白，被这个引号挡住。

  实测四种真实/典型调用形态全部 `fires=false`：

  ```
  i18n-shaped keys found in dist: 107
  keys where the i18nAsStorage predicate fires: 0

  planted "t(\"chapterNavigation_plantedProbe\")" -> fires=false
    near  = "t(\"chapterNavigation_plantedProbe\")"
    before= "t(\""
  ```

  注意 `before` 的末尾是 `t("`（三个字符），恰好说明切片把引号包含进来了。这是**一个字符的偏差导致整条断言永久失效**。

  在真实产物上跑同样的判据：107 个 i18n 键，**0 个**触发。也就是说这条 `check("no i18n translation key is reported as a storage key", ...)` 永远输出 `ok`，无论 `storage_keys` 里塞什么 i18n 键——只要它同时能满足上一条窗口启发式（例如把 i18n 键放在 storage 调用旁边）。
- **影响**：`SUMMARY-round-2` 的 P1-8 声称"新增 3 条断言"修复循环论证。其中这一条从"循环论证"退化成了"恒真"——形式上不同，效果相同。它无法捕获第一轮那个原始缺陷（6 个 i18n 键混入）。第一轮的原始缺陷形态（`title:e("chapterNavigation_deleteSession")`）在这里甚至不会被判为 i18n 调用，因为产物里的查表函数是 `e` / `i` / `r` 这类压缩名，本就不在 `t` 的候选集里。
- **建议**：判据改为「取键字面量之前最近的调用标识符」——用 `/([A-Za-z_$][\w$.]*)\s*\(\s*["']$/` 匹配 `before`（注意结尾要带引号），拿到调用名后再判断是否属于 i18n 别名集合；别名集合不能只写 `t`，要包含产物里实际使用的短名（可从 `_locales` 的键反查哪些短名被用于查表）。更稳的做法：把"审计报告的所有键"与"`_locales` 里定义的键集合"取交集，交集非空即 FAIL——这是独立真值，不依赖调用形态。
- **置信度**：确定（107 键 × 0 触发 + 构造 `t("...")` 仍 0 触发 + 定位到开引号偏移）

### [P2] 文档数字断言是子串包含匹配，前缀/后缀数字可绕过

- **位置**：`tests/consistency.check.mjs:190`、`195`、`200`、`205`、`212`
- **现象**：`readme.includes("16 个存储键")` 会被 `116 个存储键` 满足（因为 `"116 个存储键".includes("16 个存储键") === true`）。实测：

  ```
  README 改成 "116 个存储键" → consistency.check exit=0 (PASSES with count 116)
  ```

  `architecture.md` 的 `archDoc.includes("158 个")` 同理：把文档里 2 处 `158 个` 中的**一处**改成 `176 个`，另一处保留，断言依然通过——文档里同时存在正确数字和错误数字：

  ```
  occurrences before=2, after=1 (one corrupt)
  exit=0 → PASSES despite a wrong total in the same doc
  ```

  而如果**全部**改掉（`158 个` → `1580 个`），又会被 `1580 个` 满足（`"1580 个".includes("158 个")` 为 false，但 `"158 个"` 作为子串出现在 `1580 个` 里……实测 `architecture.md` 全部替换成 `1580 个` 时断言会 FAIL，说明是后缀方向安全、前缀方向不安全）：

  ```
  architecture.md originally contains '158 个' 2 time(s)
  after corrupting every occurrence: exit=1 FAIL
  ```

  结论：**前缀膨胀（`116`、`1580`）会被放过，后缀膨胀不会被放过**；同时**只要文档里任一位置有正确数字，其他位置的错误数字就检测不到**。
- **影响**：这些都是已知 stale-claim 的守门员（14/16 存储键、158 处理器）。当前的 `docs/architecture.md:159` 写的是「提取到 14 个存储键」——与 audit 的 16 不符，而 `consistency.check` 通过（因为它只查 README，不查 architecture.md 的存储键数字）。这正是"文档里有正确数字也有错误数字"的现成实例：

  ```
  audit storage_keys.length = 16
  arch.md contains '14 个存储键' : true
  arch.md contains '16 个存储键' : false
  navigation.md contains '14 个存储键' : true
  README contains '16 个存储键' : true
  ```
- **影响补充**：`docs/navigation.md:11` 与 `docs/architecture.md:159` 的「14 个存储键」是 `SUMMARY-round-2` P1-7 修复之后遗留的过期数字，`consistency.check` 完全不读这两个文件。
- **建议**：
  1. 用带边界的正则替掉 `includes`：`new RegExp(`(?<![0-9])${n}(?![0-9]) 个存储键`)`。
  2. 把「所有出现该数字的位置」都取出来比对：`[...text.matchAll(/[\d,]+ 个存储键/g)]` 必须全部等于期望值，而不是 `some`。
  3. 把 `navigation.md`、`architecture.md` 的计数段纳入断言范围（现在是 `readme` + `archDoc` 两个文件，`navigation.md` 未读）。
- **置信度**：确定

### [P2] `forbidden` 列表是可枚举短语，同义改写与未列入文档的表述都能绕过

- **位置**：`tests/consistency.check.mjs:219-226`
- **现象**：5 条正则分别锚定 `207 个可识别`、`7698 处中文文案`、`57,114`、`176 个后台处理器`、`96 个后台处理器`。逐一构造同义/变体：

  ```
  README 追加：
    7,698 处中文文案（带千分位）
    epilogue 共 57114 行（无千分位）
    后台处理器 176 个（语序调换）
    207 个 Chrome API 调用点（改掉『可识别』）
    96 个后台处理程序（改掉『处理器』）
  → consistency.check exit=0 (all assertions passed)
  ```

  且 `57,114` 这条只查 `readme` 与 `archDoc`，把同样的表述写进 `docs/navigation.md` 完全不检测：

  ```
  navigation.md 追加：另有 14 个存储键、207 个可识别 API、7698 处中文文案、57,114 行、176 个后台处理器。
  → consistency.check exit=0 (all assertions passed)
  ```
- **影响**：`SUMMARY-round-2/3/4` 把「历史错误数字不得回归」当作已验证项。实际这是"已知错误字符串黑名单"，不是"数字正确性校验"。它只能防"原样复制粘贴旧句子"，防不住任何改写，也覆盖不到未被列出的文档。
- **建议**：把 forbidden 列表反过来做——对每个**结构化的数字事实**（处理器总数/分层、端点数、存储键数、epilogue 行数、中文文案条数）在文档里用统一的可解析标记（例如 `<!-- fact:handlers.total=158 -->` 或表格行），测试解析标记后与 JSON 比对；纯文本表述只作为导航，不再承担事实。若短期内不改文档形态，至少把 `forbidden` 的模式写成"数字 + 任意 0-8 个非数字字符 + 关键词"的宽松式，并扫描 `README.md`、`docs/*.md` 全部文件。
- **置信度**：确定

### [P2] `check.mjs` 的 version 校验与 Chrome 的实际规则不一致：允许分量 >65535、前导零、全零

- **位置**：`tools/check.mjs:159`
- **现象**：正则 `/^\d+(\.\d+){0,3}$/` 只校验"1-4 段纯数字"。Chrome 官方规则（developer.chrome.com/docs/extensions/reference/manifest/version）另外要求：每个整数 0-65535、非零整数不能以 0 开头、不得全零。实测 `check.mjs` 的判定：

  ```
  "2.4.6"        accepted
  "0"            accepted      ← Chrome 拒绝（全零）
  "0.0.0.0"      accepted      ← Chrome 拒绝（全零）
  "2.04.6"       accepted      ← Chrome 拒绝（前导零）
  "65536.0"      accepted      ← Chrome 拒绝（>65535）
  "2.4.6.7"      accepted
  ```

  `tools/package.mjs` 用的是同一个正则（`/^\d+(\.\d+){0,3}$/`），因此 `--suffix` 产生的版本号同样不受这些约束。第 3 轮 P1-3 修的是"5 段版本号"，只修了段数。
- **影响**：`check.mjs` 的 `ok version 2.4.6 is Chrome-valid` 这句文案断言了"Chrome 会接受"，而实际只验证了段数。`package:test` 用 `--suffix test.1` → `2.4.6.test`（非数字已被 `clean` 过滤），目前不触发；但手工 `--suffix 0.0` 或改 manifest 时有假阴性。
- **建议**：把规则写全：段数 1-4、每段 `/^\d+$/` 且 `Number(seg) <= 65535`、非零段不以 `0` 开头、不全为 0；`package.mjs` 复用同一函数（抽到共享模块，避免两处再漂移）。
- **置信度**：确定（对照 Chrome 官方文档 + 本地实测）

### [P2] `check.mjs` 的权限白名单与 Chrome 官方列表有偏差：会误报合法权限，也会漏掉新增权限

- **位置**：`tools/check.mjs:168-186`
- **现象**：白名单硬编码 72 项，与 Chrome 官方 permissions 列表对比：

  - **缺失**：`accessibilityFeatures.modify`、`accessibilityFeatures.read`、`dns`、`publicSuffix`、`runtime`、`userScripts`、`webRequestAuthProvider` 等。实测添加 `userScripts` / `webRequestAuthProvider` 都被判为 `unknown permission(s)`：

    ```
    permission userScripts (valid Chrome perm)              exit=1 FAIL unknown permission(s): userScripts
    permission webRequestAuthProvider (valid Chrome perm)   exit=1 FAIL unknown permission(s): webRequestAuthProvider
    ```

  - **误报的严重性**：这条规则的设计意图是"Chrome 静默忽略未知权限"，但白名单不全时它会把**合法**权限判为非法，`check` 直接 exit 1，挡住正常构建。

  - **包含的项**：白名单里混入了 `downloads.open`、`downloads.ui`（这是合法权限，Chrome 文档有），但 `system.cpu` 之类的点号权限在 `permissions` 数组里写法与白名单一致，没问题。

  - **结构问题**：白名单没有任何"来源标注"或版本锚点，Chrome 新增权限时需要人工同步，而一旦漏同步就是**假阳性**（挡住构建）。
- **影响**：这是"白名单型校验"的通病，且方向与直觉相反：漏项造成的是构建失败（可见），不是静默放行（不可见）。但它会诱使人把合法权限从 manifest 里删掉以让 `check` 通过——那才是真正的静默破坏。
- **建议**：白名单从 Chrome 官方文档生成（脚本抓取 permissions-list 页面的 `` `"name"` `` 列表并落盘为 JSON），或者改成"只校验**已知错拼**"：维护一张 `KNOWN_BAD_SPELLINGS`（`stoarge`、`scriptng`、`sidepanel` 小写等），对未知名字只警告不失败。前者更准，后者更不容易挡住合法构建。
- **置信度**：确定（对照官方文档，`userScripts` / `webRequestAuthProvider` 实测被误判）

### [P2] `check.mjs` 对 `content_scripts[].matches` 与 `web_accessible_resources[].matches` 的校验不对称，后者完全不校验

- **位置**：`tools/check.mjs:250-260`（content_scripts）vs `295-306`（WAR，只迭代 `resources`）
- **现象**：`content_scripts` 的 `matches` 走 `isValidMatch`，但 WAR 的 `matches` 从未被检查。实测：

  ```
  WAR matches = garbage                 exit=0 | ok 5 web_accessible_resources files resolve
  WAR matches removed entirely          exit=0 | ok 5 web_accessible_resources files resolve
  ```

  文档明确要求 WAR 条目必须有 `matches` 或 `extension_ids`，且 matches 必须是合法 match pattern，否则 Chrome 报 "Invalid match pattern"。同时 `isValidMatch` 自己对主机部分的判定也有偏差：

  ```
  <all_urls>                   accepted
  *://*/*                      accepted
  http:///nohost               accepted     ← 无主机名，非法
  file:///*                    accepted
  chrome-extension://abc/*     REJECTED     ← 合法 scheme 却被拒
  urn:foo:bar                  REJECTED
  https://example.com          REJECTED     ← 无 path，非法，拒对了
  ```

  `http:///nohost` 被放过、`chrome-extension://` 被误拒。
- **影响**：WAR 的 matches 是本轮新增 WAR 校验的一半，实际只校验了 resources。`content_scripts` 的 matches 校验会误拒合法写法，但本项目未使用 `chrome-extension://` 作为 content script 目标，暂无实害。
- **建议**：WAR 条目复用同一套校验，并补"必须有 matches 或 extension_ids 之一"；`isValidMatch` 改为对 scheme/host/path 三段分别校验（host 非空、不允许 `\`、`<all_urls>` 单独处理）。
- **置信度**：确定

### [P2] `check.mjs` 对 manifest 的解析没有容错：非法 JSON / `null` / 数组直接抛栈

- **位置**：`tools/check.mjs:35`（`JSON.parse`）、`41`（`manifest.background`）
- **现象**：

  ```
  manifest.json = "{ not json"  → exit=1, 输出 Node 栈（SyntaxError），无 FAIL 行
  manifest.json = "null"        → exit=1, TypeError: Cannot read properties of null
  manifest.json = "[]"          → exit=1, 后续 add() 全部 undefined，最后因其它检查失败
  manifest.json = '"hello"'      → exit=1, 同上
  ```

  退出码是对的（fail-closed），但错误信息是原始栈，不是 `FAIL ...` 行。`validator.check` 的 `scenario` 只看退出码，所以这不会破坏测试；但它会让 `npm run check` 的日志看起来像"工具崩了"而不是"产物有问题"。
- **影响**：可运维性。在 `release` 流水线里，栈输出会被误判为工具 bug 而不是 manifest 问题。
- **建议**：`try { JSON.parse } catch (e) { fail(\`manifest.json is not valid JSON: ${e.message}\`); process.exit(1); }`，并在 parse 后加 `if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail(...)`。
- **置信度**：确定

## 已确认无问题的部分

以下项**实际构造反例并运行**，确认有效：

1. **`check.mjs` 的"解析 dist 中全部 10 个 JS"覆盖真实。** 对 10 个文件逐个注入语法错误，10/10 全部 `CAUGHT`（含 `static/background/index.js`、`tabs/tab-main.1e0435ca.js`、`YoutubeCS.6bf33c81.js`）。第一轮 L1 报的"不解析 4 个 bundle"确实修好了。
2. **`VCAPTIONS_DIST` 在 `check.mjs` 里生效，且是**完全替换**而非叠加。** 指向空目录立即 `FAIL dist/manifest.json missing`、exit 1；指向临时副本时读的是副本（删除副本里的 `MainCS` 会触发对应 FAIL）。不存在"测试实际在测真实 dist"的缺陷。
3. **`check.mjs` 的 `manifest_version` 校验有效**：改 `manifest_version: 2` → `FAIL manifest_version must be 3 for this build, found 2`、exit 1。
4. **`check.mjs` 的权限名拼写校验对普通错拼有效**：`storage` → `stoarge` → `FAIL unknown permission(s): stoarge`、exit 1。
5. **`check.mjs` 的 API 交叉检查对直写形态有效**：注入 `chrome.alarms.create(...)` → `FAIL ... alarms -> alarms`；`chrome.notifications.create(...)` → `FAIL ... notifications -> notifications`；删 `scripting` 权限 → FAIL。局限见上文 P1（映射与形态）。
6. **`check.mjs` 的 `references missing` 类校验对文本层面的破坏有效**：删 `MainCS`、删 `static/background/index.js`、删 `sidepanel.html`、删 HTML 引用的 css、图标指向不存在文件、`__MSG_` 键未定义、locale JSON 损坏——逐项都会 FAIL。局限是"manifest 里没有该段时不检查"（见 P1）。
7. **`consistency.check` 的 handler/endpoint 双源比对有效**：篡改 `architecture.generated.json` 或 `symbol-index.json` 会造成 `handler inventories agree` / `endpoint inventories agree` FAIL。
8. **`consistency.check` 对"完全无依据的虚构 storage key"有效**：把 `totallyInventedStorageKey` 塞进 `storage_keys`（产物里无任何字面量）→ `FAIL every reported storage key appears at a storage call site`。
9. **`consistency.check` 在 `dist/` 完全缺失时 fail-closed**：删掉 `dist/` 后，5 个真实键立刻被判 `uncorroborated`，exit 1。这一点比声称的更严格（好）。
10. **`validator.check` 是一个真元测试（对 4 项检查、以及"完全不检查"）**：中性化 parse sweep / HTML 引用 / `__MSG_` 键 / manifest 引用存在性，分别触发 1-3 条 `FAIL ... validator missed it`；把 `check.mjs` 换成 `console.log("check passed"); process.exit(0)`，10 个场景里 9 个 FAIL（`catches missing default locale` 等）。它确实能发现"校验器退化成 no-op"，只是不能发现"8 条新增规则被静默删掉"（见 P1）。
11. **`validator.check` 的 `accepts a clean build` 正向场景确实跑在干净副本上**，且 `scenario` 用 `fs.mkdtempSync` + `finally rmSync`，不污染真实 `dist/`（审查全程结束后复核 `dist/` 仍为 27 文件、内容摘要 `0e6f7461…`）。
12. **`check.mjs` 对 `manifest.json` 完全不存在的处理正确**：`FAIL dist/manifest.json missing (run npm run build)` + exit 1。

## 未覆盖的范围

- **`docs/symbol-index.json` 与 `src/readable/` 的一致性**：未验证 `index-symbols.mjs` 重新运行后是否与提交的 JSON 相同（属于 L3 的范围）。
- **`audit.mjs` 重新运行后的键集合稳定性**：只验证了"提交的 JSON 与 dist 的吻合度"，没有验证"重跑 audit 是否产出同一结果"。这是 `consistency.check` 的上游假设。
- **真实 Chrome 加载 `manifest_version: 2` 的产物**：以官方文档为准，未在浏览器里实测（本机 Chrome 156 只接受 MV3，构造 MV2 包会污染临时 profile，超出本层范围）。
- **`package.mjs` 的版本拼装路径全组合**：只静态比对了正则，未跑 `--suffix` 的全部分支（`0.0`、`65536.0`、空串）。第 3 轮已为段数写过 `package.check`，本层只指出规则本身不完整。
- **`check.mjs` 对 `.json`/`.html` 资源的内容校验**：`referenced` 只做 `existsSync`，不解析内容；`web_accessible_resources` 同理。这是设计选择，未作为发现报告。
- **并发场景**：`validator.check` 的临时目录前缀 `vcaptions-check-` 固定，两个 CI job 同时跑会各自 `mkdtemp` 到不同目录，不冲突；但 `validator.check` 与 `browser-verify` 共用 `dist/` 时若有人在 `dist/` 上做事会互相干扰，未测。

## 附：已尝试但被拦住的攻击（记录攻击面）

| 攻击 | 结果 | 说明 |
| --- | --- | --- |
| `check.mjs` 全文退化为 `console.log("check passed"); process.exit(0)` | 被拦住：`validator.check` 10 个场景中 9 个 FAIL，exit 1 | 元测试对"完全不检查"有效 |
| `VCAPTIONS_DIST=<空目录> node tools/check.mjs` | 被拦住：`FAIL dist/manifest.json missing` | 环境变量生效 |
| `VCAPTIONS_DIST=<空目录> node tests/validator.check.mjs` | **未被拦住**：全绿 exit 0 | 元测试自身忽略该变量（见 P2） |
| 删 `dist/` 后跑 `consistency.check` | 被拦住：5 键 uncorroborated，exit 1 | fail-closed |
| `storage_keys` 塞入产物中不存在的键 | 被拦住：`FAIL every reported storage key...` | 有效的单向断言 |
| 删 `YoutubeCS.6bf33c81.js`（动态注册） | **未被拦住**：exit 0 | 该 bundle 只经 `scripting.registerContentScripts` 在运行时定位，manifest 无引用；第一轮已记录，仍未修 |
| `manifest.json` 置 `{}` | 部分拦住：3 条 FAIL（manifest_version/version/API），但仍不检查结构缺失 | 与第一轮相比有改善，未修完 |
| `manifest.json` 置 `null` / 非法 JSON | 拦住（退出码 1）但以栈形式崩溃，无 FAIL 行 | 见 P2 |
| `web_accessible_resources` 改 `*.nonexistent` | 被拦住：`matches no files` | 有效 |
| `web_accessible_resources` 改 `../package.json` | **未被拦住**：`ok 1 ... resolve`（dist 兄弟目录有同名文件） | 见 P1 |
| `content_scripts[].matches` 改 `total garbage` | 被拦住：`invalid match pattern` | 有效 |
| `web_accessible_resources[].matches` 改 `total garbage` | **未被拦住**：只校验 resources | 见 P2 |
| `version` 改 `2.4.6.7.8`（5 段） | 被拦住：`not 1-4 dot-separated integers` | 第 3 轮修复有效 |
| `version` 改 `0` / `65536.0` / `2.04.6` | **未被拦住** | 见 P2 |
| 单引号 HTML `src='...'` 指向不存在文件 | **未被拦住** | 正则只认双引号 |
| 三个运行时 css 删除 | **未被拦住**：`ok 2 ... resolve` | 见 P1 |
