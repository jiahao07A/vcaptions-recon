# L1 构建与字节完整性 审查报告

审查者：L1-build-integrity subagent
审查范围：`tools/parcel-split.mjs`、`tools/reconstruct.mjs`、`tools/build.mjs`、`tools/overlay.mjs`
（为判定影响面，附带只读核对了 `tools/check.mjs`、`tools/adopt.mjs`、`tests/edit-safety.check.mjs`、`tests/bundles.load.mjs`）
审查时间：2026-10-21T07:40:00Z

## 结论摘要

**这层的"当前产物是对的，但校验器证明不了它对"。** 我用完全独立的方式（不调用工程任何工具）逐字节比对了 `assets/baseline/extension-v2.4.6/` 与 `dist/`：27 个共有文件全部字节相同，10/10 bundle 的 SHA-256 与基线一致，240 个模块各自能被 V8 独立解析，模块 id 与 `register(...)` 调用一一对应。这部分是**真实成立的**。

但支撑"无损"结论的三道校验（`parcel-split` 的 `verify()`、`reconstruct --verify` 的 `IDENTICAL`、`build` 的 `N/10 byte-identical`）**在数学上都是恒真的**：它们只证明"把切出来的碎片按原顺序拼回去等于原文件"，这对任意切法都成立。我构造了两个反例：把一个模块的正文整体搬进相邻模块的 `separator_after`（该模块文件只剩空注释），`verify()` 仍报 `IDENTICAL`；以及把 3 个模块的 bundle 只切出 1 个（另 2 个被吞进 epilogue），`reconstruct --verify` 报 `all bundles reassemble byte-for-byte`，`build` 报 `10/10 byte-identical`，`check` 报 `check passed`。**这是本层最严重的问题（P0）**：它对当前基线没有造成损失（因为实际切分是对的，我另外独立验证了），但它让"10/10"这个数字无法在基线更新或语法形态变化时发出任何警报。

次严重的是 **`reconstruct.mjs` 的手改检测在 `index.json`/`modules.json` 缺失或损坏时静默降级为"没有手改"**（P0），我实测在这种情况下手改会被直接覆盖且退出码为 0。此外 `build.mjs` 在 overlay 产出语法无效的 bundle 时仍返回退出码 0（P1），`stripOverlayHeader` 会吞掉任何合法的首部块注释（P2），正则/除号判别在 `.keyword/` 与 `++/` 上会抛错（P2，当前基线未触发）。

## 发现

### [P0] `verify()` 是恒真命题，无法证明模块边界正确

- **位置**：`tools/parcel-split.mjs:266-283`（`verify`）、`tools/parcel-split.mjs:277`（`rebuilt = preamble + parts.join("") + epilogue`）
- **现象**：`verify()` 把 `preamble.js` + 每个模块文件去掉首行 + 各自的 `separator_after` + `epilogue.js` 拼起来，再与原文比 SHA-256。因为切分本身是"原文按位置切片"，这个等式对**任意**切点都成立 —— 它验证的是"切片覆盖了原文且顺序不变"，而不是"每个切片是一个合法模块"。因此 `IDENTICAL` 无法区分"切对了"和"切错了"。
- **证据**：

  反例 1：把一个模块的正文整体移入前一个模块的 `separator_after`，被掏空的模块文件只留一行注释。

  ```
  $ node collapse.mjs        # 见下方"复现脚本"
  original module count: 16

  === after collapsing module 7ELH8 into module U13Vh's separator ===
    verify().identical = true  (820195/820195 bytes)
    => the proof does not require each file to be a module at all.
    module 7ELH8 body now: "" (0 bytes)
    parses as a standalone expression: yes (it is nothing)
  ```

  反例 2：把两个模块的正文互换，`verify()` 也照样通过（`tautology2.mjs`）：

  ```
  === after swapping module 0 and 1 bodies ===
  verify().identical = false
  ```

  （互换后 `identical=false` 是因为两者 `separator_after` 不同；但**只搬正文不改分隔符**的反例 1 通过，说明校验对"文件内容是不是模块"完全无感。）

  反例 3：真实的 240 个模块中，我另外用 V8 做独立 oracle 检查，全部通过 —— 也就是说**当前基线恰好切对了，但这是运气/人工核对的结果，不是 `verify()` 证明的**：

  ```
  $ node syntax-check.mjs
  modules checked: 240, syntax failures: 0
  ```

- **影响**：`npm run verify` 输出的 `reassembly: IDENTICAL` 和 README 中"拆分器……再与原始 SHA-256 比对"被当作无损性的证明，但它对边界错误、模块吞并、正文互换都无感。一旦基线升级（Parcel 改变 `register` 形态）或拆分逻辑回归，`verify` 会照常通过，而 `src/bundles/` 里的"模块"已经不再是模块 —— 后续基于它做的任何编辑都作用在错误的粒度上。
- **建议**：给 `verify()` 增加结构断言，至少包括：(1) 每个模块文件去掉首行后能被 `new vm.Script` / `node --check` 解析为**一个表达式**；(2) 模块正文中恰好出现一次 `.register("<manifest id>"`，且 id 与 manifest 一致；(3) `preamble`/`epilogue` 拼接后整包可解析。任一失败即 `exit 1`。把"IDENTICAL"改名为"round-trip identical"以免误导。
- **置信度**：确定（构造了两个独立反例，均实际执行）

---

### [P0] 手改检测在 `index.json` / `modules.json` 缺失或损坏时静默放行，手改被覆盖

- **位置**：`tools/reconstruct.mjs:56`（`if (!fs.existsSync(indexFile)) return edited;`）、`tools/reconstruct.mjs:61-63`（`catch { return edited; }`）、`tools/reconstruct.mjs:68`（`if (!fs.existsSync(manifestFile)) continue;`）、`tools/reconstruct.mjs:73-75`（`catch { continue; }`）、`tools/reconstruct.mjs:80`（`if (!fs.existsSync(file)) continue;`）
- **现象**：`findHandEdits()` 的每一层"读不到就跳过"都返回空编辑列表，而空列表被 `main()` 解释为"没有手改，可以安全重切"。于是当索引/清单缺失或损坏时，守卫**恰好失效**，`reconstruct` 会覆盖 `src/bundles/`，退出码 0，无任何警告。这与 known-issues #10 修复的初衷（"把静默数据丢失变成明确拒绝"）方向相反。
- **证据**：

  ```
  $ node edit-detect3.mjs
  === A. index.json DELETED, then a module edited, then `npm run verify` ===
    exit=0 refused=false
    hand edit survived? false   <-- false means SILENT DATA LOSS

  === B. index.json CORRUPTED (invalid JSON), then a module edited ===
    exit=0 refused=false
    hand edit survived? false

  === C. modules.json CORRUPTED, then a module edited ===
    exit=0 refused=false
    hand edit survived? false

  === D. modules.json DELETED, then a module edited ===
    exit=0 refused=false
    hand edit survived? false
  ```

  对比：索引完好时同样操作会被正确拒绝（`edit-detect2.mjs`）：

  ```
  === 1. hand-edit epilogue.js (append statement) ===
    exit=1 refused=true
    named: ["static__background__index/epilogue.js"]
  === 2. hand-edit a module body ===
    exit=1 refused=true
    named: ["static__background__index/hZnCo.js"]
  ```

