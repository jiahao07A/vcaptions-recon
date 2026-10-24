# R1 构建守卫 审查报告

审查者：R1-build-guards subagent
审查范围：`tools/build.mjs` 及其直接依赖 `tools/overlay.mjs`；为验证守卫有效性，实际运行了下游的 `tools/check.mjs`、`tests/bundles.load.mjs`、`tests/background.smoke.mjs`、`tools/package.mjs`、`tools/browser-verify.mjs`
审查时间：2026-10-23T10:30:00Z

所有实验都在临时副本中进行：用 `fs.cpSync`/`robocopy` 把 `assets/`、`src/`、`tools/`、`tests/`、`node_modules/`、`package.json` 复制到 `D:\DEV\_vc-rev-r1`，真实工程未被修改（复核方式见文末"已确认无问题的部分"）。控制组：副本中 `node tools/build.mjs` → `exit 0`、`10/10 bundles byte-identical`、`dist/` 27 文件、无 `.dist-staging` 残留。

## 结论摘要

**5 条声称的修复里，1 条完全成立（#4，且只单向）、2 条部分成立（#3、#5）、1 条有可用但选错的实现（#2）、1 条不成立（#1）。** 最严重的是 #1（暂存/原子替换）：`rmrf(DIST)` 与 `renameSync` 是两个独立步骤，且错误路径没有 `try/catch`；当 `dist/` 里有任何被占用的文件时，构建在**已经打印 `10/10 byte-identical` 之后**崩溃，把一个完好的 27 文件 `dist/` 删成 18 文件、留下一个 27 文件的 `.dist-staging/`，并且**不打印**"dist/ 未改动"那句承诺。这与"失败构建不破坏 dist"直接矛盾。第二严重的是 #2（语法校验）：`new vm.Script` 用 **script goal** 解析，而 `options`/`sidepanel`/`tab-main` 三个产物是被 `<script type="module">` 加载的；一句 `with (Math) {}` 就能让产物在 Chrome 里拒绝加载，而 `build` + `check` 双双通过。

## 发现

### [P1] 声称修复 #1 失效：原子替换不是原子的 —— `rmrf(DIST)` 崩溃后 dist 半毁，staging 残留，且构建立志已宣告成功
- **位置**：`tools/build.mjs:291-292`（`rmrf(DIST); fs.renameSync(STAGING, DIST);`），错误处理缺席；`tools/build.mjs:285-288`（只有 `process.exitCode === 1` 才走"dist 未改动"分支）
- **现象**：**声称的修复失效**——"失败构建不破坏 dist"只在**校验阶段**失败时成立。一旦校验通过而替换阶段失败，构建直接抛未捕获异常：`dist/` 被删掉一部分，`.dist-staging/` 留在磁盘上，用户看到的是 Node 的栈回溯 + 之前已经打印的 `10/10 bundles byte-identical`，而 `dist/ was left unchanged` 这句话**根本不会打印**。
- **证据**（副本中，`dist/manifest.json` 被另一个进程以 `FileShare.Read` 打开——这是"编辑器/杀毒软件/Chrome 正在读构建产物"的常态）：

  ```
  # good dist: 27 files (build exit 0)
  # $ node tools/build.mjs
  exit=1
  build: 10/10 bundles byte-identical to baseline
  Error: EPERM, Permission denied: \\?\D:\DEV\_vc-rev-r1\dist '\\?\D:\DEV\_vc-rev-r1\dist'
    code: 'EPERM',
  dist: 18/27 files
  missing: daisyui.css, icon128.plasmo.b89b7dfa.png, icon16.plasmo.00ac8b83.png,
           icon32.plasmo.9ad0c5b6.png, icon48.plasmo.cae3a6b3.png, icon64.plasmo.e4b604fc.png,
           IFrameCS.26275720.js, Main.00175a8f.js, MainCS.277dcde3.js
  staging residue: true
  ```

  复现：在副本中 `node repro.mjs F1`（完整脚本见文末附录）。

  三个必须同时出现的细节：
  1. `10/10 bundles byte-identical to baseline` 已经打印 —— 所有校验都过了；
  2. 崩溃点是 `build.mjs:291` 的 `rmrf`，**不是** `finish` 分支，所以那句"dist 未改动"的承诺没有机会执行；
  3. `.dist-staging/` 残留 27 个文件（完整的新产物）—— 下一次构建会先 `rmrf(STAGING)`，所以它不会污染下次产物，但它证明了"失败构建不留痕迹"不成立。

  同一根因的另外三种触发方式（均已实测）：`dist/` 被设为进程 CWD（PowerShell 场景，`Exit code: 1` + `EPERM` + `staging exists: True`）；`.dist-staging` 本身被占用（`EBUSY`）；构建进程被 `SIGKILL` 于 `rmrf(DIST)` 与 `renameSync` 之间（`ENOENT: ... rename '.dist-staging' -> 'dist'`，因为 staging 已被另一次构建拿走）。

  反面对照：只在校验阶段失败时，`dist/` 逐字节不变、staging 被清理、`dist/ was left unchanged` 正常打印（见"已确认无问题的部分 → 暂存/替换"表第 4 行）。所以缺陷边界很清楚：**原子性只覆盖了"校验失败"，没覆盖"替换失败"**。

