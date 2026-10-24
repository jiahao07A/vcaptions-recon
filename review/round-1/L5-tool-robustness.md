# 工具健壮性（L5）审查报告

审查者：L5-tool-robustness subagent
审查范围：`tools/adopt.mjs`、`tools/format.mjs`、`tools/index-symbols.mjs`、`tools/audit.mjs`、`tools/parcel-split.mjs`（仅健壮性），以及全部工具的共用问题（参数解析、路径、编码、退出码、幂等、资源）
审查时间：2026-10-21T11:30:00Z
环境：Windows 10.0.26200、Node v26.5.0、PowerShell 5.1、非 git 仓库

> 说明：所有破坏性实验都在 `C:\Users\A2134\AppData\Local\Temp\l5\proj`（`robocopy` 复制，排除 `.cursor`/`.omp`/`review`/`release`）中进行，**未修改真实工程**。真实工程只做了只读核对与一次 `node -e` 计算。`src/bundles/`、`src/overlay/`、`dist/` 的写入全部发生在副本里。
>
> 与 L1/L2/L3 的边界：L1 已报的 `verify` 恒真、`index.json` 缺失/损坏时静默放行、`build` 对无效产物 exit 0、`check` 不解析 4 个 bundle、`matchBracket` 不一致、`stripOverlayHeader` 吞注释、overlay 尾部 `//` 吞分隔符，本报告**不重复**。凡是与已报条目相邻的，我标注为"已知问题的延伸"并说明新增证据。

## 结论摘要

**这 11 个工具在"正常输入"下是可靠的（10/10 构建、240 模块拆分、路径含空格/中文/超长、UTF-8 输出无 BOM 都实测通过），但对"操作者的一次手误"几乎没有防御：两个 P0 都是"一个很自然的动作静默毁掉已有产物"——`adopt` 会无提示覆盖你改过的 overlay，而 `npm run all` 在全新克隆上会先跑 `audit`（此时 `dist/` 还不存在）把已提交的事实文件清零。** 其次是参数解析：`format --bundle` 拼错会先删掉整棵 `src/readable/` 再报 `0/0 bundles formatted` 并 exit 0，把 `docs/symbol-index.*` 一起清空。整体上，退出码的语义是"进程没崩"，而不是"结果是对的"。

## 发现

### [P0] `adopt` 无条件覆盖已存在的 overlay，用户的编辑被静默丢弃