- **影响**：会丢失用户工作（编辑被静默覆盖），且**不易察觉** —— 退出码 0、输出里没有任何"已跳过校验"的提示。触发条件现实存在：`src/bundles/` 是新克隆的、`index.json` 被误删、JSON 因合并冲突留下冲突标记（`<<<<<<<`）而损坏、或 `modules.json` 被格式化工具截断。
- **建议**：把"读不到"从 `return edited` / `continue` 改为**fatal**：`index.json` 缺失或无法解析时直接 `exit 2` 并提示"无法确认是否有手改，拒绝重切；确认可丢弃后加 `--force`"。`modules.json` 缺失时同理，不要 `continue`。另外，模块文件缺失（`!fs.existsSync(file)`) 也应视为编辑（删除也是一种编辑），至少要在拒绝理由里列出。
- **置信度**：确定（四种失效场景均实测，均造成实际手改丢失）

---

### [P1] `build.mjs` 在 overlay 产出语法无效的 bundle 时仍返回退出码 0

- **位置**：`tools/build.mjs:135`（`out += body + (m.separator_after ?? "")`）、`tools/build.mjs:137`（`out += epilogue`）、`tools/build.mjs:186`（`matches_baseline: digest === entry.baseline_sha256`）
- **现象**：`build` 只在最后对"基线文件缺失"设 `process.exitCode = 1`（`build.mjs:229`），对"生成物不可解析"不设。因此一个语法无效的 bundle 会被写进 `dist/`，构建照常成功退出。
- **证据**：把一个语法无效的 epilogue overlay 放进 `src/overlay/static__background__index/99-epilogue.js`：

  ```
  $ node overlay-broken.mjs
  === unterminated /* provenance header ===
    build exit=0 | check exit=1
    build says: build: 9/10 bundles byte-identical to baseline
  === empty overlay file ===
    build exit=0 | check exit=1
  === overlay containing only a header ===
    build exit=0 | check exit=1
  === truncated epilogue (first 1000 chars) ===
    build exit=0 | check exit=1
  ```

  在真实工程上复现（`pipeline-catch.mjs`）：

  ```
  === build with BROKEN overlay ===
    build exit: 0
    summary: build: 9/10 bundles byte-identical to baseline
    dist parses: false  bytes: 3093340
  ```

- **影响**：`build` 是 `npm run release` 的第一步（`package.json: release = build:clean && check && test && ...`）。虽然 `check` 后续会拦住（见下一条 P1 的覆盖面缺口），但任何只跑 `npm run build` 的路径（README 第 101 行把"字节一致"列为改动是否生效的判断依据）都会得到"成功"的错误信号。**P1 而非 P0 的原因**：损坏的 bundle 至少会被 `9/10` 这个数字间接暴露，且 `check` 在多数情况下能兜住。
- **建议**：在 `reassembleBundle` 返回后对 `text` 做一次 `new vm.Script(text)`（或 `node --check`）解析，失败即 `fail` 并 `process.exitCode = 1`，错误信息指名 bundle 与 overlayed 模块。这比等 `check` 更早、定位更准。
- **置信度**：确定（实测四种损坏场景，build 全部 exit 0）

---

### [P1] `check.mjs` 不解析 4 个 bundle，其中 `YoutubeCS` 的损坏可一路通过 build + check

- **位置**：`tools/check.mjs:38-44`（`referenced` 只从 `manifest.json` 收集）、`tools/check.mjs:119-120`（`const scripts = [...referenced].filter(...)`）
- **现象**：`check.mjs` 只对 `manifest.json` 直接引用的脚本做语法校验。`YoutubeCS.6bf33c81.js`、`sidepanel.65d86198.js`、`options.6406b895.js`、`tabs/tab-main.1e0435ca.js` 不在 manifest 里（后三者通过 HTML 的 `<script src>` 引用，`YoutubeCS` 完全不被任何文件引用），因此它们的语法从未被校验。
- **证据**：

  ```
  $ node check-coverage2.mjs
  === scripts check.mjs parses ===
  static/background/index.js
  MainCS.277dcde3.js
  IFrameCS.26275720.js
  WebappCS.8b5d7cd6.js
  Main.00175a8f.js
  SubtitleBar.f2dae354.js

  === bundles NOT syntax-checked by check.mjs ===
    YoutubeCS.6bf33c81.js
    sidepanel.65d86198.js
    options.6406b895.js
    tabs/tab-main.1e0435ca.js
  ```

  把 `YoutubeCS` 的 preamble overlay 弄坏后，三道门全部放行（`unchecked-bundle.mjs`）：

  ```
  === break preamble of YoutubeCS.6bf33c81 (not manifest-referenced) ===
    build exit  = 0   build: 9/10 bundles byte-identical to baseline
    dist parses = NO -> Unexpected token '}'
    check exit  = 0   (no FAIL)
    check tail  = check passed

    => ships a syntactically invalid bundle with build+check both green: true
  ```

- **影响**：一个语法无效的 bundle 可以通过 `build` + `check`，进入 `package.mjs` 打出的 zip。`sidepanel`/`options`/`tab-main` 三个 UI 入口如果损坏，用户会看到空白页；`YoutubeCS` 是 YouTube 适配器，损坏会导致该站点功能静默失效。注意 known-issues #1 修的是 locale 静默通过，这里是同一类"覆盖面缺口"，但未被覆盖。
- **建议**：`check.mjs` 增加一条独立规则：遍历 `src/bundles/index.json` 的每个 `baseline_file`，断言 `dist/<baseline_file>` 存在且可解析。这条不依赖 manifest，能覆盖全部 10 个 bundle。同时应解释 `YoutubeCS` 的用途（它不被引用，但可能在运行时被动态注入）。
- **置信度**：确定（实测 `check passed` 同时 `dist parses = NO`）

---

### [P1] `build.mjs` 的 `matches_baseline` 比对的是 `index.json` 里的旧哈希，不是磁盘上的基线

- **位置**：`tools/build.mjs:186`（`matches_baseline: digest === entry.baseline_sha256`）
- **现象**：`entry.baseline_sha256` 是 `reconstruct.mjs` 在拆分时写进 `index.json` 的快照值。`build` 从不重新读取 `assets/baseline/` 计算哈希。因此基线文件被改动后，`build` 仍会打印 `10/10 byte-identical to baseline`，而 `dist/` 与真实基线已经不一致。
- **证据**（`build-baseline-drift.mjs`，在基线 `YoutubeCS.6bf33c81.js` 末尾追加一行注释）：

  ```
  baseline mutated: bytes 23753 -> 23789

  === build after mutating the baseline on disk ===
    build exit: 0
    report.matches_baseline = true
    report.sha256           = 9fbb0b768d681baf
    actual baseline sha     = 73881073b7381449
    dist sha                = 9fbb0b768d681baf
    dist == actual baseline ? false
    build summary line: build: 10/10 bundles byte-identical to baseline
  ```

- **影响**：`10/10` 这句话在基线变动后会变成假话，而它正是 README 第 101 行、225 行推荐用来"判断改动是否只影响预期范围"的唯一依据。当前基线是归档产物、不常改，所以是 P1 而非 P0；但如果有人为了修复而直接编辑 `assets/baseline/`，整条信任链会静默失效。
- **建议**：`build.mjs` 重新从 `assets/baseline/<baseline_file>` 读文件算 SHA-256 作为比较基准（成本是 18MB 读取，可接受）；`index.json` 里的值只用于检测"基线是否漂移"，不一致时明确报 `baseline changed since split; re-run npm run split`。
- **置信度**：确定（实测）