- **影响**：`dist/` 是可直接加载的扩展目录，也是 `package.mjs` 与 `browser-verify.mjs` 的输入。半毁状态下 `package.mjs` 会以 `exit 2` 拒绝（实测：`dist/ is missing files the manifest references: MainCS.277dcde3.js, ...`），所以**不会**打出残缺的发布包——这是唯一的好消息。但操作者此时面对的是一个不可加载的 `dist/`、一句已经打印的"10/10 一致"、一个 Node 栈回溯、以及 26 个文件的 staging 残留；他很可能误以为是环境噪音而继续工作，而下一次 `npm run package` 前必须先成功重建。原始 P2 声称"失败构建不破坏 dist"，这条不成立。

- **建议**：
  1. 用 `try/catch` 包住替换段，并在 finally 里清理 staging：替换失败时打印明确信息（"dist/ 可能已被部分删除；请关闭占用 dist/ 的程序后重跑"）并 `exit 1`。
  2. 更好的做法：先把旧 `dist/` 改名成 `.dist-old-<pid>`，再把 staging 改名成 `dist/`，成功后才删 `.dist-old`。两次 `renameSync` 都在同一卷内，都能失败回滚；Windows 上 `dist/` 被占用时第一步就会失败，此时 `dist/` 完好无损。
  3. 校验失败的"left unchanged"文案应只在确实未触碰 dist 时打印；替换阶段的失败必须走另一条文案。
- **置信度**：确定。直接原因在 `build.mjs:291`；`rmrf(DIST)` 先于 `renameSync` 且在无保护的路径上，Windows 目录删除可以被任意占用句柄打断，这一点已用 `FileShare.Read` 与 CWD 两种方式各复现一次。

### [P1] 声称修复 #2 部分失效：语法校验只覆盖 script goal，三个 `<script type="module">` 产物可以带模块级语法错误出厂

- **位置**：`tools/build.mjs:204`（`new vm.Script(text, ...)`）；同一缺陷复制在 `tools/check.mjs:140`（`new vm.Script(code, { filename: rel })`）
- **现象**：**声称的修复失效**——"产物不能解析则 exit 1"成立，但"不能解析"是按 **script goal** 判定的。`options.html`、`sidepanel.html`、`tabs/tab-main.html` 三个入口都用 `<script src="..." type="module">` 加载（见三份 HTML），模块代码按 **module goal** 解析：严格模式、禁止 `with`、禁止 legacy octal、禁止重复形参。`vm.Script` 对这几类一概放行，`check.mjs` 也一样——两个守卫用同一个错误的口径，所以互相印证"没问题"。
- **证据**：

  ```
  # overlay: ";with (Math) {}" prepended to options epilogue
  ~ options.6406b895.js             19 modules    871717 B 6a4d3a3cabff… [overlay: epilogue]
  build: 9/10 bundles byte-identical to baseline
  build exit=0
  check exit=0: check passed
  as module: SyntaxError: Strict mode code may not include a with statement
  ```

  复现：`node repro.mjs F2`。

  逐项确认 script goal 与 module goal 的分歧（三个都测了）：

  | 片段 | `new vm.Script` | module goal |
  | --- | --- | --- |
  | `with (Math) { var r = 1; }` | 接受 | 拒绝 |
  | `var o = 0777;` | 接受 | 拒绝 |
  | `function f(a, a) {}` | 接受 | 拒绝 |

  这不是理论推演：把 `with (Math) {}` 写进 `src/overlay/options.6406b895/99-epilogue.js` 后，完整链路 `build → check → guard → bundles.load → package` **全部 exit 0**，`package` 报 `files: 27`。真实 Chrome 156 加载该包后，`browser-verify.mjs` 的选项页三项断言全部失败：

  ```
  ok    options page opens
  ok    options React root exists
  FAIL  options UI actually rendered — children=0
  FAIL  options page has content — bodyLength=86
  FAIL  options page rendered without uncaught exceptions — SyntaxError: Strict mode code may not include a with statement
  ```

  即：产物确实坏了（与声称的失败模式"构建出的包无法加载"一致），但 `build` 与 `check` 都放过了它，只有最末端的真实浏览器验证拦住。