- **位置**：`tools/adopt.mjs:113`（`fs.writeFileSync(dest, header + formatted, "utf8")`）、`tools/adopt.mjs:152`（fragment 版本）、`tools/adopt.mjs:96-98`（目标路径计算）
- **现象**：`adoptOne` / `adoptFragment` 直接 `writeFileSync` 到 `src/overlay/<bundle>/<id>.js`，**不检查文件是否已存在**，也没有 `--force` / `--overwrite` 开关。对同一个模块再跑一次 `adopt`，overlay 被重新格式化后的原始压缩模块覆盖，之前的编辑全部丢失，输出仍是 `adopted ...` + `exit 0`。`--all` 路径（`adopt.mjs:229`）同样如此，而且它是"批量重跑"这一最自然的动作。

  ```96:98:tools/adopt.mjs
    const destDir = path.join(overlayRoot(ROOT), bundleDir);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${moduleId}.js`);
  ```
- **证据**：

  ```
  === T7: adopt twice (overwrite existing overlay?) ===
  adopted WebappCS.8b5d7cd6/hEvvs
    src\overlay\WebappCS.8b5d7cd6\hEvvs.js  (from 9523 minified bytes)
  hash1=43568D65E39C413CB324E2F22E82837BC75109973508B867659401393F91B24C
  appended edit
  adopted WebappCS.8b5d7cd6/hEvvs
  exit=0
  hash2=43568D65E39C413CB324E2F22E82837BC75109973508B867659401393F91B24C
  edit survived: False
  ```

  `--all` 与 fragment 两条路径同样：

  ```
  === A. adopt --all with existing edited overlays: full output ===
    exit=0
    stdout: "adopted MainCS.277dcde3/hEvvs\n\n1 adopted, 0 skipped\n"
    hand edit survived: false

  === T8: adopt --epilogue twice ===
  adopted static__background__index/epilogue -> src\overlay\static__background__index\99-epilogue.js
  adopted static__background__index/epilogue -> src\overlay\static__background__index\99-epilogue.js
  edit survived: False
  ```

  注意 `--all` 的输出是 `1 adopted, 0 skipped`——它把"覆盖"报告成"adopted"，没有任何措辞暗示原有内容被替换。
- **影响**：`src/overlay/` 是本工程唯一被声明为"真实源码改动所在"的目录（`.gitignore` 里 `!src/overlay/`，注释写"adopted, editable modules (real source changes live here)"）。`adopt` 是这个目录的**唯一写入口**，因此它是本层最容易丢工作的地方。触发场景极其平常：读者按 `README.md:126-135` 的"推荐工作流"再走一遍、或想 adopt 同 bundle 的第二个模块时顺手 `--all`。丢失后没有任何痕迹——overlay 内容回到格式化后的原始模块，`build` 会正常报 `9/10`，看起来"overlay 还在生效"。
- **建议**：目标文件已存在时默认**拒绝**并 `exit 1`，提示"`src/overlay/<bundle>/<id>.js` 已存在（N 字节，mtime ...）；用 `--force` 覆盖，或先把它移到别处"。`--all` 应把已存在的模块计入单独的 `existing` 计数并打印（`16 adopted, 3 existing (unchanged), 0 skipped`），而不是静默重写。若担心"重新 adopt 以获得最新格式化结果"是合法需求，那也应由显式 `--force` 表达。
- **置信度**：确定（模块、fragment、`--all` 三条路径均实测；覆盖后哈希完全一致，可证明内容被替换而非合并）

---

### [P0] `npm run all` 在全新克隆上先跑 `audit` 再跑 `build`，把已提交的事实文件清零

- **位置**：`package.json:32`（`"all": "npm run verify && npm run format && npm run audit && npm run index && npm run build && ..."`）、`tools/audit.mjs:55-58`（`read()` 把缺失文件返回 `null`）、`tools/audit.mjs:104`（`Object.values(src).filter(Boolean).join("\n")`）
- **现象**：`audit.mjs` 的唯一数据源是 `dist/`（`const DIST = path.join(ROOT, "dist")`），而 `dist/` 在 `.gitignore` 里、全新克隆上不存在。`read()` 对每个缺失文件返回 `null`，`src` 全为 `null`，于是所有提取结果都是 0，但脚本**照常写出 `docs/architecture.generated.json` 并 exit 0**。`npm run all` 的顺序是 `verify → format → audit → index → build`，即 `audit` 早于 `build`，所以在没有 `dist/` 的树上跑一次 `npm run all`，会用一个全零的事实文件覆盖已提交的那份。

  ```55:58:tools/audit.mjs
  function read(rel) {
    const abs = path.join(DIST, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  }
  ```

  ```32:32:package.json
      "all": "npm run verify && npm run format && npm run audit && npm run index && npm run build && npm run check && npm run test",
  ```
- **证据**（副本里删掉 `dist/` 与 `src/readable/`，模拟全新克隆，然后跑 `npm run all`）：

  ```
  before 1st run: handlers=158 keys=14 endpoints=25 indexEntries=423 indexStorageKeys=14
  run1 exit=1  handlers=0 keys=0 endpoints=0 indexEntries=415 indexStorageKeys=0
  run2 exit=0  handlers=158 keys=14 endpoints=25 indexEntries=423 indexStorageKeys=14
  run3 exit=0  handlers=158 keys=14 endpoints=25 indexEntries=423 indexStorageKeys=14
  ```

  单看 `audit` 更直接：

  ```
  === T14: audit before dist exists ===
  background handlers: 0
  ui handlers:         0
  ...
  storage keys:        0
  endpoints:           0 absolute, 0 SDK paths
  chrome APIs:         0 (0 call sites)
  libraries:
  written docs/architecture.generated.json
  exit=0
  ```

  `audit` 自己的 `bundles` 字段也把每个文件记成 `bytes: null`：

  ```
  bundles: background=null content_main=null content_iframe=null ... tab=null
  ```

  下游 `index` 因此把 storage key 全部跳过，而它的告警词是**误导性的**"missing"（文件存在，只是内容为空）：

  ```
  warning: docs/architecture.generated.json missing; run `npm run audit` first.
           Storage keys will be skipped until then.
  ```
- **影响**：`docs/architecture.generated.json` 与 `docs/symbol-index.json` / `.md` 都是**已提交**的产物（`.gitignore` 只忽略 `dist/`、`release/`、`build-report.json`、`node_modules/`、`src/readable/`）。一次全新克隆后的 `npm run all` 会把它们改写成零值版本，然后**第二次运行又会恢复正常**（因为第一次的 `build` 已经生成了 `dist/`）——所以这个损坏对"再跑一次看看"的人是隐形的，对"跑一次就提交"的人是灾难性的。`npm run ci`（`verify → build → ...`）顺序正确，说明这是 `all` 独有的顺序缺陷，不是有意设计。叠加 `docs/navigation.md:11` 直接引用"14 个存储键"，清零后的文档会给出一个完全错误的事实基准。
- **建议**：(1) `audit.mjs` 在 `dist/` 缺失或任一 `SOURCES` 文件缺失时 **fatal**（`exit 2`，提示 `run npm run build first`），不要写半成品；(2) 把 `audit` 移到 `build` 之后，即 `verify → format → build → audit → index → check → test`；(3) `audit` 输出里加一个 `sources_present: N/10` 字段，让下游能判断产物是否完整；(4) `index-symbols` 的告警应区分"文件不存在"与"文件存在但键为空"。
- **置信度**：确定（三次连续 `npm run all` 的产物数字已逐次记录，run1 与 run2 的差异可稳定复现）

---

### [P1] `format --bundle` 的取值缺陷：拼错会先清空整棵可读树再报成功

- **位置**：`tools/format.mjs:139-140`（取值）、`tools/format.mjs:149`（`rmrf(READABLE)`）、`tools/format.mjs:153-155`（过滤后才开始格式化）
- **现象**：`--bundle` 的过滤发生在**删除之后**。`only` 取值有两种失效方式：(a) 拼错/不存在的 bundle 名 → 过滤掉全部 10 个 → 目录已被清空、一个文件都没写 → 输出 `0/0 bundles formatted`、`exit 0`；(b) 参数在末尾没有值（`--bundle` 后面什么都没有）→ `only = undefined` → 条件为假 → **静默格式化全部 10 个**，与操作者意图相反；(c) 等号形式 `--bundle=Main` 不被识别 → 同样静默格式化全部。

  ```139:140:tools/format.mjs
    const flagIndex = process.argv.indexOf("--bundle");
    const only = flagIndex !== -1 ? process.argv[flagIndex + 1] : null;
  ```
  ```149:155:tools/format.mjs
    rmrf(READABLE);
    fs.mkdirSync(READABLE, { recursive: true });

    const results = [];
    for (const entry of index.bundles) {
      const name = path.basename(entry.split_dir);
      if (only && !name.includes(only)) continue;
  ```
- **证据**：

  ```
  ### E1 format --bundle <typo>
    stdout: "0/0 bundles formatted\noutput: src/readable/"
    exit=0
    readable subdirs: 0
    readable/index.json bundles: 0
    index exit=0 out="bundles scanned: 0"
    symbol-index entries: 0
    symbol-index.md bytes: 200
    index warned about an empty tree? false
  ```

  （健康状态下是 `entries=423`、`md=56101B`。）

  ```
  === T10: format --bundle with no value ===
  formatting tabs__tab-main.1e0435ca … ok

  10/10 bundles formatted
  exit=0

  === L. format with --bundle=Main (equals form) ===
    exit=0 last="10/10 bundles formatted | output: src/readable/"
  ```
- **影响**：一次手误（`--bundle Yotube`、或把 `--bundle` 放在命令行最后）的后果是整棵 `src/readable/`（261 个文件、约 25 MB）被删除，且 `docs/symbol-index.json` / `.md` 在下一次 `npm run index` 时被改写成空索引——**两个已提交的文档产物一起归零，退出码 0**。`src/readable/` 本身是派生目录（可重建，代价约 9 秒），所以真正的损失是 `docs/symbol-index.*`。另外 (b)/(c) 两种情形会让人以为"只格式化了这一个 bundle"，实际全量重写了 10 个，在排查"为什么别的 bundle 也变了"时会产生误判。
- **建议**：(1) 先解析并**校验** `only`（`index.bundles` 里没有任何 `name.includes(only)` 时 `exit 2` 并列出可用名），再 `rmrf`；(2) `--bundle` 缺少值时 `exit 2`（用 `flagIndex + 1 < argv.length` 判断，且值不能以 `-` 开头）；(3) 支持 `--bundle=<value>`；(4) 更稳妥的做法是不删整棵树，只删本次要写的 bundle 子目录。
- **置信度**：确定（三种取值方式均实测，空索引与 200 字节 md 已核对）

---

### [P1] `format` 的 raw fallback 会让 `index-symbols` 对该 bundle 几乎失明，全链路无告警

- **位置**：`tools/format.mjs:58-62`（`formatBundle` 捕获异常返回 `null`）、`tools/format.mjs:84-92`（fallback 写原始压缩部件）、`tools/index-symbols.mjs:141-143`（>400 字符的行被跳过）
- **现象**：当 Prettier 无法解析某个 bundle（语法形态变化、文件损坏、编码问题），`format` 把该 bundle 的每个模块**原样**（压缩后的单行）写进 `src/readable/`，只打印一行 `! <bundle>: bundle format failed, emitting raw parts`，然后计入 `0/N bundles formatted` 并 **exit 0**。由于 `index-symbols` 会跳过长度 >400 字符的行，而压缩模块整个就是一行，该 bundle 在符号索引里几乎完全消失。`index-symbols` 不做任何检查、不读 `readable/index.json` 的 `formatted` 标志、也不告警。
- **证据**（把基线 `sidepanel` 末尾加 `)(` 使 Prettier 解析失败）：

  ```
  ### E2 format raw fallback
    stdout: "formatting sidepanel.65d86198 … raw fallback | 0/1 bundles formatted | output: src/readable/"
    exit=0
    index exit=0 sidepanel entries=2 total=2
    index mentioned the fallback? false
  ```

  （健康状态下该 bundle 贡献 217 个条目、全树 423 个；fallback 后只剩 2 个，全树 2 个。）

  同一现象在 `Main`（最大 bundle）上同样成立：

  ```
  === 3. force the 60-module app bundle into raw fallback, then index ===
    before: sidepanel entries=217, total=423
    format exit=0 | "0/1 bundles formatted | output: src/readable/"
    index exit=0 | sidepanel entries=2 (was 217)
    index warned about the unformatted bundle: false
    readable/index.json formatted flags: false
  ```
- **影响**：这是"派生视图静默降级"的典型形态。`format` 的 `0/N bundles formatted` 是唯一的信号，而 `npm run all` 里它只是 10 行输出中的一行，之后 `index` 会把索引写成一个"看起来很完整、只是少了 95% 内容"的文件。对一个用途是"回答某个功能在哪实现"的工具，这种退化比报错更糟：读者搜不到 `sidepanel` 的处理器，会以为该功能不在这个 bundle 里。当前基线 10/10 都能格式化，所以这是**潜在**缺陷；但它一旦触发（例如基线升级到 Prettier 不支持的语法），不会有人注意到。
- **建议**：(1) `format` 在 fallback 发生时把该 bundle 记入 `readable/index.json` 的 `formatted: false`（已有该字段）**并在退出时 `exitCode = 1`**，或至少把 `! ...` 警告提升为显式 `WARN` 汇总；(2) `index-symbols` 读 `readable/index.json`，对 `formatted: false` 的 bundle 打印"该 bundle 以压缩形态存在，索引覆盖不完整"；(3) 索引输出里记录 `bundles_scanned` 与 `bundles_expected`（后者取自 `src/bundles/index.json`），不相等即告警。
- **置信度**：确定（两条独立路径均实测，217→2 的落差已记录）

---

### [P1] `audit` 把缺失或截断的 `dist/` 文件当作空内容，输出零值报告并 exit 0

- **位置**：`tools/audit.mjs:55-58`（`read`）、`tools/audit.mjs:104`（`filter(Boolean)` 把 `null` 当空串）、`tools/audit.mjs:188`（无条件写文件）
- **现象**：与上一条 P0 同源，但独立成条，因为它是**工具本身**的行为而不是流水线顺序：只要 `dist/` 里任何一个 `SOURCES` 文件缺失或异常短，`audit` 就静默按"该 bundle 没有任何内容"统计，写出一个**内部自洽但完全错误**的 JSON，exit 0。
- **证据**（把 `dist/static/background/index.js` 截断到 1000 字节）：

  ```
  ### E4 audit on a truncated dist bundle
    exit=0
    background handlers: 0
    ui handlers:         31
    content handlers:    34
    all handlers (union):65
    bundles.background.bytes=1000 (real 3209598)
    any warning about a short/invalid bundle? false
  ```

  与健康状态（`97 / 31 / 34 / 158`）相比，后台层从 97 掉到 0，而总计数变成 65——一个**任何文档都没有引用过**的数字，却会被写进 `docs/architecture.generated.json` 并被 `consistency.check` 当作事实基准的一部分。
- **影响**：`audit` 自称"从产物里提取事实"，但它无法区分"产物里确实没有"和"我没读到产物"。任何导致 `dist/` 不完整的原因（`build` 失败、`--clean` 后中断、有人手工删了文件、磁盘写满）都会产出一份看似正常的假事实文件。因为 `bundles.<name>.bytes` 字段已经记录了实际读取的字节数，这个信息是**存在但未被使用**的。
- **建议**：对每个 `SOURCES` 条目，把 `bytes` 与 `src/bundles/index.json` 的 `baseline_bytes`（或 `assets/baseline/` 的实际大小）比对；缺失或偏差超过阈值即 `fail` 并 `exit 1`。至少要在 `dist` 文件缺失时打印 `WARN` 而不是静默 `null`。
- **置信度**：确定（截断场景实测；`bytes: 1000` 与真实 3209598 的对比已记录）

---

### [P1] `reconstruct` 在基线文件缺失时静默把整个 bundle 从索引里摘掉

- **位置**：`tools/reconstruct.mjs:240-245`（`if (!fs.existsSync(abs)) { console.warn("  skip (missing)"); continue; }`）、`tools/reconstruct.mjs:262`（`index.bundles.push` 只在存在时执行）
- **现象**：`BUNDLES` 是硬编码的 10 项清单。任一项在 `assets/baseline/` 里不存在时，`reconstruct` 打印一行 `skip (missing): <file>` 就 `continue`，最终写出只有 9 个条目的 `index.json`，并打印 `9 bundles, 239 modules` / `all bundles reassemble byte-for-byte`，**exit 0**。之后 `build` 按 9 个条目构建，报 `9/9 byte-identical`，`check` 报 `check passed`。
- **证据**：

  ```
  ### E3 reconstruct with a missing baseline bundle
    exit=0
    stdout:
      9 bundles, 239 modules -> src\bundles
      all bundles reassemble byte-for-byte
    index.bundles=9 baseline_files=static/background/index.js,MainCS.277dcde3.js,IFrameCS.26275720.js,WebappCS.8b5d7cd6.js,Main.00175a8f.js,SubtitleBar.f2dae354.js,sidepanel.65d86198.js,options.6406b895.js,tabs/tab-main.1e0435ca.js
    build: build: 9/9 bundles byte-identical to baseline
    check: check passed (exit 0)
  ```

  注意 `YoutubeCS.6bf33c81.js` 从清单里消失了，而 `9/9` 这个分数**比 `10/10` 更看不出问题**——分母跟着分子一起变小了。
- **影响**：一个基线 bundle 被误删/改名/复制不完整时，产物会少一个内容脚本，而三道门（`reconstruct --verify`、`build`、`check`）全部绿灯。`build.mjs` 的 `findOmittedBaselineFiles` 本该兜住，但它以 `walkFiles(BASELINE)` 为遍历源——文件既然已经不在基线里，就不会出现在遍历结果中（这一点 L1 已在其 P2 中作为"基线文件被删"报告过；此处的新证据是 **`reconstruct` 会把这个缺失固化进 `index.json`**，使后续所有工具都认为"工程只有 9 个 bundle"，而 L1 那条只覆盖了 `build` 端）。
- **建议**：`BUNDLES` 缺失项应视为 fatal（`exit 1`），或至少在 `index.json` 里写入 `missing_bundles: [...]` 并让 `build`/`check` 在非空时失败。同时给 `BUNDLES` 加一个"`index.json` 的条目数必须等于 10"的自检。
- **置信度**：确定（删除基线文件后三道门的输出已完整记录）

---

### [P1] 非 UTF-8 编码的 overlay 不被校验，可穿过 `build` + `check` 进入产物

- **位置**：`tools/overlay.mjs:92`（`fs.readFileSync(file, "utf8")`）、`tools/build.mjs:107-137`（拼接后直接 `writeFileSync(..., "utf8")`）、`tools/build.mjs` 全文（无 `vm.Script`/`new Function` 校验）
- **现象**：`readOverlayBody` 用 `"utf8"` 读取 overlay，Node 会把非法字节替换成 U+FFFD（**不抛错**）。`build` 再把含替换字符的字符串写回，全程无编码校验、无语法校验（后者 L1 已报，此处是**新增的触发路径**）。PowerShell 5.1 的 `>` 重定向默认写 UTF-16LE，`Set-Content` 默认写 ANSI/GBK——都是本工程文档里明确提到过的 Windows 陷阱。
- **证据**（UTF-16LE 写入的 overlay，覆盖 `MainCS` 的唯一模块）：

  ```
  === E. overlay written as UTF-16LE (PowerShell 5.1 default redirection) ===
    build exit=0
    ~ MainCS.277dcde3.js               1 modules     48694 B d214b4013394… [overlay: hEvvs] || build: 9/10 bundles byte-identical to baseline
    check exit=1 | 1 problem(s) found
  ```

  `MainCS` 能被 `check` 抓到（它在 manifest 里）。换成 `sidepanel`——L1 已报告 `check.mjs` 不解析这个 bundle——就完全静默：

  ```
  === 4. UTF-16LE overlay on a bundle check.mjs does NOT parse ===
    build exit=0 | "build: 9/10 bundles byte-identical to baseline"
    check exit=0 | "check passed"
    dist sidepanel bytes=4534889 (baseline 4534425), NUL count=453
    dist parses: NO -> Invalid or unexpected token
  ```

  GBK 字节（`Set-Content` 在中文 Windows 上的默认行为）走的是替换字符路径：

  ```
  === GBK bytes inside the overlay BODY (not the stripped header) ===
    build exit=0 | build: 9/10 bundles byte-identical to baseline
    dist bytes=58146 (baseline 58113)
    dist contains U+FFFD (replacement char)=true
    dist contains the original GBK bytes=false
    check exit=1 | 1 problem(s) found
  ```
- **影响**：一个 453 KB 的 JS 文件里夹 453 个 NUL 字节，`build` 说 `9/10`、`check` 说 `check passed`，而扩展加载后会直接抛语法错误。这与 L1 的 P1（`build` 不校验产物语法）是同一根因，但**新增的证据是：即使有人给 `build` 加上了 `vm.Script` 校验，UTF-16LE 的字节流仍会先被静默转成合法字符串（NUL 是合法 JS 字符）**——所以只加语法校验不够，必须在读取层做编码断言。
- **建议**：`readOverlayBody` 读取后检测 BOM（`FF FE` / `FE FF` / `EF BB BF`）与 U+FFFD，任一出现即抛错并指名文件："overlay 必须是 UTF-8 无 BOM；检测到 UTF-16LE"。同时按 `Buffer` 读取并断言 `buf.toString("utf8")` 往返一致（`Buffer.compare`），这能同时抓住 GBK。
- **置信度**：确定（UTF-16LE 与 GBK 两种编码均实测；`sidepanel` 那条路径的 `check passed` 与 `dist parses: NO` 已同时记录）

---

### [P2] `index-symbols` 接受空或部分的 `src/readable/`，写出空索引并 exit 0

- **位置**：`tools/index-symbols.mjs:211-214`（只检查目录是否存在）、`tools/index-symbols.mjs:227`（`listBundles()` 结果不做数量校验）、`tools/index-symbols.mjs:248`、`:288`（无条件写两个输出）
- **现象**：`main()` 只判断 `src/readable` 是否存在。目录存在但为空（被 `format` 清空、或只格式化了 1 个 bundle、或 `format` 中途崩溃）时，它照常遍历 0 或 N 个目录、写出 `entries: []` 的 JSON 和 200 字节的 md，exit 0，且**不打印任何警告**。
- **证据**：

  ```
  === P. index-symbols on an empty readable tree ===
    exit=0 out="bundles scanned: 0\n  storage_key          0\n ..."
    entries: 0
  ```

  `format` 中途崩溃（删除第 5 个基线文件）后同样：

  ```
  format exit=1
    readable subdirs left: IFrameCS.26275720, Main.00175a8f, MainCS.277dcde3, static__background__index, WebappCS.8b5d7cd6, YoutubeCS.6bf33c81
    readable/index.json exists: false
    index exit=0 out="bundles scanned: 6"
    index entries=201 (was 423)
    index mentioned a missing/partial tree: false
  ```

  注意 `format` 崩溃时**没有写出 `src/readable/index.json`**，但 `index-symbols` 并不读它，所以"树是完整的"这一事实无从判断。
- **影响**：`docs/symbol-index.json` / `.md` 是已提交的导航产物。它们的失效方式是"变小"而不是"报错"，读者只会觉得"搜不到"。与 P1（raw fallback）叠加时，索引可以在完全成功（exit 0）的外观下丢掉 95% 的内容。
- **建议**：`index-symbols` 读 `src/bundles/index.json` 得到期望的 bundle 集合与数量，与实际扫描到的比对；不相等即 `exit 2`（或至少打印 `WARN` 并写 `bundles_expected` 字段）。同时要求 `src/readable/index.json` 存在且 `bundles.length` 与期望一致——这个文件本来就是为了表达"这棵树是完整的"而存在的。
- **置信度**：确定（空树、部分树两种场景均实测）

---

### [P2] `adopt --all` 部分失败会留下半成品，且无论成败都 exit 0

- **位置**：`tools/adopt.mjs:229-240`（`try/catch` 里只 `console.log("skip ...")` 并 `failed++`，随后 `return`）
- **现象**：`--all` 对每个模块单独 `try/catch`，失败的只记一行 `skip`，最后打印 `N adopted, M skipped` 并 `return`——**没有 `process.exitCode`**。因此 (a) 16 个模块里 1 个格式化失败时，磁盘上留下 15 个 overlay 的"半 adopt"状态，exit 0；(b) 全部失败（0 adopted, N skipped）也是 exit 0。
- **证据**：

  ```
  === B. adopt --all where ONE module fails (partial tree) ===
    exit=0  adopted files on disk=15/16
    last two lines:  | 15 adopted, 1 skipped
    build after partial adopt: exit=0 | build: 9/10 bundles byte-identical to baseline

  === B. adopt --all where all modules fail formatting ===
    exit=0
    skip    hEvvs: module hEvvs could not be formatted (Unexpected token (2:1)); it may not be a standalone expression
    0 adopted, 1 skipped
    overlay written? false
  ```
- **影响**：`--all` 的语义是"把这个 bundle 变成可编辑的"。半成品状态下，一部分模块走 overlay、一部分走压缩原件，`build` 会报 `9/10`（和"全部 adopt 成功"完全一样的信号），开发者无从知道哪些模块的编辑会生效、哪些不会。在 `set -e` / `&&` 链里，`adopt --all` 失败不会中断后续步骤。
- **建议**：`failed > 0` 时 `process.exitCode = 1`；并在开始前先对全部模块做一次"能否格式化"的预检（`prettier.format` 是纯函数，可以全部试一遍再决定是否落盘），实现"要么全成、要么全不动"。
- **置信度**：确定（两种失败比例均实测）

---

### [P2] `adopt --list-available` 静默跳过读不出 `modules.json` 的 bundle

- **位置**：`tools/adopt.mjs:59-65`（`try { manifest = readBundleManifest(bundle) } catch { continue; }`）
- **现象**：`listAvailable()` 对每个 bundle 读 `modules.json`，异常时**静默 `continue`**。于是"这个 bundle 无法列出"与"这个 bundle 不存在"在输出上完全一样，退出码 0。
- **证据**（给 `MainCS` 的 `modules.json` 加 UTF-8 BOM——PowerShell `Set-Content -Encoding utf8` 的产物）：

  ```
  === 2. adopt --list-available when a modules.json is unreadable ===
    exit=0  mentions MainCS: false  mentions hEvvs: true
    stderr: ""
    bundles listed: 9
  ```

  （`hEvvs` 之所以仍出现，是因为它同时属于另一个 bundle；`MainCS` 这个 bundle 整个从列表里消失了。）
- **影响**：这是"我 adopt 不了这个模块，但工具说没有这个模块"的典型误导。`adopt` 是 `src/overlay/` 的唯一入口，列表不全意味着操作者会以为某个 bundle 不可 adopt，转而去手改 `src/bundles/`（然后被 `verify` 拒绝，见 L3 的相关条目）。
- **建议**：把 `catch { continue; }` 改为收集失败项并在末尾打印 `WARN: 1 bundle skipped (modules.json unreadable): MainCS.277dcde3 — Unexpected token ...`，同时 `exitCode = 1`。
- **置信度**：确定（BOM 场景实测，9 vs 10 已核对）

---

### [P2] `path.basename` 在 POSIX 上不拆反斜杠：`index.json` 里 Windows 风格的 `split_dir` 会让 overlay 永不生效

- **位置**：`tools/build.mjs:173`（`const bundleName = path.basename(entry.split_dir)`）、`tools/build.mjs:107`（`path.join(ROOT, entry.split_dir)`）、`tools/format.mjs:154`（同款 `path.basename`）
- **现象**：`src/bundles/index.json` 的 `split_dir` 是 `reconstruct.mjs` 用 `path.relative` 写出的，在 Windows 上带反斜杠（`"src\\bundles\\MainCS.277dcde3"`）。`path.join` 会容忍这种写法（L1 已实测并据此判定"不是跨平台缺陷"），但 **`path.basename` 不会**：在 POSIX 上反斜杠是普通文件名字符，`path.posix.basename("src\\bundles\\MainCS.277dcde3")` 返回整串。于是 `bundleName` 变成 `src\bundles\MainCS.277dcde3`，overlay 查找路径变成 `src/overlay/src\bundles\MainCS.277dcde3/hEvvs.js`——永远不存在。
- **证据**（用 `path.win32` / `path.posix` 对同一份真实 `index.json` 求值，不依赖真实 Linux）：

  ```
  --- path.posix ---
    MainCS.277dcde3.js
      dir          = C:/Users/.../proj/src\bundles\MainCS.277dcde3
      bundleName   = src\bundles\MainCS.277dcde3
      overlay dir  = C:/Users/.../proj/src/overlay/src\bundles\MainCS.277dcde3
  ```

  ```
  win  basename: "MainCS.277dcde3"
  posix basename: "src\\bundles\\MainCS.277dcde3"
  posix join overlay: src/overlay/src\bundles\MainCS.277dcde3/hEvvs.js
  ```

  同样的错误会让 `format` 在 `src/readable/` 下创建名为 `src\bundles\MainCS.277dcde3` 的目录（一个含反斜杠的目录名），而不是 `MainCS.277dcde3`。
- **影响**：**这是对 L1"未覆盖的范围"中一条结论的修正。** L1 写的是"`split_dir` 使用反斜杠…`path.join` 会规范化，所以不是跨平台缺陷"，并注明"未在 Linux/macOS 上实机验证"。结论对 `path.join` 成立，但 L1 没有检查同一字段还被喂给了 `path.basename`。实际后果：在一台 macOS/Linux 机器上克隆本工程后，所有 overlay 都会被**静默忽略**（`build` 报 `10/10`，因为压缩原件就是基线），`adopt` 生成的编辑完全不起作用，而 `adopt --list` 又会显示它们存在（`listOverlays` 走 `readdir`，与 `split_dir` 无关）——正是 L1 P3"stale overlay 被静默忽略"的跨平台放大版。
- **建议**：在 `reconstruct.mjs` 写 `index.json` 时把 `split_dir` 归一化为 POSIX（`path.relative(...).split(path.sep).join("/")`），并在读取侧用 `entry.split_dir.split(/[\\/]/).pop()` 取代 `path.basename`。加一条 `.gitattributes`（`src/bundles/** -text`）顺带解决 L1 提到的 CRLF 检出问题。
- **置信度**：确定（`path.posix` 对真实 `index.json` 的求值结果已给出；未在真实 POSIX 机器上跑，但 `path.posix` 是纯函数，结论与平台无关）

---

### [P2] `index-symbols` 把"审计文件损坏"报告成"文件缺失"

- **位置**：`tools/index-symbols.mjs:122-132`（`loadStorageKeys` 的 `!existsSync → return null` 与 `catch → return null` 汇成同一个返回值）、`tools/index-symbols.mjs:217-223`（统一的 "missing" 文案）
- **现象**：`loadStorageKeys()` 对"文件不存在"和"JSON 解析失败"返回同一个 `null`，调用方只能打印一句 `docs/architecture.generated.json missing; run npm run audit first.`。文件明明存在（只是被截断/冲突标记污染）时，这句提示会把人引向"重跑 audit"，而真正的问题是需要修复文件。
- **证据**（把 `architecture.generated.json` 截断到 500 字节）：

  ```
  === 1. index-symbols degradation messages ===
    corrupt JSON: exit=0 stderr="warning: docs/architecture.generated.json missing; run `npm run audit` first.\n         Storage keys will be skipped until then."
    storage_key count written: 0
    missing file: exit=0 stderr="warning: docs/architecture.generated.json missing; run `npm run audit` first.\n         Storage keys will be skipped until then."
  ```

  两种情形的 stderr **逐字节相同**。
- **影响**：误导性错误信息。次要影响是 `exit 0`：storage key 这一类目整体消失（14 → 0）却算成功，`docs/symbol-index.json` 的 `categories.storage_key.count` 会写成 0，而 `consistency.check` 的 `storage keys agree with audit` 断言恰好因为两边都空而通过（L3 已报告该断言是同义反复，此处是它在新场景下的又一次失效）。
- **建议**：把 `catch` 与 `!exists` 分开，分别打印"文件不存在，请先运行 audit"与"文件存在但无法解析（<错误摘要>），请修复或重新生成"；后者应 `exit 1`。
- **置信度**：确定（两种情形输出已逐字比对）

---

### [P3] `parcel-split` 的 CLI 只认固定位置，`--verify` 放错位置会创建一个名叫 `--verify` 的目录

- **位置**：`tools/parcel-split.mjs:296-300`（`const [, , file, outDir, flag] = process.argv;`）、`tools/parcel-split.mjs:307`（`if (flag === "--verify")`）
- **现象**：`--verify` 被当作第 3 个位置参数处理，`=== "--verify"` 的精确比较既不支持放错位置，也不支持拼错。把 `--verify` 写在 `<outDir>` 的位置上，`split()` 会**创建一个字面名为 `--verify` 的目录**并把拆分结果写进去，然后报正常成功。
- **证据**：

  ```
  === 1. parcel-split argument positions ===
    `parcel-split <bundle> --verify` exit=0 out="WebappCS.8b5d7cd6.js: 1 modules, 19903 bytes, sha256=4c0f22559c8faa47…"
    created a directory literally named "--verify"? true
      contents: epilogue.js, hEvvs.js, modules.json, preamble.js
    `--verfy` (typo) exit=0 — verification ran? false
    extra trailing arg exit=0 verification ran? true
  ```
- **影响**：操作者以为自己在"拆分并校验"，实际做的是"把结果写进一个奇怪目录、且没有校验"。清理时这个目录名会让 `rm` 类命令需要 `--` 转义。属于误用成本低、后果轻的类别。
- **建议**：改用 `process.argv.slice(2).filter(a => a.startsWith("--"))` 提取 flag、剩余为位置参数；未知 flag 直接 `exit 2`；`outDir` 以 `-` 开头时拒绝。
- **置信度**：确定（三种位置/拼写组合均实测）

---

### [P3] `parcel-split` 不清理输出目录里的陈旧模块文件，`verify` 也不会发现

- **位置**：`tools/parcel-split.mjs:227-256`（`split` 只 `mkdirSync` + 逐个写文件）、`tools/parcel-split.mjs:266-283`（`verify` 只按 manifest 遍历）
- **现象**：`split(file, outDir)` 不删除 `outDir` 中已有的文件。若上一次拆分产生了模块 `OLD1`，这次基线的模块 id 变了，`OLD1.js` 会留在原地，而 `verify` 只读 manifest 里列出的文件，因此仍报 `IDENTICAL`。
- **证据**：

  ```
  === M. parcel-split into a directory that already has modules ===
    exit=0 out="reassembly: IDENTICAL (19903/19903 bytes)"
    STALE.js still present: true
  ```
- **影响**：`src/bundles/<bundle>/` 里会出现不属于任何 manifest 的 `*.js`。`build` 按 manifest 遍历所以不会误用（安全方向），但会让人以为"这个 bundle 有 N+1 个模块"，且 `adopt --list-available` 也不列它（同样按 manifest）——即这个文件既不会被构建、也不会被列出、也不会被校验，是一个纯噪声。叠加基线升级场景时可能误导排查。
- **建议**：`split` 写文件前清空 `outDir`（或先写临时目录再 `rename`）；`verify` 额外断言 `readdir(outDir)` 的 `.js` 集合与 manifest 的 `file` 集合相等。
- **置信度**：确定（陈旧文件存活已实测）

---

### [P3] 未知/拼错的命令行参数被静默忽略（`format`、`build`、`adopt`）

- **位置**：`tools/build.mjs:142`（`process.argv.includes("--clean")`）、`tools/format.mjs:139`（`indexOf("--bundle")`）、`tools/adopt.mjs:209`（`const [bundleDir, target] = args`）
- **现象**：三个工具都不校验参数集合。拼错的 flag 被当成普通位置参数丢弃；多余的位置参数被忽略。
- **证据**：

  ```
  === 2. build flag handling ===
    --clen (typo) exit=0 stale file survived? true
    --clean=true exit=0 stale file survived? true
    --clean exit=0 stale file survived? false
    --help exit=0 rebuilt dist? true

  === 4. adopt with extra positional args ===
    `adopt <bundle> <id> --all` exit=0 out="adopted MainCS.277dcde3/hEvvs"
    `adopt <bundle> --all extra` exit=0 out="1 adopted, 0 skipped"
  ```
- **影响**：`build --clen` 不清理陈旧文件，`build --help` 会真的重建 `dist/`（把 `--help` 当普通参数）。对一个"构建产物直接决定扩展行为"的工具，静默忽略 flag 比报错更危险：操作者会以为自己已经做了 `--clean`。
- **建议**：每个工具加一个小的 `parseArgs`，白名单之外以 `-` 开头的参数直接 `exit 2`；位置参数多余时也报错。`--help` 应打印用法后 `return`，不执行主流程。
- **置信度**：确定（三个工具均实测）

---

### [P3] `format` 的 `main()` 没有 `.catch()`，异常以原始 Node 栈退出

- **位置**：`tools/format.mjs:184`（`main();`，无 `.catch()`）
- **现象**：`format.mjs` 是唯一一个"异步 `main()` 但没有错误处理"的工具（`adopt.mjs:249` 有 `.catch()`）。任何 `fs`/`JSON.parse` 异常都会变成未捕获的 rejection，Node 打印完整内部栈并 exit 1。
- **证据**（`src/bundles/index.json` 带 BOM）：

  ```
  node:fs:539
    return binding.readFileUtf8(path, stringToFlags(options.flag));
                     ^
  ```

  （`build.mjs` 对同一输入也是原始栈：`<anonymous_script>:1 / { / ^ / SyntaxError: Unexpected token ...`。）

  另外，`format` 在崩溃时**不写 `src/readable/index.json`**，留下一个"没有清单的部分树"（见 P2「`index-symbols` 接受空或部分的树」）。
- **影响**：报错信息指向 Node 内部行号，不指向"哪个文件、什么原因"；对不熟悉 Node 的使用者基本不可读。而且 `JSON.parse` 的报错不含文件名，只含位置。
- **建议**：`main().catch(err => { console.error(\`format failed: ${err.message}\`); process.exit(1); })`；所有 `JSON.parse(readFileSync(...))` 包一层带文件名的辅助函数（`readJson(file)`），把 `SyntaxError` 转成 `<file>: invalid JSON (<first line>)`。
- **置信度**：确定（两种崩溃场景的原始栈已记录）

---

### [P3] `reconstruct` 调用拆分器时没有超时，也没有 `maxBuffer`

- **位置**：`tools/reconstruct.mjs:250`（`execFileSync(process.execPath, args, { encoding: "utf8" })`）
- **现象**：`execFileSync` 未设置 `timeout`，也未设置 `maxBuffer`（默认 1 MB）。拆分器若因正则/括号匹配进入长循环，`reconstruct` 会无限期挂起且没有任何输出；若拆分器打印超过 1 MB，会抛 `ENOBUFS`。
- **证据**：读代码确认（`tools/reconstruct.mjs:250` 只有 `encoding` 一个选项）。实测 10 个 bundle 的拆分器单次输出为 2 行、约 120 字节，远低于 `maxBuffer`，所以当前不触发：

  ```
  static/background/index.js -> 16 modules
      index.js: 16 modules, 3209598 bytes, sha256=0b13b37594fd946c…
      reassembly: IDENTICAL (3209598/3209598 bytes)
  ```
- **影响**：挂起时无法区分"在慢慢跑"和"卡死了"。拆分最大 bundle（3.2 MB）实测约 0.3 秒，正常情况不会触发；但这是"失败要响"原则的缺口——最需要诊断信息的场景恰恰没有诊断信息。
- **建议**：加 `timeout: 120_000` 与 `maxBuffer: 16 * 1024 * 1024`，并在 `catch` 里把 `signal`/`status` 与 `stderr` 一并打印，指出是哪个 bundle。
- **置信度**：确定（读代码 + 实测正常耗时）

---

### [P3] 内存与并发：最大 bundle 需要 >256 MB 堆；两个同名工具并发会以 `EBUSY` 失败

- **位置**：`tools/format.mjs:74`（`prettier.format(original)` 一次性处理整个 4.7 MB bundle）、`tools/format.mjs:149`（`rmrf` 后重建）、`tools/build.mjs:142`（`rmrf(DIST)`）
- **现象**：
  - **内存**：`format` 对单个 bundle 做整文件 Prettier 解析。用 `--max-old-space-size` 限制实测：128 MB 与 256 MB 都 OOM（exit 134），512 MB 通过。默认堆（64 位约 4 GB）下无问题。
  - **并发**：两个 `format` 同时跑，后者崩溃（exit 1）；两个 `build` 同时跑，后者 `EBUSY`（exit 1）。没有锁文件，但因为都失败得比较响，未观察到静默损坏。
- **证据**：

  ```
  === heap caps for format (largest bundle = 4.7 MB minified / 5.2 MB formatted) ===
    cap=    128 MB -> {"code":134, ...}
    cap=    256 MB -> {"code":134, ...}
    cap=    512 MB -> {"code":0, ...}
    cap=default MB -> {"code":0, ...}
  ```

  ```
  === X. two `format` processes concurrently ===
    A exit=0 last="10/10 bundles formatted | output: src/readable/"
    B exit=1 last="\r | Node.js v26.5.0"
    readable dirs after: 10
    empty files: 0

  === Y. two `build` processes concurrently ===
    A exit=0 "build: 10/10 bundles byte-identical to baseline"
    B exit=1 "Error: EBUSY: resource busy or ..."
  ```
- **影响**：内存只在受限 CI（例如 512 MB 容器、32 位 Node）里成为问题；并发只在"编辑器里手滑跑了两次"或 CI 矩阵共享工作区时出现。两者的共同点是**没有明确的失败信息**（OOM 只给一串十六进制地址；`EBUSY` 指向 `copyFile` 而不说"另一个 build 正在运行"）。
- **建议**：`format` 可以对超大 bundle 分块（先按 `register` 边界切，再逐模块 `prettier.format`，失败再退回整包）以降低峰值；或在 README 的"环境要求"里写明"格式化最大 bundle 需要约 512 MB 堆"。`build`/`format` 加一个简单的 `.lock` 文件（`fs.openSync(..., "wx")`，`finally` 删除），冲突时打印"另一个 <tool> 正在运行（pid N）"。
- **置信度**：确定（堆上限与并发行为均实测）

---

### [P3] `index-symbols` 的"跳过 >400 字符行"策略覆盖了 46% 的树，但当前隐藏的符号数接近 0

- **位置**：`tools/index-symbols.mjs:139-143`（`const isLong = line.length > 400; if (isLong && !cat.scanLongLines) continue;`）
- **现象**：该策略的注释说明是"长行通常是数据表，不是代码"。实测这 178 行长行占整棵可读树字节数的 **46.0%**，但按现有 7 个类目逐行统计，被隐藏的匹配数几乎为 0。
- **证据**：

  ```
  readable total bytes=25847113
  lines >400 chars=178, bytes on them=11878331 (46.0% of the tree)

  lines matching per category (current behaviour = skip long lines):
    background_handler     short-lines=   229   hidden-on-long-lines=0
    app_command            short-lines=    88   hidden-on-long-lines=0
    i18n_key               short-lines=   301   hidden-on-long-lines=10
    endpoint               short-lines=   170   hidden-on-long-lines=0
    chrome_api             short-lines=    49   hidden-on-long-lines=0
    action_type            short-lines=  1128   hidden-on-long-lines=0
  ```

  长行上那 10 个 i18n 匹配去重后只有 1 个键，且它同时出现在短行上，所以仍然被索引：

  ```
  i18n keys that appear ONLY on >400-char lines (never indexed): 1
    chapterNavigation_generateChapters         Main.00175a8f/99-epilogue.js:58156 (line 67829 chars)
  of those, how many also appear on a short line (i.e. still indexed elsewhere)?
    chapterNavigation_generateChapters         alsoOnShortLine=true
  ```

  14 个存储键全部能在短行上找到（`keys found on short lines: 14/14`），所以也不受影响。
- **影响**：当前无实际损失，**这一条是"已量化的潜在风险"而非现存缺陷**。之所以仍然记录：46% 的字节不在任何类目的扫描范围内，这个比例远高于注释给人的印象（"长行通常是数据表"）。一旦基线形态变化（例如 Parcel 改为输出更长的行、或有人给某个类目新增 `scanLongLines: false` 的规则），丢失将是静默的。
- **建议**：把阈值改为"行长度 > 400 **且** 行内换行密度 < 某值"之类的启发式，或对长行只做 `String.prototype.includes` 式的候选筛选再跑正则（成本低、不会漏）。至少在 `symbol-index.json` 里记录 `lines_skipped` 计数，让读者知道索引不是全量的。
- **置信度**：确定（统计脚本在 377,192 行上逐行统计；结论"当前无损失"与"46% 未扫描"都有数据支撑）

---

## 已确认无问题的部分

以下均为实测，不是"看起来没问题"。

1. **所有工具写出的文件都是 UTF-8 无 BOM、LF 换行。** 逐个检查了 9 类输出：

   ```
   src/readable/index.json                    BOM=false CRLF=false
   src/readable/MainCS.277dcde3/hEvvs.js      BOM=false CRLF=false
   docs/architecture.generated.json           BOM=false CRLF=false
   docs/symbol-index.json                     BOM=false CRLF=false
   docs/symbol-index.md                       BOM=false CRLF=false
   dist/MainCS.277dcde3.js                    BOM=false CRLF=false
   src/overlay/MainCS.277dcde3/hEvvs.js       BOM=false CRLF=false
   build-report.json                          BOM=false CRLF=false
   ```

   `fs.writeFileSync(..., "utf8")` 不会引入 BOM；这一点在 Node 上是确定的，此处也用字节检查复核了。

2. **`src/bundles/` 里的模块文件被写成 BOM 时，`build` 会无害地剥掉它。** BOM 落在 provenance 头那一行，而 `build` 丢弃首行，所以 `build` 仍报 `10/10`、`check` 通过、`verify` 通过：

   ```
   === H. split module re-saved with UTF-8 BOM ===
     build exit=0 | build: 10/10 bundles byte-identical to baseline
     check exit=0 | check passed
     verify exit=0
   ```

   （这条只是"幸运"：它依赖"BOM 恰好落在被丢弃的那一行"。`preamble.js` / `epilogue.js` 带 BOM 时则会多出 3 字节并报 `9/10`，见 P1 那条的同类机制。）

3. **`index.json` / `modules.json` 被转成 CRLF 不影响任何工具。** `build` 报 `10/10`，`modules.json` 的 CRLF 版本同样 `10/10`。

4. **路径处理在 Windows 上是稳的。** 空格、中文、前导点、尾随空格、尾随点、保留名（`CON`）、540 字符超长路径全部成功：

   ```
   relative        exit=0 dir=true
   forward slashes exit=0 dir=true
   backslashes     exit=0 dir=true
   dot-segments    exit=0 dir=true
   trailing-space  exit=0 dir=true
   trailing-dot    exit=0 dir=true
   unicode name    exit=0 dir=true
   reserved name   exit=0 dir=true
   out path length=540 exit=0 dir created: true
   ```

   含空格与中文的路径在 `parcel-split` 上同样通过并报 `IDENTICAL`。

5. **工具与工作目录无关。** 从 `C:\Users\...\Temp\l5` 调用 `proj/tools/build.mjs` 得到 `build: 10/10 byte-identical`（全部工具都用 `import.meta.dirname` 解析根目录）。

6. **目录穿越被 manifest 白名单挡住。** `adopt <bundle> <id>` 的 `id` 必须在 `modules.json` 里，因此 `../../evil`、`..\..\evil`、`C:\Windows\Temp\evil` 全部被拒绝且没有创建任何文件；`bundle` 参数必须以含 `modules.json` 的真实目录为前提，`..`、`../..`、`.` 都被拒绝。

7. **`src/overlay` 是 junction 时也能正常工作**（`adopt` 写入、`build` 读取均通过），说明没有对真实路径做过度假设。

8. **正则没有灾难性回溯。** 对 `audit`/`index-symbols` 的 5 个主要正则在 1k–200k 字符的对抗性输入上计时，全部线性：

   ```
   storage  no-closing-quote len= 200000   0.26 ms
   handler  long-uppercase  len= 200000  20.97 ms
   endpoint long-url        len= 200000   0.13 ms
   appcmd   long-uppercase  len= 200000   0.57 ms
   ```

9. **幂等性成立。** `format` 连跑两次，261 个文件里只有 `index.json` 不同（`generated_at` 时间戳）；`audit` 与 `index-symbols` 同样只差时间戳：

   ```
   files: 261 -> 261; differing: 1 [index.json]
   audit identical apart from generated_at: true
   index identical apart from generated_at: true
   ```

10. **`process.exit()` 没有截断拒绝列表。** 手工编辑全部 240 个模块后，`reconstruct --verify` 的 240 行文件名在管道里完整输出（`edited=240 filenames printed=241 truncated=false`），说明不存在 stdout 未刷新就退出的问题。

11. **并发失败是显式的，没有静默损坏。** 两个 `format` 并发时，幸存进程的树是完整的（10 个目录、0 个空文件）；两个 `build` 并发时后者 `EBUSY` 退出。虽然不优雅，但没有观察到"半写文件"。

12. **locale 不影响符号索引的排序。** 用 `LANG`/`LC_ALL` 切 `en_US`、`de_DE`、`tr_TR`、`C` 四种环境跑 `index-symbols`，输出逐字节相同（Node 的 ICU 默认 locale 不随这两个变量改变）。

13. **`adopt` 对不存在输入的报错是清楚的。** 未知模块会列出可用 id，未知 bundle 会指出期望的 `modules.json` 路径，缺失 fragment 报 `no epilogue.js in <bundle>`——三条路径都 exit 1：

   ```
   module NOPE not in WebappCS.8b5d7cd6; available: hEvvs
   no such bundle: NoSuchBundle (expected src\bundles\NoSuchBundle\modules.json)
   no epilogue.js in MainCS.277dcde3
   ```

14. **`parcel-split` 对空文件、二进制文件、缺失文件都是显式失败（exit 1），且不留下半成品目录。** `empty file: exit=1`、`binary file: exit=1`、`partial output dir left behind? false`。

15. **`build` 在 `dist/` 只读时失败得明确（exit 1）**，恢复权限后立刻回到 `10/10`。

## 未覆盖的范围

1. **`tools/package.mjs`、`tools/browser-verify.mjs`、`tools/check.mjs` 的完整健壮性**属于 L4。我只在"确认某个缺口能否被下游抓住"时读了 `check.mjs` 的脚本覆盖逻辑，并跑了它的退出码；没有审查打包、zip CRC、Chrome 进程管理、`--suffix` 的边界（只顺手测了 `--suffix` 缺值与空串，两者都退化成 `2.4.6`，未深究是否属缺陷）。
2. **`tools/reconstruct.mjs` / `tools/overlay.mjs` / `tools/build.mjs` 的算法正确性**属于 L1。我只测了它们的健壮性侧面（缺失输入、编码、并发、退出码），未复核拆分边界或 overlay 优先级。
3. **未在真实 Linux/macOS 上运行。** 反斜杠 `split_dir` 的跨平台结论基于 `path.posix` 对真实 `index.json` 的求值——这是纯函数，结论与平台无关，但我没有实测"在 macOS 上 `adopt` + `build` 的完整回路"。
4. **未测 32 位 Node、Node 22/24 的实际行为。** `package.json` 声明 `>=22.19`，我的测试全在 v26.5.0 上。`fs.readFileSync` 的编码替换行为、`path.basename` 的语义在这些版本间应当是稳定的，但未验证。
5. **未做长时间/大并发的资源泄漏测试。** 文件句柄与子进程只在"跑一次"的粒度上观察（没有观察到泄漏迹象，但没有 `process.getActiveResourcesInfo()` 级别的测量）。`execFileSync` 是同步的，每次 `reconstruct` 会顺序起 10 个子进程，未测 100 次连续运行的句柄累积。
6. **未测 NTFS 硬链接、8.3 短文件名、UNC 路径（`\\server\share`）。** 只测了本地盘上的空格/中文/超长/保留名。UNC 需要网络共享，当前环境不具备。
7. **`audit` 的提取口径是否正确**属于 L3（已由其报告 `storage_keys` 混入 i18n 键等）。我只测了它在输入不完整时的降级行为，没有复核正则语义。
8. **未评估 `format` 的 Prettier 选项是否会改变语义。** 那是 L1/L2 的 `overlay.check` 范围；我只关心"格式化失败时会发生什么"。

## 附：复现脚本

测试脚本与工程副本都在 `C:\Users\A2134\AppData\Local\Temp\l5\`，**审查结束后已删除**（按要求清理）。下表记录每个脚本验证了哪条发现，便于按同样思路重建；每条发现的"证据"小节里已内联关键命令与输出，足以独立复核。

重建测试环境的方式：

```powershell
$t = "$env:TEMP\l5"
New-Item -ItemType Directory -Path $t -Force | Out-Null
robocopy "D:\DEV\3_Projects\LP\vCaptions" "$t\proj" /E /XD .cursor .omp review release /NFL /NDL /NJH /NJS /NP
# 之后所有 node tools/... 都在 $t\proj 下运行，不要碰真实工程
```

| 脚本 | 对应发现 |
| --- | --- |
| `adopt-tests.mjs`、`adopt-tests2.mjs` | P0 adopt 覆盖、P2 `--all` 半成品、P2 `--list-available` 静默跳过 |
| `case-tests.mjs` | P2 大小写变体 bundle 名（Windows 大小写不敏感，故结论落在 POSIX 侧） |
| `cli-tests.mjs` | P3 `parcel-split` 参数位置、P3 未知 flag 被忽略 |
| `enc-tests.mjs`、`enc2.mjs`、`gbk.mjs`、`gbk2.mjs` | P1 非 UTF-8 overlay、已确认 #1/#2/#3 |
| `bom-detail.mjs`、`bom-build.mjs`、`bom-handedit.mjs` | BOM 的读取差异（含 L1 已报条目的新触发路径） |
| `path-tests.mjs` | P1 format `--bundle`、P2 空树索引、P3 陈旧模块文件 |
| `posix-sim.mjs` | P2 `path.basename` 跨平台 |
| `silent-tests.mjs`、`evidence.mjs` | P1 raw fallback、P1 audit 零值、P2 索引接受空树、P2 "损坏"报成"缺失" |
| `pipeline-tests.mjs`、`all-trace.mjs`、`all-twice.mjs` | P0 `npm run all` 顺序 |
| `chain-tests.mjs`、`partial.mjs` | P1 reconstruct 静默摘 bundle、P2 部分树 |
| `final2.mjs`、`last-tests.mjs` | 长行覆盖统计、locale、截断 dist |
| `mem.mjs`、`regex-perf.mjs`、`longlines.mjs`、`longline-coverage.mjs` | P3 内存、已确认 #8、P3 长行策略 |
| `misc-tests.mjs`、`atomic-tests.mjs`、`edge-tests.mjs` | 并发、只读 dist、路径形态、`execFileSync` |