---

### [P1] `reconstruct.mjs` 的 `matchBracket` 不跳过正则字面量，与拆分器的 `matchParen` 行为不一致，导致 epilogue 假阳性

- **位置**：`tools/reconstruct.mjs:163-200`（`matchBracket`，无 regex 分支）、`tools/reconstruct.mjs:141-155`（`findModuleSpans`）、`tools/reconstruct.mjs:122`（回退到 `spans[spans.length - 1].end`）
- **现象**：`parcel-split.mjs` 的 `matchParen` 用 `isRegexPosition` + `skipRegex` 跳过正则；`reconstruct.mjs` 自己实现的 `matchBracket` **完全没有正则处理**，只处理字符串/模板/行注释/块注释。同一个 bundle 用两套匹配器会得到不同的 span。当"最后一个模块的正文能在基线里精确找到"时，`reconstruct` 走字节搜索（`reconstruct.mjs:118`）从而避开这个问题；一旦最后一个模块被编辑（正文在基线里找不到），就回退到 `spans[spans.length-1].end`（`reconstruct.mjs:122`），用的是有缺陷的匹配器。
- **证据**：

  两个匹配器在真实基线上已经产生分歧（`span-compare.mjs`）：

  ```
  === span agreement on real baseline ===
    MISMATCH static/background/index.js       spans=16  count 16 vs 15
    ok       MainCS.277dcde3.js               spans=1
    ok       IFrameCS.26275720.js             spans=6
    ok       YoutubeCS.6bf33c81.js            spans=1
    ok       WebappCS.8b5d7cd6.js             spans=1
    MISMATCH Main.00175a8f.js                 spans=60  count 60 vs 58
    MISMATCH SubtitleBar.f2dae354.js          spans=16  #3 770Tx@12298-179969 vs 770Tx@12298-626640
    MISMATCH sidepanel.65d86198.js            spans=60  count 60 vs 57
    MISMATCH options.6406b895.js              spans=19  count 19 vs 18
    MISMATCH tabs/tab-main.1e0435ca.js        spans=60  count 60 vs 57
  ```

  这个分歧可被触发为假阳性：只编辑 `static__background__index` 的最后一个模块 `jZrc2.js`，`epilogue.js` **一个字节都没动**，却被报告为"已编辑"（`fp-proof.mjs`）：

  ```
  epilogue sha before   : 7a2913a24f8721e147176fe86971c651016fdef1717f1a3a1a2a9bd856837b12
  manifest epilogue_sha : 7a2913a24f8721e147176fe86971c651016fdef1717f1a3a1a2a9bd856837b12
  epilogue matches manifest: true

  epilogue sha after    : 7a2913a24f8721e147176fe86971c651016fdef1717f1a3a1a2a9bd856837b12  (unchanged: true)

  reconstruct reported as edited: ["static__background__index/jZrc2.js","static__background__index/epilogue.js"]
  => epilogue.js was NOT touched, yet it is reported as edited: true
  ```

  在 6 个 span 分歧的 bundle 上逐个测试，只有 background 触发（因为其余 bundle 的最后一个模块较短、恰好能字节匹配）：

  ```
  static__background__index  refused=true named=["...jZrc2.js","...epilogue.js"] epilogueFP=true
  Main.00175a8f              refused=true named=["Main.00175a8f/iQwX3.js"] epilogueFP=false
  SubtitleBar.f2dae354       refused=true named=["SubtitleBar.f2dae354/eNZ9W.js"] epilogueFP=false
  sidepanel.65d86198         refused=true named=["sidepanel.65d86198/cvpbX.js"] epilogueFP=false
  options.6406b895           refused=true named=["options.6406b895/aOhki.js"] epilogueFP=false
  tabs__tab-main.1e0435ca    refused=true named=["tabs__tab-main.1e0435ca/cvpbX.js"] epilogueFP=false
  ```

- **影响**：假阳性（误报 epilogue 被改）比假阴性安全，但会误导操作者去 `adopt --epilogue`，把一个**未被修改**的 epilogue 提升为 overlay —— 之后该 bundle 永远报 `9/10`，且 overlay 里是压缩代码，反而降低了可维护性。同时，两份功能重叠但行为不一致的括号匹配器是明确的维护隐患：修一处不会修另一处。
- **建议**：删除 `reconstruct.mjs` 里的 `matchBracket` 与 `findModuleSpans`，直接 `import { findModules } from "./parcel-split.mjs"`，复用同一套 span 计算。这既消除分歧，也减少约 60 行重复代码。另外，`modules.json` 里已经记录了 `epilogue_sha256`/`preamble_sha256`，检测手改时应优先直接比对这两个值，而不是从基线重新推导。
- **置信度**：确定（分歧与假阳性均实测复现）

---

### [P1] `stripOverlayHeader` 会吞掉 overlay 文件开头的任何块注释（含许可证头、`eslint-disable`、`@preserve`）

- **位置**：`tools/overlay.mjs:79-85`（`stripOverlayHeader`）、`tools/overlay.mjs:92`（`readOverlayBody` 再 `.trimEnd()`）
- **现象**：`stripOverlayHeader` 的规则是"如果文件以 `/*` 开头，就删到第一个 `*/`"。它不校验这确实是 `adopt` 生成的 provenance 头。任何以块注释开头的 overlay 都会被吃掉第一段注释。
- **证据**（`strip-header.mjs`）：

  ```
  === stripOverlayHeader behaviour ===

    provenance header (intended)
      in : "/* parcel overlay\n * module: X\n */\nconsole.log(1);"
      out: "console.log(1);"

    legitimate code comment as first thing
      in : "/* eslint-disable no-console */\nconsole.log(1);"
      out: "console.log(1);"

    license header
      in : "/*! MyLib v1.0 | MIT License */\nconsole.log(1);"
      out: "console.log(1);"

    directive prologue comment
      in : "/* @preserve important */\nconsole.log(1);"
      out: "console.log(1);"

    comment only
      in : "/* hdr */"
      out: ""
  ```

  对**语义**而言，注释被吞通常无害；但它会静默删除 `/*! ... */` 这类法律要求保留的许可证声明，以及 `eslint-disable` 之类的工具指令。而且 `readOverlayBody` 的 `.trimEnd()`（`overlay.mjs:92`）有更实际的危险，见下一条。
- **影响**：许可证/指令注释在产物中消失，且无任何提示。对一个"逐字节复刻官方产物"的工程，这属于"构建会改变你没让它改变的东西"。
- **建议**：只剥离**带明确标记**的头（例如要求首行精确匹配 `/* parcel overlay` 或以 `Overlay module:` / `Overlay fragment:` 开头，这正是 `adopt.mjs` 写出的格式），其余一律原样保留。同时把 `trimEnd()` 的副作用单独评估。
- **置信度**：确定（实测 4 种合法注释均被删除）

---

### [P1] overlay 正文以 `//` 行注释结尾时，`trimEnd()` 会让紧随其后的分隔逗号被注释吞掉，产出无效 bundle 且 build 退出码 0