- **影响**：三个 UI 入口（settings 页、侧边栏、标签页）的产物在**脚本可解析但模块不可解析**时会被当作合法产物打包。这类错误不是只有 `with`：`await` 在顶层、`import`/`export` 之外的保留字冲突、以及更常见的——**编辑者把 CommonJS 风格的代码粘进 epilogue**——都可能落在同一个缝隙里。`summary-round-3` 把 P1-7（"build 对语法无效产物 exit 0"）标为已修复，实际上修复只覆盖了 script goal 的一半。

- **建议**：
  1. 对 `manifest` 中通过 `type="module"` 加载的入口，改用 module goal 校验。Node 的 `vm.SourceTextModule` 需要 `--experimental-vm-modules`；更轻的做法是把产物写成临时 `.mjs` 后 `spawnSync(process.execPath, ["--check", tmp])`，或对三个模块入口直接使用 `import("data:text/javascript,...")`。
  2. 给 `check.mjs` 与 `build.mjs` 共用同一个 `assertParses(code, { goal })` 函数，避免两处口径不同步——目前它们是同一份错误逻辑的两份拷贝。
  3. 若不愿引入 module goal，至少对模块入口加一条正则黑名单（`\bwith\s*\(`、`/(^|[^\w$])0[0-7]+/`），但这是权宜之计，不如真解析。
- **置信度**：确定。`vm.Script` 与 `node --check *.mjs` 的分歧逐项实测；三个 HTML 的 `type="module"` 直接引自基线；`browser-verify` 的失败输出是真实 Chrome 156 的。

### [P1] 声称修复 #3 部分失效：基线被替换而未重新 split 时被静默报成"已修改"，且回退到 `index.json` 的旧哈希

- **位置**：`tools/build.mjs:213-216`（`fs.existsSync(baselinePath) ? sha256(...) : entry.baseline_sha256`），`tools/build.mjs:224`（`matches_baseline: digest === baselineDigest`），`tools/build.mjs:231`（`changed = results.filter(r => !r.matches_baseline)`），`tools/build.mjs:298`（`modified (expected while editing)` 文案）
- **现象**：**声称的修复部分失效**。改成读磁盘确实让"基线漂移"从**看不见**变成**看得见**，但它的输出语义是错的：漂移与"我正在编辑"共用同一个 `matches_baseline: false` + 同一句 `modified (expected while editing)`，退出码仍是 `0`。更糟的是第 214 行的回退——**基线文件不存在**时静默改用 `index.json` 里可能已经过期的 `baseline_sha256`。
- **证据**（把基线 `WebappCS.8b5d7cd6.js` 整体替换成 `YoutubeCS.6bf33c81.js`，不重新 split）：

  ```
  ~ WebappCS.8b5d7cd6.js             1 modules     19903 B 4c0f22559c8f…
  build: 9/10 bundles byte-identical to baseline
  modified (expected while editing): WebappCS.8b5d7cd6.js
  exit=0
  report modified_bundles=["WebappCS.8b5d7cd6.js"]
  dist matches the replaced baseline: false
  ```

  复现：`node repro.mjs F3`。

  注意 `19903 B` 与基线的新尺寸（23753 B）**不一致**，但报告里没有任何字段提示"基线本身变了"。`check.mjs` 对此完全沉默（`check passed`）。

  第二个漏洞（回退分支）的实测：删掉基线里的 `WebappCS.8b5d7cd6.js` 后构建，`matches_baseline` 仍为 `true`，因为 `entry.baseline_sha256` 命中了——`build: 10/10 bundles byte-identical to baseline`，`exit=0`。这正是修复声称要消除的"用 index.json 的旧哈希"，只是从默认路径挪到了 fallback 路径。

  第三个更危险的变体：把基线 `manifest.json` 的 `version` 改成 `2.4.7`（模拟上游发布新版）而不重新 split —— 构建 `exit=0`、`10/10 byte-identical`、`check passed`、`package` 打出 `version: 2.4.7` 的包，而包里的 10 个 bundle 全是 2.4.6 的字节。

- **影响**：基线更新是这个工程最正常的维护动作（`reconstruct.mjs` 的整个存在理由）。更新后若忘记 `npm run split`，构建会打出**旧代码 + 新版本号**的包，且所有守卫默许。对操作者而言，区分"我的编辑生效了"与"基线变了"目前只能靠肉眼比对 `bytes` 列。
- **建议**：
  1. 把 `matches_baseline` 拆成三态：`identical` / `overlaid`（有 overlay，属于预期修改）/ `drifted`（无 overlay 但与基线不同 = 基线没重新 split，或其 split 模块被手改）。第三种必须 `exit 1` 并指名 `npm run split`。
  2. 删掉 `: entry.baseline_sha256` 回退——基线文件缺失时直接 `exit 2`。这正是 `reconstruct.mjs` 已经采用的原则（"无法判断时拒绝而非放行"），`build.mjs` 没跟上。
  3. `build-report.json` 增加 `baseline_bytes` 与 `baseline_sha256_actual` 两个字段，让漂移在报告里可读。
