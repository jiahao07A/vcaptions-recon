# R4 编辑安全与 overlay 审查报告

审查者：R4 subagent（编辑安全 / overlay / adopt）
审查范围：`tools/reconstruct.mjs`、`tools/overlay.mjs`、`tools/adopt.mjs`，以及与其耦合的 `tools/parcel-split.mjs`、`tools/build.mjs`、`tests/edit-safety.check.mjs`、`tests/overlay*.check.mjs`、`tests/guard.check.mjs`、README 中「怎么改代码」章节
审查时间：2026-10-23T10:44:00Z

## 结论摘要

**手改检测仍可被绕过。** 第二轮 P0-2 的修复（`manifest` 缺失/损坏时拒绝）只覆盖了「文件不存在」和「不是合法 JSON」两种情况。一旦 `modules.json` 是**合法 JSON 但结构被削弱**（`{}`、`[]`、`{"modules":[]}`、`{"modules":null}`），检测就直接放行、exit 0、重写全部文件。最极端的一次：一次对 `modules.json` 的编辑让 **60 个模块的手改全部被覆盖，且没有任何提示**。

**overlay 边界的主要修复成立。** `stripOverlayHeader` 只认 adopt 头、`readOverlayBody` 保留尾部换行、CRLF 归一化、以及「只含注释的 overlay 被拒绝」——这四项都实测通过。但 `stripOverlayHeader` 会被**用户自己的注释误触发**（丢弃整段许可声明），且 `readOverlayBody` 会**删除行尾空白**，静默改写模板字符串的内容。

**最严重的数据丢失路径不是检测被绕过，而是守卫自己的补救建议。**「无法验证 → 请删除该 bundle 目录重新拆分」这句话，在 `modules.json` 恰好丢失时，会连同其中的真实手改一起删除。

## 发现

### [P0] `modules.json` 是合法 JSON 但结构被削弱时，手改检测静默放行并覆盖全部编辑

- **位置**：`tools/reconstruct.mjs:83-87`（`if (!manifest)`）配合 `tools/reconstruct.mjs:94`（`for (const mod of manifest.modules ?? [])`）
- **现象**：第二轮声称「manifest 缺失/损坏时**拒绝**而非放行」。实际实现是 `if (!manifest)` —— 只判断 `JSON.parse` 是否抛错。任何**能解析但没有 `modules` 数组**的 JSON 都通过这个判断，随后的 `for (const mod of manifest.modules ?? [])` 遍历 0 次，函数返回 `{edited:[], unreadable:[]}`，主流程判定「无修改」，`split()` 全量重写。
- **证据**（沙箱 `C:\Users\A2134\AppData\Local\Temp\vcap-r4`，项目副本，真实工程未改动）：

  ```
  # 先制造一个手改，再把 manifest 换成 {}
  $ node -e "fs.writeFileSync('src/bundles/WebappCS.8b5d7cd6/modules.json','{}')"
  $ node tools/reconstruct.mjs --verify
    10 bundles, 240 modules -> src\bundles
    all bundles reassemble byte-for-byte
    exit=0
    MY-EDIT still in file: false        <-- 编辑被覆盖，无任何提示
  ```

  四种削弱方式全部 exit 0、编辑全部死亡：

  | manifest 内容 | exit | 拒绝? | 编辑存活 |
  | --- | --- | --- | --- |
  | `{}` | 0 | 否 | **否** |
  | `[]`（顶层数组） | 0 | 否 | **否** |
  | `{"modules":[]}` | 0 | 否 | **否** |
  | `{"modules":null}` | 0 | 否 | **否** |
  | `null` | 1 | 是 | 是（唯一被拦住的一种） |

  规模效应（`Main.00175a8f`，60 模块，全部手改后清空 `modules` 数组）：

  ```
  exit: 0 | all bundles reassemble byte-for-byte
  60 modules on disk, edits surviving: 0
  ```