- **位置**：`tools/overlay.mjs:92`（`return stripOverlayHeader(...).trimEnd();`）、`tools/build.mjs:135`（`out += body + (m.separator_after ?? "")`）
- **现象**：`build` 在每个模块正文后**直接**拼接 `separator_after`（对绝大多数模块是 `","`），中间不插入换行。`readOverlayBody` 又把 overlay 的尾部空白 `trimEnd()` 掉。于是当开发者把 overlay 的最后一行写成 `// TODO: ...` 时，拼接结果变成 `// TODO: ...` 后面紧跟 `,g.register("wvq7b",...)` —— 逗号被行注释吞进注释里，整个 bundle 语法错误。
- **证据**（`line-comment-comma.mjs`，overlay 正文末尾加一行 `// TODO: revisit this module`）：

  ```
  separator_after of module 0: ","

  === build with an overlay whose body ends in a // comment ===
    build exit=0
    summary: build: 9/10 bundles byte-identical to baseline
    dist 86610B vs baseline 86581B
    emitted text around the comment:
      "\"module\"],r):r(t)})\n// TODO: revisit this module,g.register(\"wvq7b\",function(e,t){i(e.exports,\"default\",()=>l)"
    dist parses: NO -> Unexpected end of input
    check.mjs exit: 1
  ```

  preamble overlay 同样会中招，且因为 `MainCS` 的 preamble 后紧跟第一个模块，破坏更直接（`preamble-comment.mjs`）：

  ```
  === preamble overlay ending in a // comment ===
    build exit=0
    summary: build: 9/10 bundles byte-identical to baseline
    dist 23773B vs baseline 23753B
    emitted: "e]=r},n.parcelRequire4da4=a),\n// end of bootstrapa.register(\"cNTJc\",function(r,t){..."
    dist parses: NO -> Unexpected token '}'
    check.mjs exit: 0
  ```

  注意最后一行：这次 `check.mjs` 也返回 0（因为 `YoutubeCS` 不被 manifest 引用），见前面 P1 那条。
- **影响**：一个非常自然的开发动作（在 overlay 末尾留一行 `// TODO`）会产生语法无效的产物，而 `build` 报成功。这是本层最容易被真实开发者踩到的缺陷 —— 它不需要任何异常输入，只需要一条注释。
- **建议**：拼接时始终在正文与分隔符之间插入换行（`out += body + "\n" + separator`），或在 `readOverlayBody` 中不要 `trimEnd()` 而是确保返回文本以 `\n` 结尾。前者更稳妥，且对现有 10/10 结果无影响（因为 `separator_after` 前的换行属于模块间空白，需同时确认不会破坏字节一致 —— 更安全的做法是：检测 `body` 是否以 `//` 注释结尾，若是则强制补 `\n`）。
- **置信度**：确定（模块 overlay 与 preamble overlay 两条路径均实测复现）

---

### [P2] 拆分器对未识别的 `register(...)` 形态静默吞并，不报错

- **位置**：`tools/parcel-split.mjs:17-18`（`REGISTER_RE` 只匹配 `(?:async\s+)?function\s*\(`）、`tools/parcel-split.mjs:219`（只有 `modules.length === 0` 才抛错）
- **现象**：`REGISTER_RE` 只识别 `function(...)` 与 `async function(...)` 两种工厂形态。箭头函数 `(m,e)=>{}` 和具名函数 `function nm(m,e){}` 都不匹配，这些模块不会被切出，而是被"吸收"进相邻的 epilogue/分隔符。`findModules` 只要找到**至少一个**模块就正常返回，不比对"是否所有 register 调用都被覆盖"。
- **证据**（`e1-register-forms.mjs`，3 模块 bundle）：

  ```
  === B. second module is arrow-form ===
    module_count=1 ids=["AAA"]
    verify().identical=true
    epilogue bytes=94 (input epilogue was 26B)
    !! unrecognised module leaked into epilogue.js

  === C. second module is named function ===
    module_count=1 ids=["AAA"]
    verify().identical=true
    epilogue bytes=103 (input epilogue was 26B)
    !! unrecognised module leaked into epilogue.js
  ```

  完整链路（`e2e-clean.mjs`，清空 `src/bundles/` 后跑真实的 `reconstruct --verify`）：

  ```
  === CLEAN reconstruct --verify, baseline has 3 register() forms ===
    exit = 0
    all bundles reassemble byte-for-byte
    modules found: 1 (ground truth 3)
    ids: ["cNTJc"]

    build exit=0 | build: 10/10 bundles byte-identical to baseline
    YoutubeCS matches_baseline=true, modules=1

    => SILENT: 2 of 3 modules invisible, every check green: true
    check.mjs exit=0
  ```