- **置信度**：确定。三个变体（替换基线、删除基线、改基线版本号）均实测。

### [P2] 声称修复 #4 成立但方向单一：`findOmittedBaselineFiles` 只能发现"缺"，不能发现"多"；多出来的文件由"整目录替换"间接解决，但中间窗口仍可被打包

- **位置**：`tools/build.mjs:88-93`（函数只做 `walkFiles(BASELINE).filter(!shipped.has)`）、`tools/build.mjs:277`（对 `STAGING` 调用）
- **现象**：**声称的修复成立，但只在一个特定意义上**。"dist 多出文件"确实不会再来自"上次构建的残留"，因为 `dist/` 被整个换掉。但该函数本身是单向的：它枚举基线，检查产物里有没有；从不枚举产物去检查基线里有没有。因此任何在 **build 之后、package 之前**进入 `dist/` 的文件都会被原样打包。
- **证据**（`dist/` 由 build 生成 27 文件后，手工放入 `STALE-ORPHAN.js`，只跑 `check` + `package`，不重跑 build）：

  ```
  planted dist/STALE-ORPHAN.js after a successful build
  check  exit=0  check passed
  package exit=0
    packaged extension
      version:   2.4.6
      files:     28
      zip:       7.65 MB  release\vcaptions-test-2.4.6.zip
    release/vcaptions-test-2.4.6/STALE-ORPHAN.js shipped: true
  ```

  同一脚本末尾重跑 build 后 `orphan in dist after rebuild: false` —— 证明"整目录替换"这个间接防线是有效的。

  另外确认了正向检测确实工作：从 `STATIC_FILES` 里删掉 `daisyui.css` 后，`build exit=1`、`build INCOMPLETE — baseline files missing: daisyui.css`、`dist/` 保持 27 文件未被替换（四个静态文件各试一次，均如此）。

- **影响**：原始 P2 声称"孤儿文件不会进入 dist"在当前工作流（`release = build:clean && check && test && package && verify:browser`）下成立。但它依赖调用顺序，而不是依赖守卫：任何绕过 `build` 的手工 `package`（README 里 `npm run package` 是可单独运行的脚本）都会把 `dist/` 里的任何东西打进去。`package.mjs` 的 preflight 只检查"manifest 引用的文件是否存在"，不检查"是否有 manifest 之外的文件"。
- **建议**：在 `findOmittedBaselineFiles` 旁边加一个反向断言，或在 `package.mjs` 的 preflight 里断言 `walkFiles(DIST)` 恰好等于基线期望集合（`BASELINE − BASELINE_EXCLUDED`）。这同时能把声称修复 #3 的漂移变成硬失败。
- **置信度**：确定。孤儿进包已实测；反向函数缺失是代码结构事实。

### [P2] 声称修复 #5 成立但无交叉校验：overlay 的存在性没有任何检查，拼错文件名、放错 bundle、命名成片段——全部静默忽略

- **位置**：`tools/overlay.mjs:29-32`（`overlayPathFor` 只做 `existsSync`）、`tools/overlay.mjs:48-53`（`fragmentOverlayPathFor`）、`tools/overlay.mjs:56`（`listOverlays` 只枚举不校验）、`tools/build.mjs:112-127`（`readFragment` 只按 id 查）
- **现象**：**声称的修复成立**（overlay 优先级本身是对的：存在即生效，`[overlay: ...]` 会打印、`overlays in use: N` 会计数）。但"overlay 存在却被静默忽略"**确实可以构造**，因为没有任何一处把 `listOverlays()` 的结果与构建实际使用的 overlay 集合做比对。四种构造全部 `exit=0`、无任何警告：

  | 构造 | build 输出 | 编辑是否进 dist |
  | --- | --- | --- |
  | `hEvv.js`（模块 id 拼错一个字符） | `10/10`，`overlays in use` 不打印 | 否 |
  | `noSuchModule.js`（id 不存在） | `10/10` | 否 |
  | `src/overlay/GhostBundle/hEvvs.js`（bundle 名不存在） | `10/10` | 否 |
  | `preamble.js`（自然的片段名，正确名是 `00-preamble.js`） | `10/10` | 否 |

  对照：正确命名 `00-preamble.js` 时 `9/10` + `overlays in use: 1`。

  同时确认 `baseline_file` 的反斜杠推导修复**是有效的**（`build.mjs:189-191`）：把 index 的 `baseline_file` 改成 `.\\WebappCS.8b5d7cd6.js` 后，overlay 查找靠 `replace(/[\\\\/]/g, "__")` 仍然命中（`overlaysInUse=1`）；`split_dir` 用正斜杠/反斜杠两种写法也都能读到模块（`overlaysInUse=1`）。这一点比 brief 预期的更稳——**但** `baseline_file` 如果带 `./` 或 `.\\` 前缀，产物会被写到 `dist/./WebappCS....js`，同时 `findOmittedBaselineFiles` 会报缺文件并把构建打成 `INCOMPLETE`（`exit=1`），所以这条路径是"响亮失败"，不是静默错误。反斜杠转换本身没问题。

  更隐蔽的一例：把 `Main` 的 `hEvvs` 正文放进 `IFrameCS` 的 overlay（二者 id 相同、`bytes` 恰好都是 9523）：

  ```
  ~ IFrameCS.26275720.js             6 modules     86581 B 4a8ea5abf211… [overlay: hEvvs]
  build: 9/10 bundles byte-identical to baseline
  modified (expected while editing): IFrameCS.26275720.js
  exit=0
  bytes: dist=86581 baseline=86581
  identical: false
  ```

  产物字节数与基线**完全相同**（86581），而字节内容不同。`check` 报 `check passed`。只有 `bundles.load` 抓到（`Cannot read properties of undefined (reading 'register')`），因为被替换的模块体引用了另一个 bundle 的 `requireVar`。这个案例说明：`bytes` 列不能作为"改动范围是否符合预期"的判据（README 第 225 行正好把它当成判据）。