- **对照：同一棵树，独立校验器是能发现的。** 只清空 `modules` 数组、不动任何模块文件时：

  ```
  $ node tools/parcel-split.mjs assets/baseline/extension-v2.4.6/WebappCS.8b5d7cd6.js src/bundles/WebappCS.8b5d7cd6 --check
  WebappCS.8b5d7cd6.js: INVALID (10380/19903 bytes)
    structural problems:
      - module set differs (missing: hEvvs; unexpected: none)
    exit=1
  ```

  也就是说，检测器自己已经具备发现该问题的能力（`verify()` 的模块集合比对），但 `findHandEdits()` 从不调用它，只信 manifest 里有什么就比什么。**被削弱的是守卫的前置条件，不是校验能力。**

- **影响**：这是第二轮 P0-2 的**同型复发**——「无法判断时假设安全侧」。触发条件不再是「文件没了」，而是「文件还在但内容不完整」。现实触发路径：手工编辑 manifest 的依赖映射后写坏、合并冲突标记被误解析、编辑器崩溃写出部分内容、任何把 `modules.json` 精简/重建的脚本。后果是静默覆盖，`exit 0`，`all bundles reassemble byte-for-byte` 这句话还会强化「一切正常」的错觉。
- **建议**：把 manifest 的**结构**当作契约校验，而不是当作可选的提示。对每个 bundle 要求 `manifest.modules` 是数组、长度等于 `findModules(baselineText).length`、id 集合与基线解析结果完全相等；任一不满足即计入 `unreadable`。最省事且最彻底的做法是直接复用 `parcel-split.mjs --check`：它已经实现了正确的独立真值比对，而当前守卫是它的一个更弱的复制品。
- **置信度**：确定（四组反例均实际执行）

---

### [P0] 守卫的补救建议「删除该 bundle 目录重新拆分」会销毁它刚刚拒绝保护的手改

- **位置**：`tools/reconstruct.mjs:165-167`（unreadable 分支的错误文案）
- **现象**：`modules.json` 缺失时，脚本拒绝执行并输出：

  ```
  Restore the file (or delete the bundle directory to re-split it from scratch),
  then re-run. Re-splitting now could destroy edits that this check cannot see.
  ```

  第二条建议（删除目录）与它上一句警告的后果完全相同：`modules.json` 丢失恰恰是这个守卫**唯一无法判断**模块文件里有没有手改的场景。此时目录里可能存放着真实工作，而「删除目录」把它们一并删除，随后 `split()` 从基线重建，`exit 0`，输出 `all bundles reassemble byte-for-byte`。
- **证据**：

  ```
  # 制造真实手改，然后删掉 modules.json（例如崩溃或误删）
  verify exit: 1
    refusing to re-split: cannot verify these bundles are unedited
      WebappCS.8b5d7cd6/modules.json is missing or not valid JSON
    Restore the file (or delete the bundle directory to re-split it from scratch),
    then re-run. ...
  # 按第二条建议操作
  $ rm -rf src/bundles/WebappCS.8b5d7cd6
  $ node tools/reconstruct.mjs --verify
    exit 0
    MY-REAL-WORK survived: false        <-- 守卫拒绝保护的东西，被守卫的建议删掉了
  ```

- **影响**：数据丢失且完全无提示。这是本轮最严重的一条：它不是绕过检测，而是**检测生效之后**把人引向唯一会丢数据的操作。且这个建议出现在最需要小心的情况下（已有一次异常发生了）。
- **建议**：删掉「删除 bundle 目录」这条建议。替代方案：从基线重新生成一份 `modules.json`（只含 id/file/separator，不含任何作者数据）写到临时位置，让用户先 `adopt` 再重拆；或直接提示「先备份该目录」。另外，在 `modules.json` 缺失时**不要**同时声称「无法验证」又提供一条无法保证安全的路径。
- **置信度**：确定

---

### [P0] 编辑 `modules.json` 的字段本身不受保护，且会被静默还原