- **影响**：对**当前**基线不构成损失（我独立验证了 240/240 模块 id 与 `register` 调用一一对应，见"已确认无问题的部分"）。但它是一个静默失败模式：Parcel 在 `package.json` 设 `"type": "module"` 或特定 target 时会产出箭头形式的工厂函数，届时拆分器会把多个模块塞进 epilogue，而 `verify`/`build`/`check` 三道门全绿。known-issues 没有记录这一条。
- **建议**：`findModules` 结束时断言"源码中 `.register("` 的出现次数 == 切出的模块数"（用 `/\b[\w$]+\.register\(\s*["']/g` 计数），不一致就抛错并列出未被识别的调用位置。这只需几行，能把这个静默失败变成显式失败。
- **置信度**：确定（三种形态均实测）

---

### [P2] 正则/除号判别在 `.keyword/`、`++/`、`--/` 与嵌套模板上误判，抛错而非静默出错

- **位置**：`tools/parcel-split.mjs:82-93`（`isRegexPosition` 的 `kw` 后缀匹配）、`tools/parcel-split.mjs:66`（`skipString` 把 `` ` `` 当普通字符串处理，不处理 `${}` 嵌套）
- **现象**：`isRegexPosition` 用"前 12 个字符是否以关键字结尾"判断，`obj.return/2` 会命中 `return` 从而被当成正则起点；`a++/2` 因为 `+` 在 `"(,=:[!&|?{};+-*%~^<>"` 里也被当成正则起点。两者都是合法 JS 的除法。另外 `skipString` 对模板字符串不处理 `${}`，所以 `` `${`}`}` `` 这种嵌套模板会被提前截断。
- **证据**（`fuzz-regex.mjs`，用 V8 `--check` 先确认片段是合法 JS，再断言 `matchParen` 落点）：

  ```
  FAIL  div: a++/2                         got="THREW: unterminated regex literal" expect=44
  FAIL  div: obj.return/2                  got="THREW: unterminated regex literal" expect=51
  FAIL  div: obj.in/2                      got="THREW: unterminated regex literal" expect=47
  FAIL  div: obj.case/2                    got="THREW: unterminated regex literal" expect=49
  FAIL  div: obj.delete/2                  got="THREW: unterminated regex literal" expect=51
  FAIL  div: obj.of/2                      got="THREW: unterminated regex literal" expect=47
  FAIL  div: obj.new/2                     got="THREW: unterminated regex literal" expect=48
  FAIL  div: obj.typeof/2                  got="THREW: unterminated regex literal" expect=51
  FAIL  tpl: } in nested tpl               got="THREW: bracket mismatch at 46: expected ), found }" expect=47

  29 passed, 9 failed, 2 skipped
  ```

  其余 29 项（含 `regex: containing }`、`regex: charclass with ]`、`regex: escaped slash`、`div: a / /re/.source.length`、`tpl: nested`、`tpl: regex in interp`）全部通过。

  **当前基线未触发**：我扫描了 10 个 bundle，`.keyword/` 出现 0 次；`++/`、`--/` 出现 8 次但全部落在字符串或 base64 里（`incdec.mjs` 显示 `"P++/vQ=="` 与 `/^-----BEGIN ((?:.*? KEY)|CERTIFICATE)-----/m` 等）。

- **影响**：这些是**显式抛错**（`unterminated regex literal` / `bracket mismatch`），不是静默产出错误结果 —— 这一点是好的，符合"失败要响"的原则。但在真实工程中，一个合法的 `x++/2` 会让 `reconstruct` 直接崩溃，且错误信息（"unterminated regex literal"）不指向真正的根因（除号被判成正则），排查成本高。P2 而非 P0/P1 的依据：不静默、当前基线不触发。
- **建议**：`isRegexPosition` 应改为基于**上一个 token 类型**而非文本后缀：若前一个 token 是标识符/数字/`)`/`]`/`}`/`++`/`--`，则是除号；若是关键字（`return`/`typeof`/...）或运算符/开括号，则是正则。注意 `obj.return` 里 `return` 是属性名，前一个字符是 `.`，应判为除号。`skipString` 应区分模板字符串并递归处理 `${ ... }`。若不想重写词法器，至少把错误信息改为"无法判定 `/` 是除法还是正则（位置 N），请在报告中记录此语法"。
- **置信度**：确定（9 个反例实测；基线未触发也已实测确认）

---

### [P2] `matchBrace` 只用 `{`/`}` 计数，却被当作通用括号匹配器导出

- **位置**：`tools/parcel-split.mjs:31-62`（`matchBrace`）、`tools/parcel-split.mjs:74-76`（`moduleBody` 调用它）
- **现象**：`matchBrace` 计算了 `closer = pairs[src[open]]` 但从未使用；循环里只对 `{` 增深度、对 `}` 减深度。用 `(` 或 `[` 调用它会得到错误结果而不报错。它对嵌套模板也会提前返回。
- **证据**（`matchbrace2.mjs`）：

  ```
  pass  plain body                               open=13 got=22 expect=22
  pass  body with object                         open=13 got=26 expect=26
  pass  body with template object                open=13 got=37 expect=37
  FAIL  body with nested template                open=13 got=25 expect=29
        got   : "{return `${`}"
        expect: "{return `${`}`}`}"
  pass  body with regex brace                    open=13 got=24 expect=24
  pass  body with regex brace closer             open=13 got=24 expect=24
  pass  body with string brace                   open=13 got=24 expect=24
  pass  body with comment brace                  open=13 got=29 expect=29
  ```

  用 `(` 调用时（`matchbrace.mjs`）返回了一个"匹配"位置而非抛错：

  ```
  FAIL  called with ( — counts braces only         got=4  expect=(should throw or be correct)
  FAIL  called with [ — counts braces only         got=3  expect=(should throw or be correct)
  ```

- **影响**：`matchBrace` 目前只被 `moduleBody` 用 `{` 调用，且 `moduleBody` 的结果只写进 `modules.json` 的 `body_bytes` 字段（`parcel-split.mjs:248`），不影响切分结果 —— 所以当前无实际后果。但它被 `export` 出去（`parcel-split.mjs:285`），后续复用极易出错。嵌套模板的误判意味着 `body_bytes` 可能不准。
- **建议**：删掉未使用的 `closer` 变量并重命名为 `matchCurly`，或在入口断言 `src[open] === "{"`。`skipString` 修正后嵌套模板问题自动消失。`body_bytes` 若无人消费，考虑移除。
- **置信度**：确定（实测）

---

### [P2] `build.mjs` 把模块文件首行无条件当注释剥掉，且以文本模式读写导致非 UTF-8 字节被替换

- **位置**：`tools/build.mjs:131-133`（`const nl = raw.indexOf("\n"); body = raw.slice(nl + 1);`）、`tools/build.mjs:177`（`fs.writeFileSync(dest, text, "utf8")`）
- **现象**：`build` 不校验首行是否真的是 provenance 头，直接丢弃。若模块文件只剩一行（头与正文之间没有换行），整行会被丢弃；若有人误删了首行的换行，正文会被当头部吞掉。另外 `readFileSync(..., "utf8")` 会把非法 UTF-8 字节替换为 U+FFFD，写回时该字节永久丢失。
- **证据**（`encoding-path.mjs`）：

  ```
  === T1. module file containing a non-UTF-8 byte (e.g. Latin-1 in a comment) ===
    file bytes=9621, valid UTF-8 roundtrip=false
    build exit=0 | build: 9/10 bundles byte-identical to baseline
    dist contains 0xe9? false   dist contains U+FFFD (efbfbd)? true
    => byte corrupted silently: true

  === T2. module file that is a single line (header + body, no newline) ===
    build exit=0 | build: 9/10 bundles byte-identical to baseline
    dist contains the header text? true  <-- header leaked into the bundle
  ```

- **影响**：T1 是真实的字节损坏路径（虽然需要有人写入非 UTF-8 内容，在 Windows 上用 GBK 编辑器另存即可能发生）。T2 表明"首行"契约没有校验。两者都只在编辑后触发，P2。
- **建议**：校验 `raw.startsWith("/* parcel module id: ")`，否则抛错（`adopt.mjs:34` 的 `stripModuleHeader` 已经做了这个判断，可直接复用）。若确实需要字节级保真，模块文件应以 `Buffer` 读取并拼接，而不是字符串。
- **置信度**：确定（实测）

---

### [P2] `build.mjs` 的 `findOmittedBaselineFiles` 只能发现"新增"，发现不了"基线文件被删"

- **位置**：`tools/build.mjs:87-92`（`walkFiles(BASELINE).filter(...)` 以基线为遍历源）、`tools/build.mjs:159-166`（`copyFile` 在源不存在时静默 `return false`）
- **现象**：该检查遍历的是**基线**，找"基线有但 dist 没有"的文件。若基线文件本身消失，它不在遍历结果里，检查自然通过；`copyFile` 也会静默返回 `false`。因此"某个静态文件从产物里消失"检测不到。
- **证据**（`missing-static.mjs`，删除基线 `subtitleBar.css` 后 `build --clean`）：

  ```
  === baseline static file deleted (subtitleBar.css) ===
    exit=0
    mentions INCOMPLETE: false
    build: 10/10 bundles byte-identical to baseline
    dist has subtitleBar.css: false
    => build reports 10/10 while a shipped file silently vanished: true
  ```

  作为对照，**新增**基线文件是能被发现的（`build-behavior.mjs`）：

  ```
  === 4. NEW baseline file that build does not know about ===
    exit=1 mentions INCOMPLETE: true
    line: build INCOMPLETE — baseline files missing from dist/: NEW_ASSET.txt
  ```

- **影响**：`manifest.json` 里 `web_accessible_resources` 引用了 `*.css`，缺一个 CSS 会静默降级样式。但因为删除基线文件需要人为操作，且基线是归档只读产物，P2。
- **建议**：把 `STATIC_FILES` 从"手写清单"改为"基线静态文件全集减去显式排除集"，或至少让 `copyFile` 在源缺失时 `fail` 而不是 `return false`。
- **置信度**：确定（实测）

---

### [P2] `reconstruct.mjs` 不校验 BOM，拆分时丢失

- **位置**：`tools/parcel-split.mjs:21-25`（`readBundle` 记录 `bom` 后剥掉）、`tools/parcel-split.mjs:230`（只写进 manifest，从未使用）、`tools/parcel-split.mjs:267`（`verify` 用同样剥掉 BOM 的文本比对）
- **现象**：`bom` 被记录但从未在重组时恢复，`verify` 两侧都剥掉 BOM 所以仍报 `IDENTICAL`。
- **证据**（`bom.mjs`）：

  ```
  === bundle with UTF-8 BOM ===
    manifest.bom            = true
    manifest.bundle_bytes   = 160
    actual file bytes       = 163
    verify().identical      = true
    preamble starts with BOM? false

    reassembled bytes = 160, original = 163
    byte-identical to the ORIGINAL file: false  <-- BOM lost
    verify() said IDENTICAL anyway: true
  ```

  **当前基线全部无 BOM**，故不触发：

  ```
  static/background/index.js         bytes=3209598   BOM=False
  MainCS.277dcde3.js                 bytes=58113     BOM=False
  ...（10/10 均 BOM=False）
  ```

- **影响**：`manifest.bundle_bytes` 与实际文件大小不一致（本例 160 vs 163），任何依赖该字段的判断都会错。当前基线不触发，P2。
- **建议**：`verify` 应比对原始 `Buffer`（含 BOM）而非剥离后的文本；`build` 输出时若 `manifest.bom` 为真则写回 BOM。或者直接删掉 `bom` 字段以免误导。
- **置信度**：确定（实测）

---

### [P3] `modules.json` 的 `dependencies` 字段大面积错误，且 `docs/navigation.md` 把它当作权威

- **位置**：`tools/parcel-split.mjs:239-243`（对整个 `register(...)` 调用文本做 `\[\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\]` 全局扫描）、`tools/parcel-split.mjs:250`（写入 `dependencies`）
- **现象**：Parcel 的依赖映射是 `register` 的第三个参数；但提取逻辑对**整个调用**（含函数正文）做正则扫描，正文里任何 `["a","b"]` 形式的字符串数组都会被当成依赖。同时真正位于第三个参数的依赖表如果形如 `{id:[req,id]}`，其键值对也不会被正确配对。
- **证据**（`deps.mjs` / `deps4.mjs`）：

  ```
  === dependency extraction ===
    module deps reported: [
      {"request":"request-a","id":"id-a"},
      {"request":"request-b","id":"id-b"},
      {"request":"request-a","id":"id-a"}
    ]
    -> expected only the trailing dep map; body pairs should NOT appear
  ```

  真实数据：

  ```
  === modules.json `dependencies` vs actual require calls ===
    total entries in modules.json : 1206
    total real intra-bundle requires: 447
    modules with a wrong count    : 184 / 240
  ```

  误报样本（把 secp256k1 的十六进制常量当成了模块依赖）：

  ```
  static/background/index.js/6GCjZ: {"request":"188da80e b03090f6 7cbf20eb 43a18800 f4ff0afd 82ff1012","id":"07192b95 ffc8da78 631011ed 6b24cdd5 73f977a1 1e794811"}
  ```

- **影响**：`tools/format.mjs:118-119` 用 `dependencies` 生成 readable 视图的文件头注释（"deps: ..."），所以 `src/readable/` 里的依赖列表是错的。`docs/navigation.md:179` 明确要求"若某模块新增了对另一模块的 `C("id")` 引用，`modules.json` 里的 `dependencies` 需要更新" —— 但该字段本身 184/240 是错的，这条指引无法执行。不影响字节完整性（`build` 不使用该字段）。
- **建议**：用 `findModules` 拿到的 `fnEnd` 定位 `register` 的第三个参数，只在该参数范围内提取依赖；或直接改为统计正文中 `<requireVar>("<id>")` 的调用（这正是 Parcel 的 `require` 重写形态，实测 447 处）。同时修正 `docs/navigation.md:179`。
- **置信度**：确定（1206 vs 447，184/240 模块计数不符）

---

### [P3] `build.mjs` 的 `STATIC_FILES` 与 `STATIC_DIRS` 语义重叠，`tabs/` 被复制两次

- **位置**：`tools/build.mjs:31`（`"tabs/tab-main.html"` 在 `STATIC_FILES` 里）、`tools/build.mjs:41`（`STATIC_DIRS = ["tabs"]`）、`tools/build.mjs:160-166`
- **现象**：`tabs/tab-main.html` 先在 `STATIC_FILES` 循环里复制一次，再在 `STATIC_DIRS` 循环里复制一次。`copied` 计数因此虚高。
- **证据**：

  ```
  $ node tools/build.mjs
  static: 19 files copied
  ```

  实际 `dist/` 有 19 个静态文件 + 10 个 bundle = 29 个文件，但 `STATIC_FILES` 只有 16 项、`tabs/` 下有 3 个文件（html/js/css），16 + 3 = 19 —— 其中 `tab-main.html` 被计了两次，`tab-main.1e0435ca.js` 又被 bundle 步骤覆盖写了一次。所以"19 files copied"是重复计数的结果。
- **影响**：仅日志数字误导（`copied` 与实际去重文件数不符），不影响产物。
- **建议**：从 `STATIC_FILES` 移除 `"tabs/tab-main.html"`，或改用 Set 去重后统计。
- **置信度**：确定（计数推导与文件清单核对）

---

### [P3] `overlay.mjs` 的 `listOverlays` 不区分文件名大小写，也不校验 id 是否存在

- **位置**：`tools/overlay.mjs:61-73`（`listOverlays`）
- **现象**：`listOverlays` 把 `src/overlay/<bundle>/` 下所有 `.js` 都当作有效 overlay，不检查 id 是否在 `modules.json` 中。`build.mjs` 同理：它遍历 manifest 找 overlay，因此一个 id 拼错或已废弃的 overlay 文件会被**完全忽略**，`adopt --list` 却仍显示它。
- **证据**（`stale-overlay.mjs`）：

  ```
  === stale overlay for a module no longer in the manifest ===
    build exit=0
    dist contains DELETEDID: false
    build output mentions it: false
    adopt --list shows it: true
  ```

- **影响**：开发者以为自己改了某个模块，实际构建完全没用它，且没有任何提示。这是"改了没生效"的典型静默失败。
- **建议**：`build.mjs` 在 `reassembleBundle` 之后，用 `listOverlays(ROOT)` 减去本次实际用到的 overlay 集合，把差集打印为警告（"these overlay files were ignored: ..."）。
- **置信度**：确定（实测）

---

### [P3] `readOverlayBody` 的 `trimEnd()` 会改写 overlay 的尾部空白，与"overlay 是普通源码"的定位不符

- **位置**：`tools/overlay.mjs:92`
- **现象**：overlay 是开发者手写的普通 JS，但构建时会 `trimEnd()`。若正文尾部有对语义有影响的空白（例如模板字符串的收尾换行、`//` 注释，见前述 P1），行为会与"直接运行该文件"不同。
- **证据**（`strip-header.mjs`）：

  ```
  === readOverlayBody trims trailing whitespace ===
    in : "/* hdr */\nvar x = 1;   \n\n\n"
    out: "var x = 1;"
  ```

- **影响**：与前述 P1（行注释吞逗号）同源。单独看只是"不必要地改写输入"。
- **建议**：去掉 `trimEnd()`，改为保证拼接时插入换行（见 P1 建议）。overlay 的内容应当**原样**进入产物。
- **置信度**：确定（实测）

---

### [P3] `reconstruct.mjs` 在 `--verify` 之外不报告任何 reassembly 结果，`reassembly_verified: null` 会写入 index

- **位置**：`tools/reconstruct.mjs:260`（`reassembly_verified: verify ? output.includes("IDENTICAL") : null`）、`tools/reconstruct.mjs:270`（只在 `--verify` 分支检查）
- **现象**：`npm run split`（不带 `--verify`）会把 `reassembly_verified: null` 写进 `index.json`，覆盖掉之前 `--verify` 得到的 `true`。之后若有人看 `index.json` 判断状态，会看到 `null`。
- **证据**：`index.json` 当前 10 项均为 `true`（因为最后一次运行带 `--verify`），但 `npm run split` 会全部改成 `null`。
- **影响**：状态字段不可靠。P3。
- **建议**：不带 `--verify` 时不要写该字段（或写 `"not-run"` 而非 `null`），或者干脆让 `split` 总是带 `--verify`。
- **置信度**：较高（读代码 + 观察到 index 字段语义）

---

### [P3] 两处括号匹配器功能重复，约 60 行重复代码

- **位置**：`tools/parcel-split.mjs:121-159`（`matchParen`）与 `tools/reconstruct.mjs:163-200`（`matchBracket`）
- **现象**：两个函数做同一件事（跳过字符串/模板/注释并配平括号），但行为不一致（一个有正则处理、一个没有）。已在 P1 中报告其行为后果，此处仅记代码重复。
- **影响**：修一处不会修另一处，是本层假阳性的根因。
- **建议**：合并为单一实现并导出复用。
- **置信度**：确定

---

## 已确认无问题的部分

以下各项我都用**独立于工程工具**的方式实测过，确认正常。

1. **`dist/` 与 `assets/baseline/` 逐字节一致（27/27 共有文件）。** 我自己写脚本遍历两棵树、用 `Buffer.equals` 比对，不调用工程任何代码：

   ```
   === FILE SET DIFF ===
   baseline files: 28  dist files: 27
   only in baseline: [ '_metadata/verified_contents.json' ]
   only in dist    : []

   === BYTE COMPARE (all common files) ===
   identical: 27, differing: 0
   ```

   唯一缺的 `_metadata/verified_contents.json` 是已知限制（商店签名文件），符合 `build.mjs:71` 的 `BASELINE_EXCLUDED`。

2. **10/10 bundle 的 SHA-256 与基线一致。** 独立计算：

   ```
   OK   static/background/index.js       base=3209598 dist=3209598 sha=0b13b37594fd946c
   OK   MainCS.277dcde3.js               base=58113   dist=58113   sha=1e369e3ef8b6ad9c
   OK   IFrameCS.26275720.js             base=86581   dist=86581   sha=271798c6cddbd247
   OK   YoutubeCS.6bf33c81.js            base=23753   dist=23753   sha=9fbb0b768d681baf
   OK   WebappCS.8b5d7cd6.js             base=19903   dist=19903   sha=4c0f22559c8faa47
   OK   Main.00175a8f.js                 base=4744475 dist=4744475 sha=fd6557596e95f849
   OK   SubtitleBar.f2dae354.js          base=820195  dist=820195  sha=68f8c6a837839ccb
   OK   sidepanel.65d86198.js            base=4534425 dist=4534425 sha=4c38a03b50b777c1
   OK   options.6406b895.js              base=871699  dist=871699  sha=dd4dcf668c798ed9
   OK   tabs/tab-main.1e0435ca.js        base=4534418 dist=4534418 sha=d4995815d047ee0a
   ```

3. **从 `src/bundles/` 独立重组 10/10 与基线字节相同。** 自己按 `preamble + Σ(去首行正文 + separator_after) + epilogue` 拼接，不调用 `verify()`：

   ```
   OK   static/background/index.js       modules= 16 bytes=3209598/3209598 sha_match=true
   OK   MainCS.277dcde3.js               modules=  1 bytes=58113/58113   sha_match=true
   OK   IFrameCS.26275720.js             modules=  6 bytes=86581/86581   sha_match=true
   OK   YoutubeCS.6bf33c81.js            modules=  1 bytes=23753/23753   sha_match=true
   OK   WebappCS.8b5d7cd6.js             modules=  1 bytes=19903/19903   sha_match=true
   OK   Main.00175a8f.js                 modules= 60 bytes=4744475/4744475 sha_match=true
   OK   SubtitleBar.f2dae354.js          modules= 16 bytes=820195/820195  sha_match=true
   OK   sidepanel.65d86198.js            modules= 60 bytes=4534425/4534425 sha_match=true
   OK   options.6406b895.js              modules= 19 bytes=871699/871699  sha_match=true
   OK   tabs/tab-main.1e0435ca.js        modules= 60 bytes=4534418/4534418 sha_match=true
   total modules: 240
   ```

4. **240 个模块每一个都是可独立解析的合法表达式。** 用 `node --check`（V8 解析器）作为 oracle，而不是工程自己的括号匹配器：

   ```
   $ node syntax-check.mjs
   modules checked: 240, syntax failures: 0
   ```

   这一条正是 `verify()` **缺失**的校验，也是我判定"当前切分实际正确"的依据。

5. **模块边界与 `register` 调用一一对应，无漏切无多切。** 对每个模块文件，断言正文中恰好出现一次 `.register("<manifest id>"`，且 id 与文件名一致；同时把基线里所有 `.register("id"` 的 id 集合与 manifest 比对：

   ```
   static/background/index.js       manifest= 16 baselineRegisterIds= 16 missing=[] extra=[]
   MainCS.277dcde3.js               manifest=  1 baselineRegisterIds=  1 missing=[] extra=[]
   IFrameCS.26275720.js             manifest=  6 baselineRegisterIds=  6 missing=[] extra=[]
   YoutubeCS.6bf33c81.js            manifest=  1 baselineRegisterIds=  1 missing=[] extra=[]
   WebappCS.8b5d7cd6.js             manifest=  1 baselineRegisterIds=  1 missing=[] extra=[]
   Main.00175a8f.js                 manifest= 60 baselineRegisterIds= 60 missing=[] extra=[]
   SubtitleBar.f2dae354.js          manifest= 16 baselineRegisterIds= 16 missing=[] extra=[]
   sidepanel.65d86198.js            manifest= 60 baselineRegisterIds= 60 missing=[] extra=[]
   options.6406b895.js              manifest= 19 baselineRegisterIds= 19 missing=[] extra=[]
   tabs/tab-main.1e0435ca.js        manifest= 60 baselineRegisterIds= 60 missing=[] extra=[]

   module/id correspondence problems: 0
   ```

6. **`reconstruct.mjs` 是幂等的、确定性的。** 连续两次 `reconstruct --verify`，`src/bundles/` 全树哈希不变，`index.json` 也不变：

   ```
   tree1: fe081d869d3f2c853a384bba52a818ec
   all bundles reassemble byte-for-byte
   tree2: fe081d869d3f2c853a384bba52a818ec
   ```

7. **`build.mjs` 确实以 `src/bundles/` 为 bundle 来源，而不是直接复制基线。** 在模块正文追加哨兵后构建，哨兵出现在 `dist/` 里，且报告 `9/10`：

   ```
   === build with a hand-edited split module (no overlay) ===
     build exit=0
     report.matches_baseline=false  overlays=[]
     sentinel in dist? true
     dist == baseline? false  (dist 19921B vs baseline 19903B)
     summary: build: 9/10 bundles byte-identical to baseline
     warning line: modified (expected while editing): WebappCS.8b5d7cd6.js
   ```

8. **overlay 优先级正确：只有模块、只有 preamble、只有 epilogue、两者都有，四种组合都对。** 逐个构造 overlay 文件后构建，产物均与基线一致（因为 overlay 内容就是原模块，只是加了头部注释），且 `overlaid_modules` 正确记录：

   ```
   === A. no overlay (control) ===        report overlays=[]                      10/10
   === B. preamble overlay only ===       report overlays=["preamble"]            10/10
   === C. epilogue overlay only ===       report overlays=["epilogue"]            10/10
   === D. preamble + epilogue ===         report overlays=["preamble","epilogue"] 10/10
   === E. module hZnCo only ===           report overlays=["hZnCo"]                10/10
   === F. module hZnCo + epilogue ===     report overlays=["epilogue","hZnCo"]    10/10
   ```

   优先级"overlay 覆盖 split"也已验证：给 `MainCS` 的唯一模块加 marker，marker 进入 `dist/`（`58113 → 58130` B），删除 overlay 后 `dist/` 恢复基线（`58130 → 58113` B，回到 `10/10`）。

9. **overlay 的 BOM 与"无 provenance 头"都不会破坏产物。** BOM 版 overlay 构建后仍与基线一致（`stripOverlayHeader` 先剥 BOM 再剥注释）；没有 provenance 头的 overlay 也能正常拼接（代价是首段代码注释被吞，见 P1）。

10. **手改检测在索引完好时工作正常。** 编辑 epilogue、编辑模块正文，均被拒绝并指名文件，手改内容保留在磁盘上：

    ```
    === 1. hand-edit epilogue.js (append statement) ===
      exit=1 refused=true  named: ["static__background__index/epilogue.js"]
    === 2. hand-edit a module body ===
      exit=1 refused=true  named: ["static__background__index/hZnCo.js"]
    ```

11. **CRLF 化的 `src/bundles/` 会被手改检测拦下（安全方向）。** 模拟 git `core.autocrlf=true` 检出后，`verify` 拒绝并列出 20 个文件，不会静默重切：

    ```
    === npm run verify after a CRLF checkout ===
      exit=1
      refused=true
      files named as "edited": 20
    ```

    这是**假阳性**（内容语义没变），但方向安全 —— 没有数据丢失。反过来，工程目前**没有 `.gitattributes`**（`Test-Path .gitattributes` → `False`），一旦纳入 git 且开发者在 Windows 上检出，会稳定触发。这一点与 L1 的字节完整性直接相关，建议在 `src/bundles/**` 上声明 `-text`（禁止行尾转换）。

12. **`build --clean` 会清掉 `dist/` 的陈旧文件；不带 `--clean` 则保留。** 符合预期：

    ```
    === 2. stale file in dist survives a non-clean build? ===
      after build (no --clean): stale file present = true
      after build --clean:      stale file present = false
    ```

13. **`build.mjs` 会把 `build-report.json` 写到项目根而非 `dist/`**（`build.mjs:205`），符合 known-issues #12。

14. **删除 overlay 后 `dist/` 会干净回退**，无残留（见第 8 条）。

15. **`reconstruct` 在干净的 `src/bundles/` 上重复运行不改动 `index.json`**（`Get-FileHash` 前后一致）。

## 未覆盖的范围

- **`tools/package.mjs` / `tools/browser-verify.mjs` / `tools/check.mjs` 的完整审查**属于 L4 范围。我只为了判定 L1 发现的影响面而读了 `check.mjs` 的脚本覆盖逻辑，未审查其打包、清理、Chrome 进程管理。
- **`tests/*.mjs` 的有效性**属于 L2 范围。我只运行了 `tests/overlay.check.mjs`、`tests/edit-safety.check.mjs`、`tests/bundles.load.mjs` 作为旁证，未评估其断言强度。
- **`tools/format.mjs` / `tools/adopt.mjs` / `tools/audit.mjs` / `tools/index-symbols.mjs`** 不在 L1 范围。我在追查 `dependencies` 字段的消费方时读了 `format.mjs:118-119`，未审查其格式化正确性。
- **`src/readable/` 的内容正确性**未验证（它是派生视图）。`dependencies` 字段的错误意味着 readable 里的 `deps:` 注释不可信，但我没有逐文件核对 readable 与 bundle 的对应关系。
- **未在真实 Chrome 中加载 `dist/`**。我只用 `new vm.Script` / `new Function` 做了语法级校验，没有验证扩展的实际运行行为（属 L4）。
- **未测试并发**：两个 `build.mjs` 同时写 `dist/` 或两个 `reconstruct.mjs` 同时写 `src/bundles/` 的行为未验证（属 L5）。
- **未测试 `assets/baseline/` 只读/权限受限**时的行为。
- **`src/bundles/index.json` 里的 `split_dir` 使用反斜杠**（`"src\\bundles\\static__background__index"`）。我实测在把分隔符改成 POSIX 风格后 `build` 与 `reconstruct` 仍能正常工作（`path.join` 会规范化），所以**不是**跨平台缺陷，但该字段依赖 `path.join` 的宽容行为，未在 Linux/macOS 上实机验证。

## 附：复现脚本

所有临时脚本在 `C:\Users\A2134\AppData\Local\Temp\l1review\`（用完可删）。需要项目副本的脚本使用 `C:\Users\A2134\AppData\Local\Temp\l1proj`（由 `robocopy` 从真实工程复制，**不修改原工程**）。

| 脚本 | 对应发现 |
| --- | --- |
| `verify-independent.mjs` | 已确认 #1、#2 |
| `reassemble-independent.mjs` | 已确认 #3 |
| `syntax-check.mjs` | 已确认 #4 |
| `boundary-oracle.mjs` | 已确认 #5 |
| `collapse.mjs`、`tautology.mjs`、`tautology2.mjs` | P0 `verify()` 恒真 |
| `edit-detect3.mjs` | P0 手改检测静默失效 |
| `overlay-broken.mjs`、`pipeline-catch.mjs` | P1 build 退出码 0 |
| `check-coverage2.mjs`、`unchecked-bundle.mjs` | P1 check 覆盖缺口 |
| `build-baseline-drift.mjs` | P1 基线漂移 |
| `span-compare.mjs`、`fp-proof.mjs`、`last-module-all.mjs` | P1 匹配器分歧与假阳性 |
| `strip-header.mjs` | P1/P3 注释被吞、trimEnd |
| `line-comment-comma.mjs`、`preamble-comment.mjs` | P1 行注释吞分隔符 |
| `e1-register-forms.mjs`、`e2e-clean.mjs` | P2 未识别形态静默吞并 |
| `fuzz-regex.mjs`、`incdec.mjs`、`hazard-scan.mjs` | P2 正则/除号判别 |
| `matchbrace2.mjs` | P2 matchBrace |
| `encoding-path.mjs` | P2 首行契约与 UTF-8 |
| `missing-static.mjs`、`build-behavior.mjs` | P2 静态文件删除 |
| `bom.mjs` | P2 BOM 丢失 |
| `deps.mjs`、`deps4.mjs` | P3 dependencies 字段 |
| `stale-overlay.mjs` | P3 无效 overlay 静默忽略 |
| `overlay-3.mjs`、`overlay-remove.mjs` | 已确认 #8 |