- **影响**：这是一个"编辑静默丢失"的入口，属于 P0 语义（用户工作丢失），但触发需要名字写错，且 `adopt` 生成的路径总是正确的，所以按 P2 记。真正值得修的是**没有任何一处检查 overlay 目录里是否有无法被使用的文件**：`adopt --list` 会用 `WebappCS.8b5d7cd6/hEvv` 这种名字报告"已接管 1 个"，让操作者确信自己的编辑在工作，实际完全没有。

- **建议**：
  1. build 结束时比对：`listOverlays(ROOT)` 里的每一项是否都被 `overlaid` 收集到；未被使用的，打印 `warning: overlay X was not applied (no such module in <bundle>)`，`modified_bundles` 非空但 `overlaid_module_count === 0` 时直接 `exit 1`。
  2. `adopt --list` 只列出能被解析的 overlay，并把无法解析的单独列成 "orphaned"。
  3. 在 `readOverlayBody` 里校验 `adopt` 头里记录的模块 id 与文件名一致（头是 `adopt` 自己写的，可解析），放错 bundle 的会被抓住。
- **置信度**：确定。四种忽略构造、跨 bundle 等长替换、反斜杠推导三个方向都有实测输出。

### [P2] 附带发现：并发构建共用固定 `.dist-staging`，互相破坏且报错信息误导

- **位置**：`tools/build.mjs:165`（`const STAGING = path.join(ROOT, ".dist-staging")` —— 固定路径，无 pid/随机后缀）
- **现象**：两个 `build.mjs` 同时运行时争用同一个暂存目录。实测 20 轮共 40 次运行，**34 次失败（85%）**，错误码分布：`INCOMPLETE` 14、`ENOTEMPTY` 9、`EPERM` 5、`ENOENT` 4、`EBUSY` 2。最误导的一种是 `build INCOMPLETE — baseline files missing: daisyui.css, icon16..., manifest.json, ...`（因为另一个进程正在 `rmrf` 它的 staging），会让人去查基线。**没有**出现"exit 0 但 dist 不完整"的情况（`badSuccess=0`），所以原子性在这里没被打破；被打破的是错误信息的可解释性。

  ```
  run 0: exit=1  build: 10/10 bundles byte-identical to baseline
  run 1: exit=1  Error: ENOTEMPTY, Directory not empty: \\?\...\.dist-staging
  ```

  注意 run 0 已经打印了 `10/10` 然后失败——与声称修复 #1 同一类"先报成功再崩"的观感问题。

- **影响**：`npm run release` 与 IDE 里的 watcher、或两个 worktree 共享同一目录时会出现。因为有 `--clean` 语义已废弃、且 staging 固定，无法用参数隔离。危害是排障成本：`build INCOMPLETE — baseline files missing` 会让人去查基线，而真因是并发。
- **建议**：`STAGING` 改成 `.dist-staging-${process.pid}`（或 `fs.mkdtempSync`），并在 `finally` 里清理；互换阶段用 `renameSync` 两次的方法（见声称修复 #1 的建议 2）可以顺带解决并发下的互相覆盖。
- **置信度**：确定。20 轮并发（40 次运行）实测，错误码分布已记录；另外 25 轮独立复跑里 `badSuccess` 始终为 0。

### [P3] 附带发现：失败的构建仍然重写 `build-report.json`，覆盖上一次成功构建的记录