- **位置**：`tools/reconstruct.mjs:94-128`（只比对 `mod.file` 的正文与两个 fragment 文件，从不比对 manifest 自身）
- **现象**：守卫只检查 manifest **指向的文件**是否被改，从不检查 manifest **本身**是否被改。而 README 第 235 行明确写着「跨模块重构需同步更新 `modules.json` 的依赖映射」——这是文档鼓励的编辑对象。任何对 `dependencies`、`separator_after`、`bytes`、`sha256`、`module_count` 的修改，在下次 `npm run verify` 时被静默丢弃，`exit 0`。
- **证据**：

  ```
  # 修改 Main.00175a8f 的 dependencies 与 separator_after
  verify exit: 0
  dependency edit survived: []
  separator_after edit survived: ","
  any warning: false

  # 修改 bytes / body_bytes / sha256 / module_count
  verify exit: 0 | refuses: false
  ```

  另有一项单独的破坏：第 1 行的 provenance 头注释被改也检测不到（`raw.indexOf("\n")` 之后才比）：

  ```
  # 在 hEvvs.js 第 1 行追加 " | REVIEWED-BY-ME"
  verify exit: 0 | note still on disk: false
  ```

- **影响**：文档指引用户去改一个会被静默还原的文件。这比单纯「少检测一个文件」更糟：它让正确的维护操作看起来生效了（本次运行 `build` 可能确实变了），下次 `verify` 之后又变回去，而且没有任何提示。
- **建议**：要么把 `modules.json` 纳入受保护范围（改动即拒绝，因为它是生成物），要么在 README 里明确「`modules.json` 是派生文件，不要手改」，并把依赖映射放进单独的、不被重写的文件。两者不应同时存在。同时把模块文件的比对改成整文件比对（含头注释），或明确指出头注释是生成物。
- **置信度**：确定

---

### [P1] `stripOverlayHeader` 会被用户自己的注释触发，整段许可声明从产物中消失

- **位置**：`tools/overlay.mjs:100-105`
- **现象**：声称的修复是「只识别 adopt 写的那一种头」。实际判定是**子串命中**：

  ```js
  const isAdoptHeader =
    /Overlay (module|fragment):/.test(header) || /Replaces (the minified module|src\/bundles)/.test(header);
  ```

  只要文件开头的 `/* ... */` 块里出现 `Overlay module:` 或 `Replaces src/bundles`，整块就被剥掉。用户在自己的许可/说明注释里写一句「Replaces src/bundles/... as of 2024」或「Overlay module: hEvvs — 我的笔记」，注释即被删除。
- **证据**：

  ```
  # overlay 以 @preserve 许可块 + 一句含魔法词的说明开头
  build exit: 0 | 10/10 bundles byte-identical
  dist retains the @preserve notice: false        <-- 许可声明没进产物
  overlay file retains it: true                   <-- 源文件里还在，只有产出丢了
  ```

  单元级：

  ```
  input : /*! @preserve MyLib v1\n * Replaces src/bundles/legacy.js as of 2024\n */
  output: 整块被剥除
  ```

  `eslint-disable` 头、`/*! @license */` 头（不含魔法词）则被正确保留——说明修复的方向对，但识别条件太宽。
- **影响**：许可声明、`@preserve` 通知、eslint 指令可能不进产物。对分发构建而言这有法律与合规含义；对开发而言，`eslint-disable` 被删会导致产物里出现本应被抑制的告警。`build` 报告 `10/10 byte-identical`（因为该 overlay 的内容与基线一致），进一步掩盖问题。
- **建议**：把识别条件收紧为**结构匹配**而非子串匹配：要求首行就是 `/*`、第二行完全等于 ` * Overlay module: <id>` 或 ` * Overlay fragment: <fragment>`、且块内存在 `Original size: <n> bytes` 行。或更稳妥：在头部写入一个不可伪造的标记（如 `generated-by: tools/adopt.mjs`），只认该标记。
- **置信度**：确定

---

### [P1] `readOverlayBody` 删除行尾空白，静默改写模板字符串的内容

- **位置**：`tools/overlay.mjs:117`（`body.replace(/[ \t]+$/gm, "")`）
- **现象**：声称的修复是「保留尾部换行以免 `//` 注释吞掉分隔符」。尾部换行确实保留住了（见已验证）。但同一行还有一个**全局**的行尾空白删除，它作用于整个文件，包括模板字符串内部。模板字符串中的行尾空格是**语义内容**，不是格式。
- **证据**：

  ```
  # overlay 里写：var __L = `A:    \nB`;
  overlay file middle line: "A:    "
  build exit: 0 | 9/10 bundles byte-identical
  shipped literal: "A:\nB"          <-- 4 个空格被删
  shipped == typed: false
  check: 0 | bundles.load: 0 | package: 0     <-- 所有校验都通过
  ```

  对照：单行普通字符串 `"A:    B"` 不受影响（`true`），说明问题只在跨行上下文。基线中 28 个文件含模板字符串，每一个都是潜在受影响面。