- **位置**：`tools/build.mjs:244-260`（报告写入在校验判定**之前**）
- **现象**：`fs.writeFileSync(build-report.json)` 在第 246 行，`if (broken.length)` 的 `exitCode = 1` 在 270 行之后。所以失败的构建会留下一个 `broken_bundles: [...]` 的报告，覆盖掉上一次成功构建的 `10/10`、`modified_bundles: []`。报告里没有"这次构建是否发布了 dist"的字段，读取者无法区分"这份报告描述的是当前 dist"还是"描述一次失败的尝试"。
- **证据**：

  ```
  failed build exit=1  report rewritten=true
    broken_bundles in report: 1
  ```

  另外：staging 异常路径（`modules.json` 缺失、模块文件缺失）导致的未捕获异常**不会**写报告（`report broken_bundles=0`、`generated_at` 停留在上一次），因为异常发生在写报告之前。于是"报告是否为最新"同样无法判断。
- **影响**：`build-report.json` 目前只被 `package.mjs` 的 `EXCLUDE` 提及，没有消费方，所以实际危害是 P3。但它是 build 唯一的机读产物，一旦有人开始用它做 CI 断言，这个"失败也写、崩溃不写"的不一致会造成误判。
- **建议**：增加 `"published": true|false` 与 `"dist_file_count"` 字段；只在 `dist/` 替换成功后写入报告，或写入 `.build-report.failed.json` 以区分。
- **置信度**：确定。失败构建与崩溃构建两种路径都实测。

### [P3] 附带发现：overlay 的非 UTF-8 编码不被任何守卫发现（语法校验看不见错误解码）

- **位置**：`tools/overlay.mjs:116`（`fs.readFileSync(file, "utf8")` 静默把非法字节换成 U+FFFD）、`tools/build.mjs:204`（校验的是解码后的字符串）
- **现象**：**声称的修复不足以覆盖这条路径**。round-1 L5 已指出 UTF-16LE overlay 的问题，并明确写道"即使有人给 build 加上了 `vm.Script` 校验，UTF-16LE 的字节流仍会先被静默转成合法字符串"。当前实现没有加编码断言，所以这条预言仍然成立——不过形式与我预期不同：UTF-16LE 会被 `vm.Script` **拒绝**（`Invalid regular expression: missing /`），因为转成字符串后出现了 NUL 与乱码组合；**真正的缺口是 GBK/ANSI 编码**，它解码后是合法的 JS 字符串（U+FFFD 是合法字符），语法校验必然通过。
- **证据**（在 epilogue 的一个字符串字面量处混入 GBK 字节 `D2 D4 C6 B5 D7 D6 C4 BB`）：

  ```
  U+FFFD count after utf8 decode: 4

  build     exit=0  build: 9/10 bundles byte-identical to baseline
  check     exit=0  check passed
  load      exit=0  9 loaded, 0 failed
  guard     exit=0  guard check passed

  shipped: 19911 bytes, U+FFFD=4
  parses: yes
  around first U+FFFD: "...this.info(\"��Ƶ��Ļ \\u5df2\\u542f\\u52a8..."
  original baseline:   "...this.info(\"WebappCS \\u5df2\\u542f\\u52a8..."
  ```

  产物能解析、能加载、所有测试通过，但用户可见文案已经变成 4 个替换符。这是 `Set-Content`（PowerShell 5.1 默认 ANSI/GBK）写 overlay 会直接踩到的坑，而 README 明确把 Windows/PowerShell 当作目标环境。
- **影响**：产物可运行但内容损坏，症状是 UI 里出现 `���`。属于"构建成功但 dist 有问题"，正是本轮要查的那一类。定 P3 是因为：损坏是可见的（渲染时就能看到），不会静默丢工作。
- **建议**：`readOverlayBody` 改为按 `Buffer` 读取，断言 `buf.toString("utf8")` 往返一致（`Buffer.from(decoded, "utf8").equals(buf)`），或发现 U+FFFD / BOM 即抛错并指名文件与建议（"overlay 必须是 UTF-8 无 BOM；检测到 GBK 或 UTF-16"）。round-1 L5 的原始建议仍然适用且尚未实施。
- **置信度**：确定。GBK 与 UTF-16LE 两种编码均实测：前者穿透全部守卫，后者被语法校验意外拦下。

## 已确认无问题的部分

以下是我实际构造反例并跑过、确认**守卫确实拦住了**的点。这些都是"我攻过但没攻破"的记录，不是"看起来没问题"。

### 暂存/替换（声称修复 #1）