- **影响**：构建产物与开发者所写内容不一致，且所有校验（`check`、`bundles.load`、`package`、`consistency`）全部通过。用于对齐的文本（终端输出、help 文本、Markdown 片段）会静默错版。这是一类很难在 code review 里看出来的差异，因为源文件是对的、产物是错的。
- **建议**：不要做全局行尾 trim。只在**末尾**处理：剥掉文件结尾的空白行（`/\n\s*$/`），不要碰中间任何行。若确实想去掉格式化噪音，用 Prettier 对 overlay 再格式化一次（它是语法感知的，不会动模板内容），而不是正则。
- **置信度**：确定

---

### [P1] 位置写错的 overlay 被完全静默忽略，`build` 仍报 10/10 并据此打包

- **位置**：`tools/overlay.mjs:29-32`、`tools/build.mjs:113-130`；没有任何工具校验 `src/overlay/` 下的目录名/文件名是否对应真实模块
- **现象**：overlay 的查找是「按期望路径 `existsSync`」，从不反向检查「`src/overlay/` 里有没有对不上号的条目」。bundle 目录名少写哈希（`WebappCS` 而非 `WebappCS.8b5d7cd6`）、fragment 写成 `preamble.js` 而非 `00-preamble.js`、模块 id 拼错——三种都很容易发生，后果完全一致：文件被忽略，`build` 报 `10/10 byte-identical`，`check` 通过，`package` 成功。
- **证据**：

  ```
  # overlay 放在 src/overlay/WebappCS/99-epilogue.js（少了哈希）
  build exit: 0 | 10/10 bundles byte-identical
  build mentions overlays at all: false
  MY_EDIT reached dist: false
  check: 0 | package: 0 => 一个不含该修改的包被正常产出

  # fragment 命名为 preamble.js 而非 00-preamble.js
  10/10 bundles byte-identical | used: false
  ```

  `adopt --list` 能列出这些孤儿（`listOverlays` 只是遍历目录），但它不判断有效性：

  ```
  adopt --list shows it: true      # 对着不存在的 bundle 也照列
  ```

- **影响**：开发者以为改动已生效，实际产物里没有。由于 `build` 报 10/10（看起来很健康），这个错误可以一路带到发布。这是「守卫看起来存在、实际拦不住」的典型：没有任何东西会因为 overlay 未被使用而失败。
- **建议**：`build` 在扫描 overlay 时反向校验：每个 `src/overlay/<dir>/<name>.js` 必须能解析成 `(bundleDir, moduleId|fragment)` 且存在于 `index.json` 与对应 `modules.json`；对不上就 `exit 1` 并列出路径。`overlays in use: N` 与目录中的 overlay 总数不等时也应报错。
- **置信度**：确定

---

### [P1] 单个 overtay 的 `--force` 是全 argv 匹配；`--all --force` 一次性覆盖整包且无备份

- **位置**：`tools/adopt.mjs:28`（`const FORCE = process.argv.includes("--force")`）、`tools/adopt.mjs:240-262`（`--all` 循环）
- **现象**：声称的修复是「已有 overlay 时拒绝，需显式 `--force`」。单点保护成立（见已验证）。但两个放大面：
  1. `--force` 是**全局 argv 子串匹配**，与它出现在什么位置、用于什么目的无关。任何把 `adopt` 包在脚本里、且透传一个通用 `--force` 标志的调用，都会变成无提示覆盖。
  2. `--all` 与 `--force` 组合时，循环对每个模块各自判断，全部命中覆盖分支，没有二次确认、没有备份。
- **证据**：

  ```
  # 60 个 overlay 全部写上手改后
  $ node tools/adopt.mjs Main.00175a8f --all --force
  exit: 0 | 60 adopted, 0 skipped
  overlays before: 60, edits surviving: 0
  no confirmation, no backup dir: true
  ```

- **影响**：一次命令销毁一整包的手改。虽然需要用户主动输入 `--force`，但`--all` 的语义是「接管整包」，与 `--force` 叠加时用户预期的往往是「允许新建」，不是「允许全部覆盖」。
- **建议**：`--all` 遇到已存在的 overlay 时默认整体中止（而不是逐个跳过或全部覆盖）；`--force` 在 `--all` 模式下要求额外的显式标志（如 `--force-all`），并把被覆盖的文件复制到 `src/overlay.force-backup-<ts>/` 再写。`FORCE` 也应按位置解析（只在 `--force` 作为独立参数出现时生效，且拒绝 `--force=no` 这类形态）。
- **置信度**：确定

---

### [P1] 测试中断会让 `src/overlay/` 停留在 `overlay.stash-<pid>`，后续构建静默丢改

- **位置**：`tests/edit-safety.check.mjs:35-46`（`stashOverlays` / `restoreOverlays`）、`tests/overlay.check.mjs` 同型；`finally` 只在进程正常走到结尾时执行
- **现象**：声称的修复是「改为 `renameSync` 暂存 → 结束后恢复」（第二轮 P0-3）。正常路径成立（见已验证）。但恢复动作放在 `finally` 里，`SIGINT`/`SIGKILL`/断电/CI 超时都不会执行 `finally`。此时 `src/overlay/` 不存在，真实工作留在 `src/overlay.stash-<pid>/`，而**没有任何工具知道要去那里找**。
- **证据**：

  ```
  before: src/overlay = NOTES.md, WebappCS.8b5d7cd6
  # Ctrl-C 打断 edit-safety.check.mjs
  after : src/overlay exists = false
  after : src/ = bundles, overlay.stash-1896, overlay.stash-42560, overlay.stash-51632
  build: 10/10 bundles byte-identical | overlays: (none) | exit 0
  build mentions the stash: false
  ```

  连续两次中断后残留三个 stash 目录，`build` 依然报 10/10 且完全不提它们。`adopt --list` 也报 `no adopted modules yet`。

- **影响**：开发者的编辑「消失」了——它还在磁盘上，但构建不用它、测试不报错、`adopt --list` 看不见。用户很可能误以为改动没写进去而重做，或者更糟：以为已经发布而实际产物里没有。这是「数据没丢但等于丢了」的形态。
- **建议**：不要在测试里移动 `src/overlay/`。改为给被测进程注入一个独立的 overlay 根（环境变量，如 `VCAPTIONS_OVERLAY_DIR`），让测试在自己的临时目录里操作。若坚持 rename 方案，至少在 `build` / `adopt --list` 里检测 `src/overlay.stash-*` 并报警告，且在测试启动时自动恢复上一次的 stash。
- **置信度**：确定

---

### [P2] 编辑损坏文件后照做 `adopt`，会把损坏内容固化成 overlay

- **位置**：`tools/reconstruct.mjs:172-190`（edited 分支建议 `adopt`）、`tools/adopt.mjs:88-96`（`adopt` 不校验内容完整性）
- **现象**：守卫发现「文件与基线不符」时，一律判定为「手改」并建议 `adopt`。但「不符」同样可能来自**写坏/截断**。`adopt` 只做 Prettier 格式化，对**片段**（preamble/epilogue）完全不做校验，原样复制。于是损坏内容被提升为「可编辑源码」，而 `src/bundles/` 里的原始内容被丢弃。
- **证据**：

  ```
  # 把 epilogue.js 从 9779 字节截断到 5782 字节，然后照守卫建议操作
  verify exit: 1 | refuses: true
  adopt exit: 0                      <-- 截断内容被接管
  # 恢复 src/bundles/ 的原始副本（守卫的建议隐含此举安全）
  build exit: 1 | 9/10 bundles byte-identical
  build FAILED — 1 bundle(s) do not parse
  ```

  同一个 epilogue 的纯注释型改动则完全合法：

  ```
  # 在 globalThis.define 前插入 /*MY-REAL-WORK*/
  adopt exit: 0 | overlay captured the edit: true     <-- 这一条是对的
  ```

  即：`adopt` 无法区分「编辑」与「损坏」，两者都照收。片段路径没有 Prettier 作为最后一道语法闸门。