| 攻击 | 结果 |
| --- | --- |
| `.dist-staging` 预先存在且有内容（含一个 `manifest.json` 垃圾文件与 `ORPHAN.js`） | `rmrf(STAGING)` 先清空；构建 `exit=0`，`ORPHAN.js` 不在 `dist`，27 文件 |
| `dist/` 里已有 `STALE-ORPHAN.js` | 重建后文件被清除，`exit=0`，27 文件 |
| 连续两次构建 | 27 文件逐字节相同（`identical: true`），产物是输入的纯函数 |
| 校验阶段失败（语法错误）时 `dist/` 是否被破坏 | 27 文件逐字节不变，staging 被清理，`dist/ was left unchanged because the build failed.` 正确打印 |
| 从 `STATIC_FILES` 删掉静态文件（`daisyui.css`/`style.css`/`subtitleBar.css`/`options.d68fb9df.css` 各一次） | 四次均 `exit=1` + `build INCOMPLETE — baseline files missing: <file>`，`dist/` 保持 27 文件未被替换 |
| `dist/` 是 junction 指向外部目录 | `rmrf(DIST)` 只删除链接本身，**没有**删除链接目标里的用户文件（`precious/thesis.txt still exists: true`）。Windows junction 的 `lstat` 报 `isSymbolicLink=true`，`rmSync` 不会跟随 |
| `dist/` 目录本身带只读属性（`attrib +R dist`）、或 `dist/static` 只读 | 构建 `exit=0`，27 文件，正常替换（Windows 的只读属性不阻止目录删除） |
| Chrome 156 从 `dist/` 加载扩展的同时连续重跑 3 次 build | 三次均 `exit=0`、27/27、无丢失——Chrome 不持续持有 bundle 的文件句柄 |
| 另一进程把 `dist/` 当 CWD（`cmd /c cd /d dist && ...`） | 也能成功（`cmd` 不持有阻止删除的句柄）；PowerShell 的文件句柄会阻塞，见声称修复 #1 |
| `index.json` 里两条记录指向同一个 `baseline_file`（复制粘贴错误） | `exit=1` + `build INCOMPLETE — baseline files missing: options.6406b895.js`，不会静默丢失产物 |

### 语法校验（声称修复 #2）

| 攻击 | 结果 |
| --- | --- |
| **损坏的 preamble overlay**（`var x = ;`） | `build exit=1`，`syntax error: Unexpected token ';'`，`dist/` 未替换。片段不是完整程序，但拼进 bundle 后整体解析，所以能抓到 |
| **损坏的 epilogue overlay**（`function (`） | `build exit=1`，`syntax error: Unexpected identifier 'console'` |
| **语法合法但运行时必崩**（在 epilogue 前注入 `;throw new Error("BOOM")`） | 三个 UI/内容脚本 bundle（`WebappCS`/`options`/`sidepanel`）`build exit=0` + `check exit=0`——这符合设计（语法上确实合法）；下游 `tests/bundles.load.mjs` 抓到：`FAIL 内容脚本（Webapp） — RUNTIME-BOOM (phase: load)`、`8 loaded, 1 failed`。`background` 的 epilogue 以 `,` 开头，同样的注入产生语法错误，`build exit=1`。四个 bundle 各测一次，全部被 `bundles.load` 或 `background.smoke` 捕获 |
| `preamble.js`/`epilogue.js` 片段单独 `new vm.Script` | `preamble` 单独会抛（不是完整程序），但 build 校验的是**拼接后**的整包文本，所以不是缺口。brief 提到的这个疑点不成立 |

### 基线比对（声称修复 #3）

| 攻击 | 结果 |
| --- | --- |
| 基线文件被替换成另一个 bundle（不改 index） | 能看见：`9/10` + `modified (expected while editing): WebappCS.8b5d7cd6.js`。**语义问题**见声称修复 #3，但"不再用 index 旧哈希"这一点在**文件存在时**成立 |
| `index.json` 损坏（`{ not json`） | 启动即 `exit 1`，报 `SyntaxError`，不产出 |
| 从 `STATIC_FILES` 漏掉文件 | 见上表，四次全部被 `findOmittedBaselineFiles` 抓住 |
| 基线里多一个文件（`NEW-ASSET.css`） | `exit=1` + `build INCOMPLETE — baseline files missing: NEW-ASSET.css`（措辞是"missing"但实际含义是"未复制"），`dist/` 未被替换 |

### overlay 优先级（声称修复 #5）

| 攻击 | 结果 |
| --- | --- |
| 正确命名的模块 overlay | 生效：`[overlay: hEvvs]`、`overlays in use: 1`、`9/10` |
| 正确命名的片段 overlay（`00-preamble.js`、`99-epilogue.js`） | 生效：`9/10`、`[overlay: preamble|epilogue]` |
| `baseline_file` 用反斜杠（`.\\WebappCS.8b5d7cd6.js`） | 推导出的 bundle 名仍命中 overlay（`overlaysInUse=1`）。brief 担心的反斜杠转换**没有**造成静默失效 |
| `split_dir` 用反斜杠 vs 正斜杠 | 两种都能读（Windows 上等价；POSIX 上的问题由 `baseline_file` 推导规避，见声称修复 #5 说明） |
| overlay 末尾是 `//` 行注释 | 已由 `tests/overlay-edge.check.mjs` 覆盖，我复跑确认 pass |

### 其它已验证的守卫