- **影响**：损坏被固化成「源码」，原始正确内容被覆盖。好在 `build` 的语法校验拦住了这一次（`exit 1`，`dist` 未替换——见已验证）。但若损坏恰好仍能解析（截断在语句边界、编码错乱替换成合法字符），则会进入产物。GBK 案例证明了「能解析但内容是错的」确实会发生。
- **建议**：`adopt` 在写 overlay 之前先对拼接后的完整 bundle 做一次语法校验（模块路径可复用现有 `new Function` 检查，片段路径需要拼回 bundle 再 `new vm.Script`）；失败则拒绝并提示「这看起来是损坏而不是编辑，请从基线恢复」。
- **置信度**：较高（截断能否越过语法闸门取决于截断点；已实测一种截断被拦住，但 GBK 案例证明存在能越过的情况）

---

### [P2] GBK 编码的 overlay 被静默转成 U+FFFD，全链路无报错

- **位置**：`tools/overlay.mjs:115`（`fs.readFileSync(file, "utf8")`）、`tools/build.mjs` 写回同样是 `"utf8"`
- **现象**：以 GBK 保存的 overlay（中文 Windows 编辑器的常见默认）会被按 UTF-8 解码，非法字节变成 `U+FFFD` 替换符，然后原样写进产物。没有任何环节校验编码。
- **证据**：

  ```
  build exit: 0 | 9/10 bundles byte-identical
  check exit: 0
  bundles.load exit: 0 | 9 loaded, 0 failed
  dist contains replacement chars: true | occurrences: 4
  dist snippet: "__TITLE = \"\uFFFD\uFFFD\uFFFD\uFFFD\";"
  ```

  同一份 overlay 在源文件里是合法的 GBK `测试`，产物里是 4 个替换符。

- **影响**：中文文案损坏后进入产物，且语法有效、加载成功、所有校验通过——只能在运行时肉眼发现。README 已经警告过 PowerShell 的编码陷阱（第 187/227 行），但警告针对的是 `src/bundles/`，且防线是「人记得用对的编辑器」，没有任何工具兜底。
- **建议**：读 overlay 后检查 `\uFFFD` 出现（或做严格 UTF-8 解码，`TextDecoder("utf-8", {fatal:true})`），命中即 `exit 1` 并指出文件与行号。这是廉价且高价值的健全性检查。
- **置信度**：确定

---

### [P2] `adopt --all` 部分失败仍 `exit 0`，留下半接管状态

- **位置**：`tools/adopt.mjs:245-262`
- **现象**：`--all` 对每个模块逐个 `try/catch`，失败只打印 `skip` 并自增计数，最终 `exit 0`。中途失败（模块无法格式化）会留下「部分已接管、部分未接管」的混合状态，且脚本退出码不反映这一点。
- **证据**：

  ```
  # 破坏 Main.00175a8f 的第 6 个模块后跑 --all
  exit: 0
  summary: 59 adopted, 1 skipped
  skip lines: skip 35oVN: module 35oVN could not be formatted (Unexpected token (1:3878))
  overlays now: 59
  ```

- **影响**：这是 `review/round-2/README.md` 已列入「已知限制」的项（`adopt --all` 中途失败留半成品），但「已知」的是**留半成品**；这里补充的新证据是**退出码仍为 0**，因此任何 `set -e`/`&&` 链都无法察觉。影响面因此比「已知」更大。
- **建议**：只要有 skip，`exit 1`（或 `exit 2` 表示部分成功），并把失败的模块 id 汇总到最后一行。
- **置信度**：确定

---

### [P2] 损坏的符号链接下 `adopt` 会写到链接目标

- **位置**：`tools/adopt.mjs:106`（`fs.existsSync(dest)`）
- **现象**：`fs.existsSync` 对**悬空**符号链接返回 `false`，因此「已存在则拒绝」不触发；随后的 `writeFileSync` 顺着链接写到目标路径。
- **证据**：

  ```
  # 在 overlay 路径放一个指向不存在文件的 symlink
  symlink created -> target exists: false
  adopt exit: 0 | adopted WebappCS.8b5d7cd6/hEvvs
  wrote through link to outside: true
  ```