- `check.mjs` 对全部 10 个 JS 产物做 script-goal 解析（`all 10 JavaScript files parse`），覆盖面完整——问题在 goal 选错，不在覆盖遗漏。
- `package.mjs` 在 `dist/` 半毁时拒绝打包（`exit 2`，列出全部缺失文件），不会产出残缺发布包。
- `browser-verify.mjs` 在真实 Chrome 156 中能抓到模块级语法错误（`FAIL options page rendered without uncaught exceptions — SyntaxError: ...`）。三个入口页与 content script 注入都在监控下。
- `tests/bundles.load.mjs` 的进程隔离有效：跨 bundle 覆写模块体后，`Cannot read properties of undefined (reading 'register')` 被准确报出，未被前一 bundle 的注册表掩盖。
- 真实工程当前状态健康：`dist/` 27 文件、无 `.dist-staging`、`build-report.json` 的 10 个 sha256 与 `dist/` 逐字节匹配。

## 未覆盖的范围

- **跨卷 `renameSync`（`EXDEV`）**：本机只有 C:/D: 两个卷，且 `dist/` 与 `.dist-staging` 都在仓库根（同卷），无法在不改 `build.mjs` 的前提下让二者跨卷。我用 junction 与"目标已存在"两种方式确认了 `renameSync` 的失败模式（`EPERM`，且明确不合并目录），但没有实测 `EXDEV`。按 `build.mjs:291-292` 的写法，`EXDEV` 会与 `EPERM` 走同一条未捕获异常路径，因此声称修复 #1 的结论适用。
- **构建进程在 `rmrf(DIST)` 执行中途被强杀**：`rmSync` 不是原子操作，理论上可以留下"部分删除"的 `dist/` 且没有 staging 可恢复。我构造了相邻时间窗（另一次构建取走 staging 后 `renameSync` 报 `ENOENT`）但没有精确命中"rmrf 执行到一半被 SIGKILL"。声称修复 #1 已覆盖同一条代码路径的失败语义，这个更极端的窗口未单列。
- **`tools/format.mjs`、`tools/adopt.mjs` 的格式化正确性**：只在验证 overlay 命名时用到 `adopt --list`，未审查 `adopt` 写出的内容是否正确。
- **`build-report.json` 的消费方**：全仓库检索只有 `build.mjs` 写、`package.mjs` 的 `EXCLUDE` 列名，无读取方。若计划在 CI 中消费，附带发现里关于报告字段的建议需要重新考虑。
- **Chrome 对"产物字节数与基线相同但内容不同"的反应**：声称修复 #5 里的跨 bundle 替换在 `bundles.load` 里崩在 `register` 上。我没有在真实 Chrome 里加载该产物确认其失败形态（预期是内容脚本不注入），因为 Node 环境已经给出了确定性证据。

## 附录：复现脚本

以下脚本均在副本根目录执行，会自行还原被改动的文件。完整版本见临时副本的 `repro.mjs`（`node repro.mjs F1` … `node repro.mjs F5`）。

```js
// F1: 失败的替换破坏 dist
// 前置：node tools/build.mjs 成功，dist 有 27 文件
// 用 PowerShell 以 FileShare.Read 打开 dist/manifest.json，然后在另一个进程跑 build
$fs=[System.IO.File]::Open('...\dist\manifest.json',
  [System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read)
# 另开终端: node tools/build.mjs
# → exit=1, 已打印 "10/10 bundles byte-identical", EPERM, dist 18/27, .dist-staging 残留
```

```js
// F2: module-goal 语法错误穿过 build + check
// src/overlay/options.6406b895/99-epilogue.js 开头加：
//   ;with (Math) {}
// 然后: node tools/build.mjs && node tools/check.mjs
// → 两者均 exit 0；把 dist/options.6406b895.js 复制成 .mjs 后 node --check
//   → SyntaxError: Strict mode code may not include a with statement
```

```js
// F3: 基线漂移被报成"预期修改"
// cp assets/baseline/extension-v2.4.6/YoutubeCS.6bf33c81.js \
//    assets/baseline/extension-v2.4.6/WebappCS.8b5d7cd6.js
// node tools/build.mjs
// → exit=0, "modified (expected while editing): WebappCS.8b5d7cd6.js"
```

```js
// F4: overlay 名字拼错 → 编辑静默丢失
// 写 src/overlay/WebappCS.8b5d7cd6/hEvv.js（少一个 s），内容含唯一标记
// node tools/build.mjs
// → exit=0, "10/10 bundles byte-identical", 编辑不在 dist
```

```js
// F5: 跨 bundle 等长替换
// 把 src/bundles/Main.00175a8f/hEvvs.js 的正文（去掉首行头）写到
// src/overlay/IFrameCS.26275720/hEvvs.js
// node tools/build.mjs
// → exit=0, "9/10", IFrameCS 86581 B（与基线字节数相同）, 内容不同
//   node tools/check.mjs → check passed; node tests/bundles.load.mjs → 抓到
```