- **影响**：在 overlay 目录被人为构造成链接（迁移、备份工具、某些同步盘）时，`adopt` 会写到预期之外的位置，而 `src/overlay/` 里留下一个悬空链接，构建随后读不到内容。属边缘场景，但「防覆盖」的判断依据在这里失效。
- **建议**：用 `fs.lstatSync` 判断存在性（它能看到悬空链接），命中即拒绝，而不是 `existsSync`。
- **置信度**：确定

---

### [P2] 文件夹名大小写与 `index.json` 不一致时，overlay 查找与 F 后续判断可能分歧

- **位置**：`tools/overlay.mjs:29-32`（路径由 `path.join` 拼接，无大小写归一化）；`tools/build.mjs:106-112`
- **现象**：Windows 上 `src/overlay/webappcs.8B5D7CD6/` 与 `WebappCS.8b5d7cd6` 指向同一目录，因此查找「碰巧」命中。实测该 overlay **未被使用**，且 `build` 直接失败：

  ```
  build exit: 1 | CASE_EDIT reached dist: false
  build output mentions overlay: true
  ```

  这是**同一条路径在不同调用点解析结果不同**的迹象（`existsSync` 命中 vs 后续按原字符串比对）。在大小写敏感的文件系统（Linux CI、macOS 默认）上，同一份仓库会得到完全不同的结果。
- **影响**：跨平台行为分歧。在 Windows 上错误的大小写被掩盖，切到 Linux CI 才暴露；或者反过来，Windows 上因为 `existsSync` 命中而认为 overlay 生效，实际构建用了别的判断。属于可移植性缺陷，非数据丢失。
- **建议**：从 `index.json` 取权威 bundle 目录名做精确等值比较（`===`），不要依赖文件系统的大小写折叠；`adopt` 写目录前也校验名字与 `index.json` 一致。
- **置信度**：较高（现象确定，根因需要更细的插桩才能指到具体那一行）

---

## 已确认无问题的部分

以下都是构造反例并实际执行后**确实被拦住**的，列出来避免后续重复验证。

### `reconstruct.mjs` 手改检测

| 攻击 | 结果 |
| --- | --- |
| 模块正文改一个字节 | 拒绝，`exit 1`，指名 `hEvvs.js`，建议 `adopt` 命令，编辑留在磁盘上 |
| 模块文件只有头注释、没有正文 | 拒绝（`exit 1`） |
| 模块文件被截断在正文中间 | 拒绝，指名文件 |
| 纯空白改动（`, ` → ` ,`） | 拒绝（字节比对，无「规范化」后门） |
| epilogue / preamble 内容被改 | 拒绝，分别指名 fragment |
| `modules.json` 被删除 | 拒绝，`exit 1`，说明「cannot verify」 |
| `modules.json` 内容不是合法 JSON（`{ not json`） | 拒绝 |
| `modules.json` 内容为 `null` | 拒绝 |
| `modules.json` 为 0 字节 | 拒绝 |
| `index.json` 被删除 + 存在手改 | **拒绝**（第二轮「不再依赖 index.json」这条修复成立） |
| `index.json` 被手工加字段 | 拒绝（该文件被整体重写这件事本身会被拦下） |

### `overlay.mjs` 边界

| 攻击 | 结果 |
| --- | --- |
| 尾部 `foo() // note` | 保留一个 `\n`，拼接后两个模块都注册（`ids=x,y`） |
| 尾部 `//` 注释 + 3 个空行 | 正常（`"te\n"`），两个模块都注册 |
| 尾部 `//` 注释后跟行尾空格 | 正常 |
| 尾部块注释 `/* block */` | 正常，不需要额外换行 |
| 行内 `//`（字符串 `"http://a"` / 正则 `/ab\/\//`） | 换行被保留（保守，无害） |
| CRLF 文件 | 归一化正确，产物 CR 计数 0，`10/10 byte-identical` |
| 仅 CR 行尾 | 正常处理 |
| UTF-8 BOM | 正确剥离，头注释照常识别 |
| UTF-16LE overlay | 构建 `exit 1` 并报语法错误，`dist` **逐字节未变**（mtime 也未变） |
| 空 overlay（0 字节） | 构建 `exit 1`，`dist` 未替换 — 安全失败 |
| 只含头的 overlay（无正文） | 同上，`exit 1` |
| 只含头的 overlay 但内容为 `;`（可解析） | `exit 1`（该 bundle 只有 1 个模块，分隔符变非法） — 安全失败 |
| 空 preamble overlay | `exit 1` — 安全失败 |
| 多模块 bundle 里某模块被空 overlay 替换 | `Unexpected token ','`，`exit 1` |

### `adopt.mjs` / 构建原子性 / 其它

| 攻击 | 结果 |
| --- | --- |
| 二次 `adopt` 同一模块 | 拒绝，`exit 1`，提示删除或 `--force`，编辑存活 |
| `--force` | 按设计覆盖（`exit 0`） |
| `adopt --epilogue` 后再构建、不做任何编辑 | `10/10 byte-identical`，产物与基线逐字节相同（19703→19903 字节一致） |
| 构建失败（UTF-16 / 语法错） | `dist` 逐字节保持不变，mtime 不变，打印 `left unchanged` |
| `build` 暂存 + 原子替换 | `dist` 在失败时不被半覆盖（第四轮 P2-1 的修复成立） |
| `adopt --all` 首次运行 | 正常接管 60/60 |
| `index.json` 缺失时的 `build` / `format` | `exit 2` 并给出指引（正确拒绝） |

### 其它「可以放心」的观察

- `adopt` 生成的 overlay 头 + 正文，剥头后与 `src/bundles/` 原文**逐字节相同**（`overlay body (after header) equals source: true`）。
- 被 `adopt` 的模块不做任何编辑时，产物与基线逐字节一致（`dist === baseline: true`）。
- `parcel-split.mjs --check` 的独立结构校验本身是有效的：它能发现「模块被搬进分隔符」「模块被删」「一字节改动」「epilogue 改动」「模块集合被 manifest 削弱」。问题在于 `reconstruct.mjs` 的手改检测**没有复用它**。

## 未覆盖的范围

- **`adopt --preamble` 的端到端行为**：只验证了「空 preamble overlay 会让构建安全失败」，没有构造一个非空的、语义正确的 preamble overlay 并验证它进入产物。
- **多字节边界以外的编码**：除 UTF-8/UTF-8 BOM/UTF-16LE/GBK 外，未测试 UTF-32、Latin-1、含 `\r\n` + BOM 组合。
- **并发**：未测试两个 `reconstruct` 或 `build` 同时运行时的相互破坏（`dist`/`.dist-staging` 是固定路径，理论上会冲突）。
- **kill 在 `dist` 交换窗口内**：`rmrf(DIST); renameSync(STAGING, DIST)` 之间存在一个 `dist` 不存在的窗口。未对该窗口做精确的 SIGKILL 扫频（只扫了 `reconstruct` 的写窗口）。
- **符号链接的大小写根因**：只记录了现象（overlay 未被使用 + 构建失败），未插桩定位到具体是哪一次路径比较产生了分歧。
- **`package.mjs` 的字段完整覆盖面**：只确认缺少 bundle 时 `package` 会 `exit 2`（正确），没有穷举其 preflight 的每个分支。

## 方法论说明：如何在沙箱里做破坏性实验

所有破坏性操作都在 `fs.cpSync` 出来的项目副本中进行（`%TEMP%\vcap-r4`，54 MB / 387 文件，含 `assets/baseline`、`src/bundles`、`tools`、`tests`、`node_modules`）。真实工程 `src/bundles/` **未被修改**——收尾时用独立脚本逐模块比对 `sha256`（`modules with body mismatch: 0`）、确认 `src/overlay` 不存在、并跑通 `reconstruct --verify`（`all bundles reassemble byte-for-byte`）。

每个实验前都调用 `_lab/reset.mjs` 从真实工程重新复制 `src/bundles` 与 `assets/baseline`，确保攻击之间不互相污染。
