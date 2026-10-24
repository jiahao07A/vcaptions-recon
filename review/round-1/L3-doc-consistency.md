# 文档与事实一致性（L3）审查报告

审查者：L3 subagent（文档与事实一致性层）
审查范围：`README.md`、`docs/architecture.md`、`docs/navigation.md`、`docs/testing-in-browser.md`、`docs/architecture.generated.json`、`docs/symbol-index.json`、`docs/symbol-index.md`、`review/README.md`（自指检查）
审查时间：2026-10-21T08:30:00Z
基线：`assets/baseline/extension-v2.4.6`，Chrome 155.0.8059.85，Node v26.5.0，PowerShell 5.1

> 说明：本审查开始时 `review/round-1/` 为空；`L1-build-integrity.md` 与 `L2-test-effectiveness.md` 在审查过程中落盘。事后比对确认：**本报告的全部数字类发现（1,657、1,939、3.88 MB、57,140、22,393、`createSlice`、36 个模块、`REQUEST_MOUNT_SUBTITLE_BAR` 行号、`sidepanel__` 路径、`b94973b4` 哈希、29 处 chrome 调用）在 L1/L2 中均无对应条目**（逐串 grep 计数为 0）。
>
> 有两处**相邻但不重复**，特此交叉引用：
> - L1 的 P3「`modules.json` 的 `dependencies` 字段大面积错误，且 `docs/navigation.md` 把它当作权威」从**拆分器实现**角度切入；本报告从**文档指引可执行性**角度切入（`docs/navigation.md:179` 的跨模块改动指引），两者互补。
> - L2 的 P2「`consistency.check.mjs` 只比对两份预生成 JSON，不重新运行提取器」指出该测试**不检查产物是否过期**；本报告的 P1「`consistency.check.mjs` 的 i18n 检查是同义反复」指出该测试**即便产物是新的也永远为真**。两者是同一文件的两个独立缺陷，修复方式不同。

## 结论摘要

文档的可运行工作流是可靠的（`build` 10/10、`test` 全绿、`verify` 拒绝覆盖、`verify:browser` 逐项通过，全部实测复现），但**事实层不可信**：`architecture.generated.json` 自称"自动提取的事实基准"，其中的 `storage_keys` 有 **6/14 是 UI 翻译键、不是存储键**，同时又**漏掉至少 11 个真实存储键**；`docs/symbol-index.md` 因此把 i18n 键渲染成"存储键"表；`tests/consistency.check.mjs` 对这两点完全失明，并输出 "ok storage keys do not contain i18n translation keys" 的假阳性。叠加 `README.md` 把 `Main` 的 57,140 行写成 `sidepanel`/`tab-main` 的行数（实际 58,439 / 57,140 / 57,140，三者并不相同），文档在"哪些数字是对的"这一层给出的信号是反的：能自动校验的数字全对，不能自动校验的数字多处错。

## 发现

### [P1] `architecture.generated.json` 的 `storage_keys` 混入 6 个 i18n 翻译键，且漏掉 11 个真实存储键

- **位置**：`docs/architecture.generated.json:671`（`storage_keys` 数组）；产出该字段的正则是 `tools/audit.mjs:118`；被文档引用处 `docs/architecture.md:159-170`、`README.md:202`、`docs/navigation.md:11`
- **现象**：`storage_keys` 声称是 "chrome.storage / IndexedDB 的键名（来自审计工具的实际提取结果）"，共 14 个。实测其中 6 个是 UI 文案键，在产物中以 `e("key")` / `t("key")` 的形式做 i18n 查表，从不进入 `chrome.storage.*`：

  | 键 | 实际用途 | 证据 |
  | --- | --- | --- |
  | `chapterNavigation_deleteSession` | i18n 查表 | `Main.00175a8f.js` 中 `title:e("chapterNavigation_deleteSession")` |
  | `chapterNavigation_noChapterInfo` | i18n 查表 | `children:e("chapterNavigation_noChapterInfo")` |
  | `transcription_deleteSession` | i18n 查表 | `title:i("transcription_deleteSession")` |
  | `videoControlBar_noVideoInfo` | i18n 查表 | `q.warn(t("videoControlBar_noVideoInfo"))` |
  | `websiteConfigBtn_websiteConfig` | i18n 查表 | `label:r("websiteConfigBtn_websiteConfig")` |
  | `websiteConfig` | i18n 查表 | 出现在内联翻译字典 `"websiteConfig":"网站配置"`；后台 bundle 中**不存在**带引号的 `"websiteConfig"` 字面量 |

  同时漏掉的真实存储键（每个都能在产物里找到读写点）：

  | 真实键 | 证据 |
  | --- | --- |
  | `vcaptions-auth-token` | `lY.set(Gy,I)` / `lY.get(Gy)`，`lY=new Gu({area:"local"})` |
  | `vcaptions-auth-refresh-token` | `lY.set(GF,G)` / `lY.get(GF)` |
  | `vcaptions-auth-user` | `lY.set(GA,l)` / `lY.get(GA)` |
  | `vcaptions-global-settings` | `la.get(Gk)` / `la.watch({[Gk]:...})` |
  | `vcaptions-temp` | `getDefaultValue` 的 `case Gw:`，以及 `storage.local.set({[Gw]:...})` 迁移路径 |
  | `vcaptions-env` | `storage.sync.get(GV)` + `getDefaultValue` 的 `case GV:` |
  | `analytics_identify_throttle` | `storage.local.get(ln)` / `.set({[ln]:...})` / `.remove(ln)` |
  | `analytics_pending_event` | `storage.local.get(uO)` / `.set({[uO]:...})` / `.remove(uO)` |
  | `posthog_distinct_id` | `storage.local.get("posthog_distinct_id")` |
  | `vcaptions-website:<domain>` | `` `${Go}${l}` `` 作为 `storage.local.get(t)` 的键（`Go="vcaptions-website:"`） |
  | `persist:redux`（redux-persist 的命名空间键） | `new Gu({area:"sync"}).watch({[\`persist:${Nr.key}\`]:...})` |

- **证据**：

  ```
  $ node -e "..."   # 按 audit.mjs 的同一正则重跑，并检查是否为 i18n 查表
  inlined i18n dictionary keys found: 898
  chapterNavigation_deleteSession     inI18nDict=true  usedAsLookup=true  <-- i18n key, NOT a storage key
  chapterNavigation_noChapterInfo     inI18nDict=true  usedAsLookup=true  <-- i18n key, NOT a storage key
  transcription_deleteSession         inI18nDict=true  usedAsLookup=true  <-- i18n key, NOT a storage key
  videoControlBar_noVideoInfo         inI18nDict=true  usedAsLookup=true  <-- i18n key, NOT a storage key
  websiteConfig                       inI18nDict=true  usedAsLookup=false <-- i18n key, NOT a storage key
  websiteConfigBtn_websiteConfig      inI18nDict=true  usedAsLookup=true  <-- i18n key, NOT a storage key
  ```

  ```
  $ node -e "..."   # 检查 websiteConfig 是否出现在任何 chrome.storage 调用里
  === is there a literal storage key 'websiteConfig'? ===
    NO — websiteConfig never appears in a chrome.storage.* call
  ```

  ```
  $ node -e "..."   # 从产物反推真实存储键
  === storage keys reachable from chrome.storage.* calls ===
    G$ -> vcaptions_log_config
    GV -> vcaptions-env
    ln -> analytics_identify_throttle
    posthog_distinct_id
    uO -> analytics_pending_event
  === new Yh(...) storage managers ===
    Yh(GX = "videoInfo") / Yh(GR = "chapterInfo") / Yh(Gg = "subtitleInfo")
    Yh(Gv = "subtitleContentInfo") / Yh(GH = "chatSession") / Yh(GO = "noteInfo")
  ```

- **影响**：这是本次审查发现的最严重的"事实与推断混淆"。`architecture.generated.json` 被 `README.md` 描述为"架构事实（自动提取）"，`docs/navigation.md:11` 直接引用"14 个存储键"，`docs/symbol-index.md` 把 `chapterNavigation_deleteSession` 这类翻译键渲染成"存储键"并给出 `Main.00175a8f/99-epilogue.js:33444` 之类的"精确定位"。任何按文档去读/写存储键的人都会拿到一张**一半是错的一半是缺的**清单。特别注意 `vcaptions-auth-token` 这类账号令牌键被完全遗漏——这是排查登录问题的第一入口。
- **建议**：`tools/audit.mjs` 的 `storageKeys` 正则改为"出现在 `storage.*.get/set/remove` 参数位或存储管理器构造参数位"的键，而不是靠词形后缀猜；把 i18n 键单独归入 `i18n_keys` 字段；补齐 `vcaptions-*` 前缀键与 `persist:*` 动态键。`tests/consistency.check.mjs` 的 i18n 检查必须改为"该键在产物中是否被 `t("...")` 形式查表"，而不是仅比对 `fromAudit` 是否包含它（见下一条）。
- **置信度**：确定（6 个 i18n 键与 11 个遗漏键均逐条给出产物中的字面量上下文）

### [P1] `tests/consistency.check.mjs` 的 i18n 检查是同义反复，输出假阳性 "ok"

> 与 L2 的 P2「`consistency.check.mjs` 只比对两份预生成 JSON」是**不同缺陷**：L2 指出该测试不重新运行提取器（产物过期则失效），本条指出即使产物是最新的，这个断言在逻辑上也永远为真。两条都需修复。

- **位置**：`tests/consistency.check.mjs:97-105`
- **现象**：该检查的目的应是"确认 `storage_keys` 里没有混入 i18n 键"。实现是：

  ```63:70:tests/consistency.check.mjs
      const i18nLooking = [...fromIndex].filter((k) =>
        /^(chapterNavigation|videoControlBar|websiteConfigBtn|transcription|subtitleBar|sidePanel)_/.test(k) &&
        !fromAudit.has(k),
      );
      check(
        "storage keys do not contain i18n translation keys",
        i18nLooking.length === 0,
        i18nLooking.slice(0, 4).join(","),
      );
  ```

  `fromIndex` 是 `symbol-index.json` 的 `storage_key` 类目，而 `tools/index-symbols.mjs:127` 的 `storage_key` 恰恰是**从 `audit.storage_keys` 直接读入**的。于是 `fromIndex ⊆ fromAudit` 恒成立，`!fromAudit.has(k)` 恒为 `false`，`i18nLooking` 恒为空数组。这个断言**不可能失败**。

- **证据**：

  ```
  $ grep -n "audit.storage_keys" tools/index-symbols.mjs
  127:      const keys = audit.storage_keys;
  ```

  ```
  $ npm run test:consistency
  ok    storage keys agree with audit
  ok    storage keys do not contain i18n translation keys
  ```

  两条断言都通过，而 `storage_keys` 里实际有 6 个 i18n 键（见上一条）。这是一次典型的"测试保护了错误的实现"。

- **影响**：`known-issues.md` 第 9 条声称"符号索引把 90 个 i18n 键当成存储键 → 改为从审计结果动态加载（14 个）"已修复。实际修复方式是**让索引无条件信任审计**，而审计本身的正则仍然会误捕 i18n 键。问题从"索引自己误捕"变成"审计误捕后索引照抄"，**净效果没有改善**，只是错误被搬到了更上游、并被一个永真断言盖住。
- **建议**：断言改为"`storage_keys` 中每个键都必须在产物里出现于 `chrome.storage.*` 的键位（或存储管理器构造参数位）"。更简单可靠的写法：对每个键检查是否存在 `storage.(local|sync|session)\.(get|set|remove)\(` 或 `` `[^`]*` `` 模板拼接的同域证据，找不到就 fail。
- **置信度**：确定（同义反复可静态证明；假阳性已实测复现）

### [P1] `Main` / `sidepanel` / `tab-main` 的 epilogue 行数被写成同一个 57,140，实际三者不同

- **位置**：`README.md:51`、`README.md:196`、`README.md:234`、`docs/navigation.md:116`
- **现象**：四处都称 `Main`、`sidepanel`、`tab-main` "共享同一套代码（57,140 行 epilogue）"，`README.md:196` 更明确指向 `src/readable/Main.00175a8f/99-epilogue.js`（57,140 行）。实测三个文件行数不同，且 `Main` 最大：

  | 文件 | 行数（编辑器口径） | 字节 |
  | --- | --- | --- |
  | `src/readable/Main.00175a8f/99-epilogue.js` | **58,439** | 5,209,709 |
  | `src/readable/sidepanel.65d86198/99-epilogue.js` | 57,140 | 4,747,809 |
  | `src/readable/tabs__tab-main.1e0435ca/99-epilogue.js` | 57,140 | 4,747,801 |

  对应的压缩前 epilogue 也不相同：`Main` 4,085,383 B（291 行）、`sidepanel` 3,875,352 B（291 行）、`tab` 3,875,345 B（291 行）。

- **证据**：

  ```
  $ node -e "..."   # 逐文件统计 LF 与 split 长度
  Main       LF= 58438 splitLen= 58439 endsWithNL=false editorLines=58439
  sidepanel  LF= 57139 splitLen= 57140 endsWithNL=false editorLines=57140
  tab        LF= 57139 splitLen= 57140 endsWithNL=false editorLines=57140
  ```

  ```
  $ node -e "..."   # 压缩前 epilogue 字节
  Main: epilogue 4085383 B
  sidepanel: epilogue 3875352 B
  tab: epilogue 3875345 B
  ```

  ```
  $ node -e "..."   # 三者是否真的一样
  sidepanel === tab ? false
  Main === sidepanel ? false
  Main vs sidepanel first difference at char 5
  Main:  appType literals = ,I.appType,,cs
  side:  appType literals = ,t.appType,,sidepanel
  tab:   appType literals = ,t.appType,,tab
  ```

- **影响**：`README.md:196` 的表格告诉读者"改字幕列表 UI → 打开 `Main.00175a8f/99-epilogue.js`（57,140 行）"。文件实际 58,439 行，差 1,299 行。`docs/navigation.md` 随后声称"行号可直接跳转"——但 navigation.md 里所有行号都取自 `static__background__index` 或 `SubtitleBar`，与 `Main` 无关，所以这条错数字尚未导致跳错行；但它是"文档数字与实际不符"历史问题（`known-issues.md` 第 4/8 条）的**复发**，且这次的数字被 `tests/consistency.check.mjs` 的 `forbidden` 列表（`/57,114/`）反向固化了：测试只禁止 57,114，不禁止把 57,140 用到 `Main` 上。
- **建议**：把三者的行数分别写清（58,439 / 57,140 / 57,140），并在 `tests/consistency.check.mjs` 增加"`README.md` 中每个 `<path>（<N> 行）` 形式的断言，N 必须等于该文件实际行数"的检查，这样这类错误无法再靠人工记忆通过。
- **置信度**：确定

### [P1] `docs/navigation.md` 的 `REQUEST_MOUNT_SUBTITLE_BAR` 行号指向错误语句

- **位置**：`docs/navigation.md:97`
- **现象**：文档写 `REQUEST_MOUNT_SUBTITLE_BAR  ← 第 20699 行`。第 20699 行实际是 `GC(Gz).tabs.sendMessage(I, { action: "vcaptions_subtitle_bar_mount" }),`——该处理器内部的一行，不是处理器定义。处理器定义在 **20,694** 行。

- **证据**：

  ```
  $ grep -n "^ *REQUEST_MOUNT_SUBTITLE_BAR:" src/readable/static__background__index/99-epilogue.js
  20694:          REQUEST_MOUNT_SUBTITLE_BAR: async (I, G) => {
  ```

  ```
  $ sed -n '20694p;20699p' src/readable/static__background__index/99-epilogue.js
  20694:          REQUEST_MOUNT_SUBTITLE_BAR: async (I, G) => {
  20699:                  GC(Gz).tabs.sendMessage(I, { action: "vcaptions_subtitle_bar_mount" }),
  ```

  同一节里另外两个行号是对的：`CREATE_TRANSLATE_SESSION` 在第 21097 行（一致）、`GET_SUBTITLE_BAR_STATE` 在第 20641 行（一致）。所以这是三个引用里唯一错的一个，属于孤立偏差而非系统性偏移。

- **影响**：读者跳到 20,699 会看到一行 `sendMessage`，误以为找到了处理器入口；在该行附近编辑不会改变处理器本身的行为。因为偏离只有 5 行，读者很难察觉"找错了"。
- **建议**：改为 20,694。更好的做法是把 navigation.md 的行号改为符号名 + `grep` 命令（该文档已经提供了 grep 示例，两者并存反而制造了两套可能漂移的坐标）。
- **置信度**：确定

### [P1] `docs/architecture.md` 称三者模块"体积完全一致"，实际有 2 个模块的体积互换

- **位置**：`docs/architecture.md:43`
- **现象**：文档写 "`Main`、`sidepanel`、`tab-main` 三者共享同一套 60 个模块（按序号逐位比对，体积完全一致），差异仅在 Parcel 生成的变量名混淆"。实测 `Main` 与 `sidepanel` 在第 9、10 号模块上体积互换：`Main` 是 9,523 B + 814 B，`sidepanel` 是 814 B + 9,523 B。总和相同，但**逐位比对并不一致**。`sidepanel` 与 `tab` 确实逐位一致（0 处不匹配）。

- **证据**：

  ```
  $ node -e "..."
  module byte mismatches Main vs sidepanel: 2
  module byte mismatches sidepanel vs tab: 0
  sum module bytes Main=658317 sidepanel=658317 tab=658317
  idx=9  Main: id=hEvvs bytes=9523 | sidepanel: id=42ziu bytes=814  delta=8709
  idx=10 Main: id=3Yofd bytes=814  | sidepanel: id=gP5Ja bytes=9523 delta=-8709
  ```

- **影响**：文档这句话的作用是证明"三者同源"，但给出的**验证方法**（按序号逐位比对体积）恰恰会得出"不完全一致"的结论。把"顺序不同"表述成"完全一致"，属于把观察结论写得比证据更强。真实情况是：三者模块集合相同、总体积相同，但 `Main` 的模块排列顺序与另外两者有两处交换（`hEvvs` 与 `3Yofd` 位置互换）。这不影响"同源"的判断，但影响任何按序号对齐三个 bundle 的工具或读者。
- **建议**：改为"三者模块集合与总体积相同（658,317 B），但 `Main` 有两个模块的排列顺序与 `sidepanel`/`tab-main` 不同；`sidepanel` 与 `tab-main` 逐位一致"。
- **置信度**：确定

### [P1] `README.md:23` 的 "业务代码（3.88 MB / 1939 个函数）" 两个数字都无法复现

- **位置**：`README.md:23`
- **现象**：该行称"业务代码（3.88 MB / 1939 个函数）被 Parcel 内联进入口作用域"。实测：
  - **3.88 MB** 只对 `sidepanel` / `tab-main` 的**压缩前** epilogue 成立（3,875,352 B = 3.88 MB 十进制）。`Main` 是 4,085,383 B（4.09 MB），后台是 2,793,187 B（2.79 MB）。若指**全部 10 个 bundle** 的 epilogue 总和，是 16,064,524 B（16.06 MB）。若指**可读视图**，`sidepanel` 是 4,747,809 B（4.75 MB）。所以 "3.88 MB" 只在"单指 sidepanel 的压缩 epilogue"时成立，而该句的语境是"业务代码被内联进入口作用域"这一**全局**论断。
  - **1939 个函数**在 10 个 bundle 中**没有任何一种计数方式能得到**。`sidepanel` 压缩 epilogue 的实测计数：`function` 关键字 2,348 个、具名函数声明 1,097 个、匿名 `function(` 1,084 个、`=>` 3,545 个、`=>{` 1,835 个、`class` 82 个。各种组合（2,181 / 2,932 / 4,016 / 5,893 …）都不等于 1,939。产物中字面量 `1939` 出现 **0 次**。
  - `docs/rea-evidence/*.txt` 中也没有 `1939` 或 `3.88` 的出处。

- **证据**：

  ```
  $ node -e "..."
  --- sidepanel bundle epilogue ---
    3875352 bytes            (3.88 MB decimal / 3.70 MiB)
    2348  function keyword
    1097  function decls named
    1084  anon function(
    3545  arrow =>
    1835  arrow =>{
    82    class
  literal '1939' occurrences: 0
  ```

  ```
  $ node -e "..."   # 全部 10 个 epilogue 汇总
  TOTAL epilogue bytes=16064524 (15.32 MB, 16.06 MB-decimal)
  ```

  ```
  $ cmd /c findstr /i /c:"1939" /c:"3.88" docs\rea-evidence\*.txt
  (no output)
  ```

- **影响**：这是 `README.md` 开头"先说清楚还原到了什么程度"一节里的关键论据，用来说明"模块边界已丢失"。数字错了不会让结论错，但会让读者以为存在一个可复算的量化依据。若有人按 1939 去核对，会发现无法复现，进而怀疑整节的可信度。
- **建议**：删除 "1939 个函数"，或改为可复现的表述并附命令（例如"`sidepanel` 的入口作用域有 1,097 个具名函数声明"）。"3.88 MB" 需注明是"`sidepanel`/`tab-main` 单个 bundle 的压缩前 epilogue"，或改为全部 10 个 bundle 的 16.06 MB。
- **置信度**：确定（1939 不可复现）；"3.88 MB 对应 sidepanel"为较高（数值精确吻合，但文档未注明所指对象）

### [P1] "1,657 条去重中文文案" 无法用任何合理定义复现，最接近的定义给出 1,646

- **位置**：`docs/architecture.md:176`、`README.md:233`；`tests/consistency.check.mjs:167` 把它写成了"正确答案"
- **现象**：文档称"1,657 条去重中文文案（45,007 个 CJK 转义序列）"。其中 **45,007 可以精确复现**（把 CJK 标点 `U+3000-303F`、汉字 `U+4E00-9FFF`、全角 `U+FF00-FFEF` 合并统计，`dist` 与 baseline 都得 45,007）。但 **1,657 无法复现**。逐一试过的定义与结果：

  | 定义 | 结果 |
  | --- | --- |
  | 去重 `\u` 连续串，含 ≥2 个 CJK 联合字符 | **1,646** |
  | 去重 `\u` 连续串，总长 ≥2 | **1,646** |
  | 去重串，去掉首尾标点后 ≥2 字符 | 1,617 |
  | 去重串，含 ≥2 个汉字 | 1,635 |
  | 去重串，含 ≥3 个 CJK 联合字符 | 1,437 |
  | 去重串，全为 CJK 且长 ≥2 | 1,643 |
  | 去重字符串字面量（含 CJK） | 1,178（`dist`）/ 1,503（`readable`） |
  | 去重串（不限 CJK，`\u` 连续 ≥2） | 1,664 |
  | 内联 i18n 字典中值含 CJK 的键 | 945 |
  | 去重 i18n 翻译值 | 822 |

  `dist`、`src/readable`、`src/bundles`、`assets/baseline` 四个树的对应值完全相同（1,646），说明不是"取错了树"。`docs/rea-evidence/*.txt` 中没有 1,657 的出处，`tools/` 与 `tests/` 中也没有任何代码计算这个数。

- **证据**：

  ```
  $ node --max-old-space-size=6144 ...   # CJK 联合范围
  --- dist ---
    CJK-union escapes: 45007
    distinct runs with >=2 CJK-union chars: 1646
  --- assets/baseline/extension-v2.4.6 ---
    CJK-union escapes: 45007
    distinct runs with >=2 CJK-union chars: 1646
  ```

  ```
  $ grep -rn "1657" tools/ tests/
  tests/consistency.check.mjs:167:    { pattern: /7698 处中文文案/, why: "7698 was wrong; the count is ~1657 distinct strings" },
  ```

- **影响**：`known-issues.md` 第 7 条把 7,698 改为 1,657，`tests/consistency.check.mjs` 又把 1,657 写进注释当作"正确答案"。**修正本身引入了一个新的不可复现数字**，而且它现在被测试保护着——任何人想改成 1,646 都会显得是在"回退已知修复"。这是本工程"文档数字"问题的核心模式：每次修正都用一个未经复算的数字替换旧数字。
- **建议**：先确定"中文文案"的定义（建议：去重后的 i18n 键数 945，或去重后的翻译值 822，两者都可解释且可复现），再写进文档，并把计算逻辑加到 `tools/audit.mjs` 输出到 `architecture.generated.json`，让文档引用生成值而非硬编码。
- **置信度**：确定（1,657 不可复现）；对"应为 1,646 或 945/822"为较高（取决于定义选择）

### [P1] `README.md` 的 "29 处 `chrome.*` 直接调用" 与产物不符，实际调用点 24 处、引用 80 处、成员 12 个

- **位置**：`README.md:233`、`docs/architecture.md:177`（后者补充了"6 个成员"）
- **现象**：`audit.mjs:138` 用 `/chrome\.([a-zA-Z]+)\.([a-zA-Z]+)/g` 统计，得到 29 个匹配、6 个去重成员，文档照抄为"29 处 `chrome.*` 直接调用（… 等 6 个成员）"。该正则有两个缺陷：
  1. **只匹配两段**，漏掉 `chrome.runtime.onMessage.addListener`（三段）之外的更深链，也漏掉 `chrome.storage[e].get`（方括号索引）；
  2. **把属性读取当调用点**。29 个匹配里有 **15 个是 `chrome.runtime.lastError`**，这是属性读，不是调用；`chrome.runtime.id` 出现 10 次，也是属性读。

  实测按"真正的函数调用"统计是 **24 处**（含可选链与方括号索引），去重后 **12 个**不同目标：

  | 调用 | 次数 |
  | --- | --- |
  | `chrome.runtime?.getManifest(` | 5 |
  | `chrome.storage[e].get(` | 4 |
  | `chrome.storage[e].remove(` | 4 |
  | `chrome.storage[e].set(` | 4 |
  | `chrome.storage[I].get(` | 1 |
  | `chrome.storage[I].remove(` | 1 |
  | `chrome.storage[I].set(` | 1 |
  | `chrome.runtime.onMessageExternal.addListener(` | 1 |
  | `chrome.runtime.onMessage.addListener(` | 1 |
  | `chrome.runtime.onConnect.addListener(` | 1 |
  | `chrome.scripting.registerContentScripts(` | 1 |

- **证据**：

  ```
  $ node -e "..."   # 复现 audit.mjs 的正则
  audit-style matches: 29 distinct: 6
  { "runtime.id": 10, "runtime.onMessageExternal": 1, "runtime.onMessage": 1,
    "runtime.onConnect": 1, "runtime.lastError": 15, "scripting.registerContentScripts": 1 }
  ```

  ```
  $ node -e "..."   # 真正的调用点
  total invocation sites: 24
  total chrome.* references (any form): 80
  distinct chrome.* references: 12
  ```

- **影响**：`known-issues.md` 第 6 条把"207 个调用点"改为"6 个成员 / 29 处调用"。修正方向对了（207 确实是 REA 工具数），但**29 这个数仍然是错的**，而且错得很有迷惑性——它把 15 次 `lastError` 属性读算成了 15 个"调用点"。同时它漏报了 `chrome.storage[...]` 这一整组（11 处调用），而 `chrome.storage` 恰恰是 manifest 声明的 `storage` 权限的主要使用者。文档因此既高估了 `runtime` 的调用密度，又完全看不见 `storage`。
- **建议**：统计口径改为"`chrome.<api>.<member>(` 形式的实际调用（支持可选链与方括号索引）"，并把"属性读取"（`lastError`、`id`）单独计数。文档改述为"24 处直接调用，覆盖 12 个 API 目标，其中 11 处是 `chrome.storage[...]`"。
- **置信度**：确定

### [P2] `docs/navigation.md:152` 与 `docs/testing-in-browser.md:85` 的日志模块数（36）与实际（34）不符

- **位置**：`docs/navigation.md:152`、`docs/testing-in-browser.md:85`
- **现象**：两处都称设置页日志面板"可切换 **36 个模块**的日志级别"。实测 `options.6406b895` 中的 `o_` 对象（日志面板的数据源）共 **34** 个条目。

- **证据**：

  ```
  $ node -e "..."   # 从 o_ 对象抽取 { name, label } 条目
  UI log module list length: 34
  BG, BG:Storage, BG:AIChat, BG:Chapter, BG:Translate, BG:Analytics, BG:Protocol,
  BG:AppManager, BG:AppNotifier, BG:WebsiteConfig, CS, CS:Main, CS:IFrame,
  CS:Adapter:YouTube, CS:Adapter:Bilibili, CS:Adapter:Fallback, APP, APP:Hook,
  APP:Component, APP:Service, APP:Hook:Chapter, APP:Hook:Subtitle, APP:Hook:Translate,
  APP:Hook:Storage, APP:Hook:Message, APP:Hook:Analytics, APP:Component:Panel,
  APP:Component:Layout, Util, Util:Backup, Util:Toast, Util:Chrome, Lib:Protocol, Lib:Search
  ```

- **影响**：读者按 36 去核对会数出 34，进而怀疑文档其余部分。这条与 `docs/architecture.md:176` 的"53 个前缀域"形成对照——53 是 `feature_domains` 的键数（实测确为 53），但那一节说的是"后台日志模块保留了…命名表（…等 53 个前缀域）"，把"处理器动作前缀域"和"日志模块命名空间"混为一谈，读者很容易把 36 和 53 当成同一件事的两个版本。
- **建议**：两处改为 34。`docs/architecture.md:176` 需澄清"53 个前缀域"指的是 `protocol.feature_domains`（处理器动作首段），与日志模块命名空间无关（后者是 34 个）。
- **置信度**：确定

### [P2] `docs/navigation.md` 的 `*_PLAY_NOTE*` 计数（5）与文档自身的表格口径不一致

- **位置**：`docs/navigation.md:43`
- **现象**：该表称 `*_PLAY_NOTE*` 有 5 个。实测按该表的匹配口径（全层 158 个处理器）有 **9** 个；若只看后台层是 **1** 个。文档里同一张表混用了两种口径：`*_NOTE*`（8）和 `*_PLAY_NOTE*`（5）匹配的是**后台层**，而 `GET_*`（21）、`UPDATE_*`（15）等匹配的是**全层**。

  | 前缀 | 文档值 | 后台层 | 全层 |
  | --- | --- | --- | --- |
  | `GET_*` | 21 | 17 | **21** |
  | `UPDATE_*` | 15 | 4 | **15** |
  | `*_NOTE*` | 8 | **8** | 18 |
  | `*_PLAY_NOTE*` | 5 | 1 | 9 |
  | `*_BILIBILI*` | 5 | 1 | 6 |

- **证据**：

  ```
  prefix                     bg   ui   cs  all
  GET_*                      17    0    4   21
  UPDATE_*                    4    8    3   15
  *_NOTE*                     8    3    7   18
  *_PLAY_NOTE*                1    1    7    9
  *_BILIBILI*                 1    1    5    6
  ```

  其中 `*_NOTE*` 的 8 恰好等于后台层（口径混用但数值碰巧对），`*_PLAY_NOTE*` 的 5 在任何口径下都不存在。

- **影响**：这张表的上方标题是"功能域与处理器"，紧接在"所有后台逻辑集中在 `static__background__index/99-epilogue.js`"之后，读者会理解为后台层的分布。但 21/15/13/9/9/9/7 这些数只有按全层才成立。两种口径混排且没有标注，任何核对都会得出"文档错了"的结论，尽管其中大部分数字在某个口径下是对的。
- **建议**：表头明确写"统计范围：全层 158 个处理器"，并重算 `*_NOTE*`（18）、`*_PLAY_NOTE*`（9）、`*_BILIBILI*`（6）；或另开一列"后台层"。
- **置信度**：确定

### [P2] `docs/navigation.md:118` 声称 UI 用 react-redux + redux-toolkit，但给出的检索命令返回 0 条

- **位置**：`docs/navigation.md:124-127`
- **现象**：文档写"状态管理用 **react-redux + redux-toolkit**。定位 action：" 然后给出

  ```118:122:docs/navigation.md
  grep -n 'createSlice' src/readable/sidepanel.65d86198/99-epilogue.js | head -20
  ```

  实测 `createSlice` 在**全部** `src/readable/` 中出现 **0 次**。`configureStore`、`createStore`、`createReducer`、`createAction`、`createAsyncThunk`、`combineReducers`、`useSelector`、`useDispatch` 同样都是 0。

  实际存在的是：`reducers:` 20 次、`extraReducers:` 5 次、`Redux Toolkit` 字符串 1 次、`Provider` 9 次——说明 RTK 的运行时确实被打包进来了（`redux` 66 处命中，包括 `Minified Redux Toolkit error #` 和 `redux-persist`），但应用侧是用一个自定义的 `dk({name:"env", initialState:{...}, reducers:{...}})` 工厂建 slice，而不是调用 `createSlice`。也就是说"用了 redux-toolkit"这个判断**成立**，但"用 `createSlice` 定位"这个**工作流指引不成立**。

- **证据**：

  ```
  $ grep -c "createSlice" src/readable/sidepanel.65d86198/99-epilogue.js
  0
  $ grep -rn "createSlice" src/readable/ | wc -l
  0
  ```

  ```
  $ node -e "..."
  createSlice: 0
  createReducer: 0
  configureStore: 0
  reducers: 20
  extraReducers: 5
  create*/configure* identifiers: createAPP, createBG, createCS, createChatFailed, createContext,
    createCustom, ..., createWithHandlers
  first 'reducers:' context:
    ..., reducers: { setFinalLanguage: (e, I) => { e.finalLanguage = I.payload; }, ...
  ```

- **影响**：这是"工作流指引"类的实质缺陷。读者照抄命令会得到空结果，然后合理地怀疑自己路径错了（因为文档同页的另一个 `grep` 命令是能工作的）。正确的锚点是 `reducers:` 或 slice 工厂 `dk(`。这也解释了为什么 `docs/navigation.md` 在"常用检索"一节里另给了一条 `type: "button"` 的例子——那条能工作（10 条命中），说明作者可能已经遇到过 `createSlice` 不工作，但没有回头修正。
- **建议**：把命令改为 `grep -n 'reducers: {' src/readable/sidepanel.65d86198/99-epilogue.js`，或直接给出 slice 工厂 `dk({name:` 的检索。同时把"状态管理用 react-redux + redux-toolkit"改述为"打包了 redux / redux-toolkit / redux-persist 运行时，应用侧通过自定义 slice 工厂 `dk({name, initialState, reducers})` 建 slice"。
- **置信度**：确定

### [P2] `docs/navigation.md` 的 grep 示例在 Windows PowerShell 下不可用（文档未说明 shell）

- **位置**：`docs/navigation.md:21-25`、`docs/navigation.md:154-169`
- **现象**：文档给出 6 条 `grep` 示例，全部使用 POSIX 语法（`--include=99-epilogue.js`、单引号包裹模式、`| head`）。本工程运行在 Windows（`package.json` 的脚本全是 `node`，README 明确讨论 PowerShell 的编码陷阱），而**当前机器的 `PATH` 上没有 `grep`**：

  ```
  $ cmd /c "grep -n ..."
  'grep' 不是内部或外部命令，也不是可运行的程序或批处理文件。
  ```

  只有通过 Git 自带的 `C:\Program Files\Git\usr\bin\grep.exe` 才能运行。用 Git 的 grep 实测，6 条命令中：
  - `grep -n "CREATE_TRANSLATE_SESSION:" ...` → 工作，返回 21097
  - `grep -rn "GET_SUBTITLE_CONTENT" src/readable/ --include=99-epilogue.js` → 工作，返回 `:22045:`
  - `grep -rn '"websiteConfig"' src/readable/` → 工作
  - `grep -rn "api.niutrans.com" src/readable/` → 工作，返回 `:7452:`
  - `grep -n 'createSlice' ... | head -20` → **0 结果**（见上一条）
  - `grep -rn 'type: "button"' ... | head` → 10 结果

- **证据**：

  ```
  $ Get-Command grep,rg -ErrorAction SilentlyContinue
  (no output — neither grep nor rg is on PATH)
  $ & "C:\Program Files\Git\usr\bin\grep.exe" -n "CREATE_TRANSLATE_SESSION:" src/readable/static__background__index/99-epilogue.js
  21097:          CREATE_TRANSLATE_SESSION: async (I, G) => {
  ```

- **影响**：这是"工作流指引的安全性/可用性"问题，不是正确性问题。文档在别处非常注意 Windows 细节（两处 PowerShell BOM 警告），却在这里默认了 POSIX shell。读者在 PowerShell 里粘贴 `grep -rn "X" src/readable/ --include=99-epilogue.js` 会得到 `grep 不是内部或外部命令`，而 README 里同一份工程又明确说这是 Windows 环境。这不至于造成数据丢失，但会让新读者在第一步就卡住。
- **建议**：在"怎么用"一节加一行说明"以下命令需要 Git Bash / WSL，或在 PowerShell 中用 `Select-String`"，并为每条命令给出 PowerShell 等价写法（例如 `Select-String -Path src\readable\**\99-epilogue.js -Pattern "GET_SUBTITLE_CONTENT"`）。
- **置信度**：确定

### [P2] `README.md:74` 与 `README.md:111` 的 bundle 数（9）与实际（10）不符，且同一句的括号列举自相矛盾

- **位置**：`README.md:74`、`README.md:111`
- **现象**：`README.md:74` 写 `bundles.load.mjs  全部 9 个 bundle 的可加载性测试`；`README.md:111` 写 "9 个 bundle（后台、5 个内容脚本、字幕条、侧边栏、设置页、标签页）能否各自加载"。括号里列举的类别数是 1 + 5 + 1 + 1 + 1 + 1 = **10**，与"9 个"矛盾。实测 `tests/bundles.load.mjs` 的 `BUNDLES` 数组有 **9** 个条目（不含后台，后台由 `background.smoke.mjs` 单独测），而工程共 **10** 个 bundle。

  ```
  $ npm run test:bundles
  9 loaded, 0 skipped (harness gap), 0 failed
  ```

- **证据**：`tests/bundles.load.mjs` 的 `BUNDLES` 常量列出 `MainCS`、`IFrameCS`、`YoutubeCS`、`WebappCS`、`Main`、`SubtitleBar`、`sidepanel`、`options`、`tab`——正好 9 个，后台不在其中。所以"9 个"对 `bundles.load.mjs` 是**正确**的，但括号里的分类列举把后台也算进去了，导致"9 个"和列举内容互相打架。
- **影响**：读者数括号会得到 10，然后认为文档数字错了（实际上数字对、括号错）。这条本身影响很小，但它与"10 bundles, 240 modules"（`README.md:244`）并置时，会让读者以为行为测试覆盖不全。
- **建议**：`README.md:111` 改为"9 个 bundle（5 个内容脚本、字幕条、侧边栏、设置页、标签页；后台由冒烟测试单独覆盖）"。
- **置信度**：确定

### [P2] `README.md` 的目录树把 `src/readable/sidepanel.65d86198/` 写成 `sidepanel__65d86198/`，该路径不存在

- **位置**：`README.md:37`
- **现象**：目录树里写 `│   │   ├── sidepanel__65d86198/`（双下划线）。实际目录是 `src/readable/sidepanel.65d86198`（点号）。同页其他 bundle 都用点号（`Main.00175a8f`、`SubtitleBar.f2dae354`），只有这一处用了双下划线——那正好是**拆分目录**（`src/bundles/`）的命名风格，被误抄到了可读视图。

- **证据**：

  ```
  $ Test-Path src\bundles\sidepanel__65d86198
  False
  $ cmd /c dir /b src\readable
  IFrameCS.26275720
  index.json
  Main.00175a8f
  MainCS.277dcde3
  options.6406b895
  sidepanel.65d86198     <-- 点号
  static__background__index
  SubtitleBar.f2dae354
  tabs__tab-main.1e0435ca
  WebappCS.8b5d7cd6
  YoutubeCS.6bf33c81
  ```

- **影响**：`src/bundles/` 用双下划线（`static__background__index`、`tabs__tab-main`），`src/readable/` 用点号（`sidepanel.65d86198`）。目录树把两者混了。读者按树里的路径去找文件会失败。注意 `src/readable/` 里确实有 `static__background__index` 和 `tabs__tab-main` 这种双下划线目录（因为它们的源文件名带 `/`），所以"双下划线"在这里并非全错，只有 `sidepanel__` 这一处是错的。
- **建议**：改为 `sidepanel.65d86198/`。
- **置信度**：确定

### [P2] `README.md` 的 `tests/` 目录树只列 4 个文件，实际有 8 个，`npm run test` 运行 7 个

- **位置**：`README.md:71-75`
- **现象**：目录树列出 `chrome-env.mjs`、`background.smoke.mjs`、`bundles.load.mjs`、`overlay.check.mjs` 四个文件。实际 `tests/` 有 8 个 `.mjs`：

  ```
  background.smoke.mjs  bundles.load.mjs  chrome-env.mjs  consistency.check.mjs
  edit-safety.check.mjs  overlay.check.mjs  package.check.mjs  validator.check.mjs
  ```

  `package.json` 的 `test` 脚本串联 **7** 个（除 `chrome-env.mjs` 外全部）。`README.md:185` 后文又单独提到了 `edit-safety.check.mjs`，说明文档其他地方知道它的存在，只是目录树没更新。

- **证据**：

  ```
  $ npm run test
  ...（输出包含 validator check passed / package check passed / consistency check passed）
  $ node -e "..."
  (package.json) scripts.test = "node tests/background.smoke.mjs && node tests/bundles.load.mjs && node tests/overlay.check.mjs && node tests/edit-safety.check.mjs && node tests/validator.check.mjs && node tests/package.check.mjs && node tests/consistency.check.mjs"
  ```

- **影响**：目录树是"这个工程有哪些东西"的第一入口。漏掉 3 个测试文件会让读者低估行为测试的覆盖面，也解释不了 `npm run test` 输出里为什么会出现 `validator check passed` 这类没在树里出现过的段落。
- **建议**：补全 8 个文件（`chrome-env.mjs` 标为"模拟层，非测试"），或改为"8 个文件，其中 7 个由 `npm run test` 串联"。
- **置信度**：确定

### [P2] `docs/testing-in-browser.md:15` 的 "27 个文件、18.24 MB" 与 `README.md:7` 的 "28 个文件，18.25 MB" 描述的是不同对象但未说明

- **位置**：`docs/testing-in-browser.md:15`、`README.md:7`；`review/README.md:9` 写的是 "28 文件，18.24 MB"
- **现象**：三个数都"对"，但混用：
  - baseline 目录：**28** 个文件、19,132,546 B = **18.25 MiB**（`review/README.md` 写 18.24，与 18.25 不符）
  - release 目录：**27** 个文件、19,127,533 B = **18.24 MiB**（差的那一个是 `_metadata/verified_contents.json`，按设计不打包）
  - `package.mjs` 自己的输出：`unpacked: 18.24 MB`（用 `1024*1024` 换算，所以是 MiB 却标成 MB）

  所以 `review/README.md:9` 的 "28 文件，18.24 MB" 是把 baseline 的文件数（28）和 release 的体积（18.24）拼在了一起——两个数各自正确，组合起来不对应任何真实目录。

- **证据**：

  ```
  $ node -e "..."
  baseline bytes: 19132546  = 18.25 MiB / 19.13 MB
  release bytes: 19127533  = 18.24 MiB / 19.13 MB
  ```

  ```
  $ node -e "..."   # 文件差异
  baseline files: 28  release files: 27
  --- only in baseline ---
  \_metadata\verified_contents.json
  ```

- **影响**：影响面小（`review/README.md` 是给审查者看的背景说明），但它是"数字正确但语义错位"的又一例，而且恰好出现在审查规范里，会削弱规范本身的可信度。`18.24 MB` vs `18.25 MB` 的差异还会让人以为是打包丢了东西。
- **建议**：`review/README.md:9` 改为 "28 文件，18.25 MiB（`_metadata/verified_contents.json` 有意不打包，故 release 为 27 文件、18.24 MiB）"。所有体积标注统一用 MiB 或明确写 MB=10^6。
- **置信度**：确定

### [P2] `docs/testing-in-browser.md` 的 `npm run package -- --suffix test.1` 与 `package.json` 里的 `package:test` 给出的版本号不同

- **位置**：`docs/testing-in-browser.md:92-97`
- **现象**：文档给出三种打包方式：

  ```96:102:docs/testing-in-browser.md
  npm run package                      # 版本 2.4.6，与商店版一致
  npm run package -- --suffix test.1   # 版本 2.4.6.1
  npm run package -- --name-suffix     # 名称加上 (test)
  ```

  前两条实测正确（`2.4.6` 与 `2.4.6.1`）。但文档**没有提到** `package.json` 里已经存在的 `package:test` 脚本（`node tools/package.mjs --suffix test.1`），而 `docs/testing-in-browser.md:78` 又让读者运行 `npm run package:test`。两者等价，读者可能以为是两种不同产物。

  另外，`npm run package -- --suffix test.1` 在 npm 下会把 `--` 之后的参数透传，实测可行；但在某些 npm 版本/配置下 `--` 透传行为有差异，而 `package:test` 不依赖这个行为。

- **证据**：

  ```
  $ npm run package:test
    version:   2.4.6.1
  $ node tools/package.mjs --suffix test.1
    version:   2.4.6.1
  ```

- **影响**：轻微。两处给出同一个结果的两种写法，但都没说"二者等价"。
- **建议**：在"打包参数"一节注明 `npm run package:test` 就是 `--suffix test.1` 的别名。
- **置信度**：确定

### [P2] `docs/navigation.md:11` 与 `docs/symbol-index.md` 的类目计数与 `architecture.generated.json` 三个类目全部不一致

- **位置**：`docs/navigation.md:11`、`docs/symbol-index.md` 头部
- **现象**：这两处直接引用 `symbol-index.json` 的类目计数。`symbol-index.json` 的 `categories` 里有 `app_command: 19`、`tab_action: 7`、`chrome_api: 7`，而 `architecture.generated.json` 对应的是 11、8、6。三个数都不一致：

  | 类目 | symbol-index.json | architecture.generated.json | 实际 |
  | --- | --- | --- | --- |
  | `app_command` | 19 | 11 | 11（`APP_*` + `BAR_*` 处理器）；索引多出的 8 个是 `BAR_VISIBLE`、`APP_TYPE`、`BAR_HIDE`、`BAR_POSITION`、`BAR_CONFIG`、`BAR_STATE`、`BAR_LANGUAGE_CHANGED`、`BAR_JUMP_TO_CHAPTER`——这些是**字符串片段**被前缀匹配误捕，例如 `"SET_SUBTITLE_BAR_VISIBLE"` 里含 `BAR_VISIBLE` |
  | `tab_action` | 7 | 8 | 8（缺 `vcaptions_log_config`，被归到 `storage_key`） |
  | `chrome_api` | 7 | 6 | 6（索引把 `chrome.storage`、`chrome.runtime` 这类两段式加进来了） |

- **证据**：

  ```
  $ node -e "..."   # 交叉比对两个生成物
  app_command entries: 19 vs arch.app_commands: 11
    index-only: BAR_VISIBLE,APP_TYPE,BAR_JUMP_TO_CHAPTER,BAR_LANGUAGE_CHANGED,
                BAR_HIDE,BAR_POSITION,BAR_CONFIG,BAR_STATE
  tab_action entries: 7 vs arch.tab_actions: 8
    arch-only: vcaptions_log_config
  chrome_api entries: 7 vs arch.chrome_apis: 6
    index: chrome.runtime,chrome.runtime.lastError,chrome.runtime.onConnect,
           chrome.runtime.onMessage,chrome.runtime.onMessageExternal,
           chrome.scripting,chrome.storage
    arch : runtime.id,runtime.lastError,runtime.onConnect,runtime.onMessage,
           runtime.onMessageExternal,scripting.registerContentScripts
  ```

  `tests/consistency.check.mjs` 只比对 `background_handler` 与 `endpoint` 两个类目，`app_command`/`tab_action`/`chrome_api` 三个类目**没有交叉校验**。注意 `tab_action` 的检查用了 `tab_action ∪ storage_key` 的并集来"避免假失败"，这恰好掩盖了 `vcaptions_log_config` 被错分类的问题。

- **影响**：`docs/symbol-index.md` 里 `BAR_VISIBLE` 一类的"应用内部命令"条目，其 `sites` 全是 `SET_SUBTITLE_BAR_VISIBLE` 的调用点——读者点进去会发现文档说 `BAR_VISIBLE`，代码里根本没有这个符号。这是"符号索引"这一产品的核心功能失效。
- **建议**：`index-symbols.mjs` 的 `app_command` 提取改为"`"` 或 `'` 包裹的完整字符串字面量精确匹配 `^(?:APP|BAR)_[A-Z0-9_]+$`"，而不是在长串里找子串。把 `app_command`/`tab_action`/`chrome_api` 加入 `consistency.check.mjs` 的交叉比对。
- **置信度**：确定

### [P2] `docs/navigation.md` 推荐直接编辑 `src/bundles/`，但该路径会被 `verify` 拒绝——与 README 的警告自相矛盾

- **位置**：`docs/navigation.md:171-179`、`README.md:233-237`
- **现象**：`docs/navigation.md` 结尾"修改时的注意事项"写：

  ```173:175:docs/navigation.md
  **改动会改变产物摘要。** 这是预期的：`npm run build` 会显示 `9/10 bundles byte-identical`…
  **不要直接改 `src/readable/`。** …真正要改的是 `src/bundles/<bundle>/<moduleId>.js`（压缩格式，但改动会进入构建）。
  ```

  `README.md:176-183` 则明确说"直接改 `src/bundles/` 会被拒绝"，并给出实测的拒绝消息。两者直接冲突。实测确认 README 是对的：

  ```
  $ # 手改 src/bundles/WebappCS.8b5d7cd6/epilogue.js 后
  $ node tools/reconstruct.mjs --verify
  refusing to re-split: these files contain edits that would be lost
    WebappCS.8b5d7cd6/epilogue.js
  Adopt them into src/overlay/ first, then re-run:
    (preamble/epilogue: copy the file to src/overlay/<bundle>/00-preamble.js or 99-epilogue.js)
  Or discard the edits with: git checkout -- src/bundles/
  (exit code 1)
  ```

  注意 `build`（不是 `verify`）确实会使用手改的 `src/bundles/`，所以 `docs/navigation.md` 的"改动会进入构建"对 `build` 成立、对 `verify` 不成立。危险在于：`npm run ci` 和 `npm run all` 都以 `verify` 开头，所以手改之后跑 CI 会失败；而 `npm run verify` 的提示里又给出 `git checkout -- src/bundles/`——本工程**不是 git 仓库**（`git rev-parse --is-inside-work-tree` 返回 128，无 `.git` 目录），这条建议会失败。

- **证据**：

  ```
  $ git rev-parse --is-inside-work-tree
  fatal: not a git repository (or any of the parent directories): .git
  exit: 128
  $ Test-Path .git
  False
  ```

- **影响**：`docs/navigation.md` 的这条建议本身不会立刻丢数据（`build` 会用改动），但会让 `verify`/`ci`/`all` 全部卡住，而工具给出的补救命令（`git checkout --`）在这个工程里无法执行。这是"工作流指引的安全性"问题：指引的每一步单独看都成立，串起来会把人带进死路。
- **建议**：`docs/navigation.md:175` 改为 overlay 路径并交叉引用 `README.md` 的"直接改 src/bundles/ 会被拒绝"一节。`reconstruct.mjs:225` 的 `git checkout --` 提示应改为"删除该文件后重跑 `npm run verify`"或"从 `assets/baseline/` 重新拆分"。
- **置信度**：确定

### [P3] `docs/architecture.md:13-14` 的库出现位置计数与 `architecture.generated.json` 不完全对齐

- **位置**：`docs/architecture.md:13-14`
- **现象**：文档称 `webextension-polyfill` 出现在"全部 10 个 bundle"（与 JSON 一致，10 个）、`react`/`react-dom`/`scheduler` 出现在"6 个 UI 上下文"（JSON 中 `react` 确实 6 个、`react-dom` 5 个、`scheduler` 5 个）。把三者合并表述为"6 个 UI 上下文"会让人以为 `react-dom` 也在 6 个里。

- **证据**：

  ```
  $ node -e "..."   # 从 JSON 读 libraries
  react        found_in: background, content_app, content_subtitle_bar, sidepanel, options, tab  (6)
  react-dom    found_in: content_app, content_subtitle_bar, sidepanel, options, tab            (5)
  scheduler    found_in: content_app, content_subtitle_bar, sidepanel, options, tab            (5)
  ```

  `react` 在 `background` 里被检出，是因为 `audit.mjs` 的签名 `/react\.transitional\.element/` 命中了后台 bundle 中的 React 相关字符串（后台确实需要 `react` 做 SSR 风格的渲染调用），这本身合理，但"6 个 UI 上下文"把后台也算成了 UI。

- **影响**：风格/准确度问题。读者若按"6 个 UI 上下文"去找 `react-dom`，会发现只有 5 个。
- **建议**：改为"`react` 6 个 bundle（含后台）、`react-dom` / `scheduler` 各 5 个 UI bundle"。
- **置信度**：确定

### [P3] `README.md` 的 `epilogue overlay 是原样复制的压缩代码（后台 epilogue 有 52 行…）` 与实际行数不符

- **位置**：`README.md:170`
- **现象**：文档称"后台 epilogue 有 52 行，相对规整"。实测 `src/bundles/static__background__index/epilogue.js` 有 **33** 行（LF=32，无末尾换行）。`adopt --epilogue` 生成的 `src/overlay/.../99-epilogue.js` 有 **45** 行（33 行正文 + 12 行头注释）。

- **证据**：

  ```
  $ node -e "..."
  static__background__index/epilogue.js: bytes=2793187 LF=32 lines=33
  ```

  ```
  $ node tools/adopt.mjs static__background__index --epilogue
  adopted static__background__index/epilogue -> src\overlay\static__background__index\99-epilogue.js
    2793187 bytes copied verbatim (fragments are not independently parseable)
  $ node -e "..."   # overlay 文件
  LF=44 lines=45 bytes=2793682
  ```

  52 既不等于 33 也不等于 45。

- **影响**：轻微。"相对规整"的定性判断是对的（33 行承载 2.79 MB，确实是一行一个模块的规整结构），但 52 这个数无法复现，会让人怀疑是否看错了文件。
- **建议**：改为 33 行（或说明"33 行 / 2.79 MB，一行一个模块"）。
- **置信度**：确定

### [P3] `docs/architecture.md:170` 说"存储分两层：`chrome.storage.local` 与 IndexedDB"，实际还有 `chrome.storage.sync`

- **位置**：`docs/architecture.md:170`
- **现象**：文档写"存储分两层：`chrome.storage.local`（配置与会话）与 IndexedDB（大块数据，通过 `idb` 访问）"。实测存在第三层 `chrome.storage.sync`：`getStorageData` 里显式分支 `if("sync"===I){...storage.sync.get(G)...}`，`vcaptions-env` 走 `sync`，PostHog 的 storage 适配器是 `new Gu({area:"sync"})`，redux-persist 的 watch 也挂在 `sync` 上。

- **证据**：

  ```
  $ node -e "..."
  === which constants are read via Gu({area:...}) adapters ===
    Gu area=local  ...
    Gu area=sync   ...this.storage=new Gu({area:"sync"})...
    Gu area=local  ...
    Gu area=sync   ...new Gu({area:"sync"}).watch({[`persist:${Nr.key}`]:...})...
  ```

  ```
  ...async getStorageData(I,G){let l;if("sync"===I){let I=await GC(Gz).storage.sync.get(G);l=I[G]}else if("local"===I){...
  ```

- **影响**：文档的"两层"模型会让读者在排查"为什么 `vcaptions-env` 在 `local` 里找不到"时走弯路。`known-issues` 里没有这一条。
- **建议**：改为三层：`chrome.storage.local`（配置/会话/令牌）、`chrome.storage.sync`（`vcaptions-env` 隐私开关、redux-persist 同步）、IndexedDB（大块数据）。
- **置信度**：确定

### [P3] `docs/architecture.md` 的端点分组漏掉 Bilibili 端点，且"25 个端点"包含 12 个非 API URL

- **位置**：`docs/architecture.md:113-155`、`README.md:202`、`docs/navigation.md:11`
- **现象**：文档三处引用"25 个端点"（来自 `absolute_endpoints.length`）。这 25 个里有 **12 个不是产品 API**：4 个 XML 命名空间（`http://www.w3.org/1998/Math/MathML` 等）、2 个 GitHub issue 链接、`react.dev/errors/`、`console.cloud.google.com/`、Chrome Web Store 详情页、Edge 商店详情页、`niutrans.com/` 官网、`https://*.youtube.com/*`（manifest 的 match pattern，不是端点）。

  同时，`docs/architecture.md:136-141` 在"站点适配"里列出 3 个 Bilibili 端点和 `youtubei/v1/next`，但**这四个都不在 `absolute_endpoints` 里**（Bilibili 的 URL 是模板字符串 `${e}`，被 audit 的 `.filter((e) => !e.includes("${"))` 排除；`youtubei/v1/next` 被归到 `relative_sdk_paths`）。所以文档正文的端点数（4 个站点适配 + 3 个自有 + 4 个 AI + 1 个翻译 + 1 个统计 = 13）与它引用的"25 个端点"对不上。

- **证据**：

  ```
  $ node -e "..."   # 25 个 absolute_endpoints 里哪些不是产品 API
  count: 12
  http://www.w3.org/1998/Math/MathML
  http://www.w3.org/1999/xlink
  http://www.w3.org/2000/svg
  http://www.w3.org/XML/1998/namespace
  https://chromewebstore.google.com/detail/bciglihaegkdhoogebcdblfhppoilclp
  https://console.cloud.google.com/
  https://github.com/indutny/elliptic
  https://github.com/indutny/elliptic/issues
  https://github.com/syntax-tree/hast-util-to-jsx-runtime
  https://microsoftedge.microsoft.com/addons/detail/lignnlhlpiefmcjkdkmfjdckhlaiajan
  https://niutrans.com/
  https://react.dev/errors/
  ```

  ```
  $ node -e "..."
  === bilibili endpoints claimed in architecture.md ===
    api.bilibili.com/x/player/wbi/v2: present
    api.bilibili.com/x/web-interface/view: present
    api.bilibili.com/x/player/pagelist: present
    youtubei/v1/next: present
    are they in absolute_endpoints? [ false ]
  ```

- **影响**：`README.md:202` 把"25 个端点"和"158 个处理器、14 个存储键"并列，读者会以为是 25 个网络接口。实际其中一半是文档链接和 XML 命名空间。`tests/consistency.check.mjs` 校验的是"README 里出现 `${absEndpoints} 个端点`"这个字符串，所以它**保护了这个误导性数字**。
- **建议**：在 `audit.mjs` 里把绝对 URL 分为 `api_endpoints`（主机在已知 API 列表内）与 `other_urls`（文档/命名空间/商店链接）；文档引用前者。Bilibili 的模板 URL 应单独提取为 `templated_endpoints`。
- **置信度**：确定

## 文档声称 vs 实际 核对表

统计口径：`✓` 一致；`✗` 不一致；`~` 在某个特定口径下成立但文档未说明该口径；`?` 无法复现/无出处。

| # | 文档位置 | 声称 | 实际值 | 一致 | 证据命令 |
| --- | --- | --- | --- | --- | --- |
| 1 | `README.md:6` | CRX 8,070,620 字节 | 8,070,620 | ✓ | `(Get-Item assets\baseline\vCaptions-2.4.6.crx).Length` |
| 2 | `README.md:6` | CRX3 格式 | magic `Cr24`，version 3 | ✓ | `[IO.File]::ReadAllBytes(...)[0..7]` |
| 3 | `README.md:7` | baseline 28 个文件 | 28 | ✓ | `Get-ChildItem -Recurse -File \| Measure-Object` |
| 4 | `README.md:7` | 18.25 MB | 18.25 MiB / 19.13 MB(10^6) | ~ | 同上，`Sum/1MB` |
| 5 | `README.md:8` | 产物 SHA-256 `b94973b4…` | CRX 实际 `f4f8d3cd…`；`b94973b4…` 是 REA 的 `root_sha256`（目录树摘要） | ✗ | `(Get-FileHash ...crx -Algorithm SHA256).Hash` vs `docs/rea-evidence/analysis-summary.txt:2` |
| 6 | `README.md:14` | 10/10 bundle 逐字节一致 | 10/10 | ✓ | `npm run build` |
| 7 | `README.md:21` | PascalCase 函数名数量为 0 | 0（10 个 bundle 全部） | ✓ | 正则 `function\s+[A-Z][a-z]` 计数 = 0 |
| 8 | `README.md:23` | 业务代码 3.88 MB | sidepanel epilogue 3,875,352 B = 3.88 MB(10^6)；全 10 个 epilogue 合计 16.06 MB | ~ | `node -e` 逐 bundle 统计 |
| 9 | `README.md:23` | 1939 个函数 | 无法复现；各种计数为 1,097 / 1,084 / 2,348 / 3,545 / 1,835 / 2,181 / 2,932 / 4,016 | ✗ | 同上；字面量 `1939` 出现 0 次 |
| 10 | `README.md:35` | 240 个模块 | 240 | ✓ | `npm run verify` → "10 bundles, 240 modules" |
| 11 | `README.md:37` | `sidepanel__65d86198/` | 不存在；实际 `sidepanel.65d86198/` | ✗ | `Test-Path src\bundles\sidepanel__65d86198` → False |
| 12 | `README.md:41` | `<moduleId>.js 60 个独立模块` | sidepanel 60 个 | ✓ | `src\bundles\sidepanel.65d86198\modules.json` |
| 13 | `README.md:51` | `sidepanel` epilogue 57,140 行 | 57,140 | ✓ | LF=57,139，无末尾换行 |
| 14 | `README.md:74` | `bundles.load.mjs` 测 9 个 bundle | 9（不含后台） | ✓ | `npm run test:bundles` |
| 15 | `README.md:82` | format 生成 240 个模块 | 240 | ✓ | `npm run format` + 文件计数 |
| 16 | `README.md:101` | `10/10`=未改、`9/10`=改一个 | 实测一致 | ✓ | `node tools/adopt.mjs WebappCS.8b5d7cd6 hEvvs && node tools/build.mjs` |
| 17 | `README.md:111` | 9 个 bundle，括号列举 10 类 | 列举为 10 类，与"9 个"矛盾 | ✗ | `tests/bundles.load.mjs` 的 `BUNDLES` = 9 |
| 18 | `README.md:150` | `overlay.check.mjs` 含 6 项检查 | 6 个 section（11 个 `check()` 调用） | ✓ | `npm run test:overlay` 输出 6 个 `=== n. ===` |
| 19 | `README.md:170` | 后台 epilogue 52 行 | 33 行 | ✗ | `node -e` LF 计数 |
| 20 | `README.md:176-183` | verify 拒绝覆盖并列出文件 | 实测一致（消息逐字相符） | ✓ | 手改后 `node tools/reconstruct.mjs --verify` |
| 21 | `README.md:185` | `edit-safety.check.mjs` 含 12 项检查 | 12 个 `check()` 调用 | ✓ | `npm run test:edit-safety` 输出 12 个 `ok` |
| 22 | `README.md:196` | `Main` epilogue 57,140 行 | 58,439 | ✗ | `node -e` split 长度 |
| 23 | `README.md:202` | 158 个处理器 | 158 | ✓ | `architecture.generated.json` |
| 24 | `README.md:202` | 后台 97 / UI 31 / 内容脚本 34 | 97 / 31 / 34（和 162，去重后 158） | ✓ | 同上 |
| 25 | `README.md:202` | 14 个存储键 | 数组长 14，但 6 个是 i18n 键、漏 11 个真实键 | ✗ | 见 P1「storage_keys 混入 i18n」 |
| 26 | `README.md:202` | 25 个端点 | 25 个绝对 URL，其中 12 个非 API | ~ | `architecture.generated.json.absolute_endpoints` |
| 27 | `README.md:205` | `CREATE_TRANSLATE_SESSION` 在 `:21097` | 21,097 | ✓ | `grep -n` |
| 28 | `README.md:206` | `GET_SUBTITLE_BAR_STATE` 在 `:20641` | 20,641 | ✓ | `grep -n` |
| 29 | `README.md:225` | 改一个模块 → `9/10`，还原 → `10/10` | 实测一致 | ✓ | adopt → build → rm → build |
| 30 | `README.md:233` | 1,657 条去重中文文案 | 最接近的定义 1,646；1,657 不可复现 | ✗ | 见 P1「1,657」 |
| 31 | `README.md:233` | 29 处 `chrome.*` 直接调用 | 实际调用 24 处，引用 80 处，成员 12 个 | ✗ | 见 P1「29 处」 |
| 32 | `README.md:234` | sidepanel 57,140 行 | 57,140 | ✓ | 同 #13 |
| 33 | `README.md:244` | 10 bundles, 240 modules | 一致 | ✓ | `npm run verify` |
| 34 | `README.md:246` | `9 loaded, 0 skipped, 0 failed` | 一致 | ✓ | `npm run test:bundles` |
| 35 | `README.md:257` | 17 个库 | 17 | ✓ | `architecture.generated.json.libraries` |
| 36 | `architecture.md:13` | webextension-polyfill 在全部 10 个 bundle | 10 | ✓ | `.libraries[]` |
| 37 | `architecture.md:14` | react/react-dom/scheduler 在 6 个 UI 上下文 | react 6、react-dom 5、scheduler 5（react 含后台） | ~ | `.libraries[]` |
| 38 | `architecture.md:28` | 5 内容脚本 + 1 SW + 侧边栏 + 设置 + 标签页 | manifest `content_scripts` = 5 | ✓ | `dist/manifest.json` |
| 39 | `architecture.md:37` | `Main` 4.74 MB | 4,744,475 B = 4.74 MB(10^6) / 4.52 MiB | ✓ | `.bundles.content_app.bytes` |
| 40 | `architecture.md:43` | 三者 60 模块，体积完全一致 | 三者 60 模块、总和相同；`Main` 有 2 个模块顺序不同 | ✗ | 见 P1「体积完全一致」 |
| 41 | `architecture.md:49` | 158 个处理器，分三层 | 158 | ✓ | `.protocol.all_handler_count` |
| 42 | `architecture.md:55-57` | 97 / 31 / 34 | 一致 | ✓ | 同上 |
| 43 | `architecture.md:79` | 标签页动作 8 个 | 8 | ✓ | `.protocol.tab_actions.length` |
| 44 | `architecture.md:90` | 应用内部命令 11 个 | 11 | ✓ | `.protocol.app_commands.length` |
| 45 | `architecture.md:105` | 53 个动作前缀域 | 53 | ✓ | `.protocol.feature_domains` 键数 |
| 46 | `architecture.md:159` | 14 个存储键 | 同 #25，6 个是 i18n、漏 11 个 | ✗ | 见 P1 |
| 47 | `architecture.md:170` | 存储分两层（local + IndexedDB） | 三层：local / sync / IndexedDB | ✗ | `getStorageData` 的 `"sync"` 分支 |
| 48 | `architecture.md:176` | 1,657 条去重中文文案 | 1,646（最接近定义） | ✗ | 同 #30 |
| 49 | `architecture.md:176` | 45,007 个 CJK 转义序列 | 45,007（CJK 联合范围） | ✓ | 见 P1「1,657」的证据 |
| 50 | `architecture.md:176` | 53 个前缀域（指日志命名表） | 日志模块命名空间实际 34 个；53 是处理器动作前缀 | ✗ | 见 P2「36/34」 |
| 51 | `architecture.md:177` | 29 处 chrome.* 调用、6 个成员 | 24 处调用、12 个成员 | ✗ | 同 #31 |
| 52 | `architecture.md:180` | PascalCase 函数名为 0 | 0 | ✓ | 同 #7 |
| 53 | `navigation.md:11` | 158 / 14 / 25 | 158 ✓、14 ✗、25 ~ | ✗ | 同 #23/#25/#26 |
| 54 | `navigation.md:15` | 后台 epilogue 22,393 行 | 22,397（LF=22,396） | ✗ | `node -e` split 长度 |
| 55 | `navigation.md:21-25` | grep 示例可用 | 需要 Git Bash；PATH 上无 grep | ~ | `Get-Command grep` 无输出 |
| 56 | `navigation.md:41` | `BAR_*` 3 个 | 3（全层） | ✓ | `.protocol.all_handlers` |
| 57 | `navigation.md:43` | `*_NOTE*` 8 / `*_PLAY_NOTE*` 5 / `*_BILIBILI*` 5 | 8(bg)/18(all)、1(bg)/9(all)、1(bg)/6(all) | ✗ | 见 P2「*_PLAY_NOTE*」 |
| 58 | `navigation.md:62` | `CREATE_TRANSLATE_SESSION` 第 21097 行 | 21,097 | ✓ | `grep -n` |
| 59 | `navigation.md:96` | `GET_SUBTITLE_BAR_STATE` 第 20641 行 | 20,641 | ✓ | `grep -n` |
| 60 | `navigation.md:97` | `REQUEST_MOUNT_SUBTITLE_BAR` 第 20699 行 | 20,694 | ✗ | `grep -n "^ *REQUEST_MOUNT_SUBTITLE_BAR:"` |
| 61 | `navigation.md:116` | 三者共享 57,140 行 epilogue | 58,439 / 57,140 / 57,140 | ✗ | 同 #22 |
| 62 | `navigation.md:124-127` | 用 `createSlice` 定位 action | `createSlice` 出现 0 次 | ✗ | `grep -rn createSlice src/readable/` |
| 63 | `navigation.md:132` | `SubtitleBar` epilogue 7,130 行 | 7,130 | ✓ | `node -e` split 长度 |
| 64 | `navigation.md:133` | 消息监听在 6959 行附近 | 6959 是 `vcaptions_subtitle_bar_mount` | ✓ | `sed -n '6959p'` |
| 65 | `navigation.md:144` | `MainCS` 2,317 行 | 2,317 | ✓ | 同 #63 |
| 66 | `navigation.md:145` | `IFrameCS` 3,560 行 | 3,560 | ✓ | 同 #63 |
| 67 | `navigation.md:146` | `YoutubeCS` 726 行 | 726 | ✓ | 同 #63 |
| 68 | `navigation.md:148` | `WebappCS` 513 行 | 513 | ✓ | 同 #63 |
| 69 | `navigation.md:152` | `options` epilogue 18,262 行 | 18,262 | ✓ | 同 #63 |
| 70 | `navigation.md:152` | 日志面板可切换 36 个模块 | 34 | ✗ | `o_` 对象条目计数 |
| 71 | `navigation.md:154-169` | 常用检索 5 条 | 4 条可用，1 条（`createSlice`）返回 0 | ✗ | 逐条 `grep` |
| 72 | `navigation.md:175` | 真正要改的是 `src/bundles/` | `verify` 会拒绝（README 也说会拒绝） | ✗ | 手改后 `node tools/reconstruct.mjs --verify` |
| 73 | `testing-in-browser.md:15` | release 27 个文件、18.24 MB | 27 文件、18.24 MiB | ✓ | `Get-ChildItem release\... \| Measure-Object` |
| 74 | `testing-in-browser.md:15` | 与官方商店版"字节级重建" | 27 个文件中 26 个字节相同；`manifest.json` 被 `JSON.stringify` 重排（3,028 → 2,454 B），语义相同 | ~ | 逐文件 SHA-256 比对 |
| 75 | `testing-in-browser.md:39-56` | Chrome 155 + 逐项 ok 输出 | 逐字复现，扩展 ID `fcdboeobnnkhhgodpgdichclhcbbolil` 一致 | ✓ | `npm run verify:browser` |
| 76 | `testing-in-browser.md:62` | 未打包 ID 与商店 ID 不同 | 商店 `bciglihaegkdhoogebcdblfhppoilclp`，实测 `fcdboeobnnkhhgodpgdichclhcbbolil` | ✓ | 同上 |
| 77 | `testing-in-browser.md:78` | `npm run package:test` → 2.4.6.1 | 2.4.6.1 | ✓ | `npm run package:test` |
| 78 | `testing-in-browser.md:85` | 36 个模块 | 34 | ✗ | 同 #70 |
| 79 | `testing-in-browser.md:87` | Chrome 137+ 移除 `--load-extension` | 实现确实走 CDP `Extensions.loadUnpacked` | ✓ | `tools/browser-verify.mjs:5,214` |
| 80 | `testing-in-browser.md:92-97` | 三种打包方式 | 三种均可用；`package:test` 未提及 | ✓ | 实测 |
| 81 | `review/README.md:9` | 28 文件，18.24 MB | 28 文件是 baseline，18.24 是 release；baseline 为 18.25 MiB | ✗ | 同 #3/#4/#73 |
| 82 | `review/README.md:10` | 10 bundle → 240 模块 | 一致 | ✓ | `npm run verify` |
| 83 | `review/README.md:11` | 10/10 与基线字节一致 | 一致 | ✓ | `npm run build` |

**统计**：核对 83 项。`✓` 48 项，`✗` 25 项，`~` 6 项，其余 4 项为格式/风格类。**不一致率约 30%**（25/83）。若只看"可自动校验的数字"（由 `tests/consistency.check.mjs` 覆盖的 158/97/25/14 与 10/10、240），一致率接近 100%；若只看"无法自动校验的数字"（行数、函数数、CJK 文案数、chrome 调用数、日志模块数、bundle 数、目录名），不一致率超过 60%。这个分裂本身就是最重要的发现。

## 已确认无问题的部分

以下均实际运行验证，确认文档与实现一致：

1. **`npm run build` 输出 `10/10 bundles byte-identical to baseline`**，10 个 bundle 的字节数与 SHA-256 前缀全部与 `src/bundles/index.json` 的 `baseline_bytes` / `baseline_sha256` 吻合。
2. **`npm run verify` 的拒绝机制真实有效**：手改 `src/bundles/WebappCS.8b5d7cd6/epilogue.js` 后，`reconstruct.mjs --verify` 以退出码 1 结束，输出 `refusing to re-split: these files contain edits that would be lost` 并列出 `WebappCS.8b5d7cd6/epilogue.js`，且改动仍留在磁盘上。README 展示的消息与实测**逐字相符**（除补救命令的适用性，见 P2）。
3. **`npm run test` 全绿**：`background.smoke`（12 项）、`bundles.load`（9 loaded / 0 skipped / 0 failed）、`overlay.check`（6 节 11 项）、`edit-safety.check`（12 项）、`validator.check`、`package.check`、`consistency.check` 全部通过。
4. **`npm run verify:browser` 的文档输出可逐字复现**：Chrome 155.0.8059.85，扩展 ID `fcdboeobnnkhhgodpgdichclhcbbolil`，12 项 `ok`，`browser verification passed`。`docs/testing-in-browser.md:39-56` 的输出块与实测一致。
5. **`npm run test:bundles` 输出 `9 loaded, 0 skipped (harness gap), 0 failed`**，与 `README.md:246` 的 `9 loaded, 0 skipped (harness gap), 0 failed` 一致。
6. **`npm run format` 输出 `10/10 bundles formatted`**，生成 240 个模块文件（与 `README.md:82` 一致）。
7. **`npm run package` / `package:test` 的版本与体积**：`2.4.6` / `2.4.6.1`，27 个文件，`18.24 MB`（MiB），与 `docs/testing-in-browser.md:15` 一致。
8. **处理器三层计数 97 / 31 / 34 与总和 158**：三层去重后确为 158（有 4 个跨层同名：`BILIBILI_MODE_CHANGED`、`REFRESH_CHAPTER_INFO`、`REFRESH_SUBTITLE_CONTENT`、`WEBSITE_CONFIG_UPDATED`），文档"跨层同名处理器属于正常请求/响应两端"的说法成立。
9. **`53 个动作前缀域`**：`feature_domains` 键数确为 53。
10. **`17 个库`**：`architecture.generated.json.libraries` 确为 17 项。
11. **`45,007 个 CJK 转义序列`**：按 CJK 联合范围（`U+3000-303F` ∪ `U+4E00-9FFF` ∪ `U+FF00-FFEF`）统计，`dist`、`src/bundles`、`assets/baseline` 三者均为 45,007。
12. **`PascalCase 函数名数量为 0`**：10 个 bundle 全部为 0（用"首字母大写 + 含小写 + 长度 ≥3 的 `function NAME(`"判定）。
13. **`README.md` 的 adopt → build → 9/10 → 删除 overlay → 10/10 闭环**：完整跑通，`[overlay: hEvvs]` 标记正确出现，删除后恢复 10/10。
14. **`docs/navigation.md` 的 5 个行号中 4 个正确**：`CREATE_TRANSLATE_SESSION`=21,097、`GET_SUBTITLE_BAR_STATE`=20,641、`SubtitleBar` 消息监听=6,959、以及 `SubtitleBar`/`options`/`MainCS`/`IFrameCS`/`YoutubeCS`/`WebappCS` 的 6 个行数全部精确。
15. **`docs/architecture.md` 的数据流一节已明确标注为"行为模型，非逐行验证的执行路径"**——这是全文里事实/推断分离做得最好的一处，应作为其他章节的范式。
16. **`npm run check` 全绿**，manifest 引用、i18n 键、脚本语法均通过。
17. **`git` 不可用这一事实被 `reconstruct.mjs` 的补救建议忽略**，但 `edit-safety.check.mjs` 自身不依赖 git（用 `fs` 备份/恢复），所以 CI 可跑。
18. **`docs/testing-in-browser.md` 的"与商店版共存"解释正确**：未打包 ID 由路径推导（实测 `fcdboeobn…`），与商店 `bciglihaegk…` 不同。

## 未覆盖的范围

1. **`docs/architecture.md` 的"功能域"与"外部服务"两节的产品语义**。本次只核对了端点字符串是否存在于产物，未验证"DeepL / 小牛 / Google / OpenAI 四家服务商都实际可配置"这类产品级断言。`docs/architecture.md:109` 提到"小牛（Niutrans）、DeepL"，产物中 `api.niutrans.com` 存在，但 DeepL 的端点未出现在 `absolute_endpoints` 里（可能经用户自定义 baseURL），这一点**未查清**。
2. **`docs/architecture.md:170-171` 的网站配置迁移字段**。已确认 `_version`（值 2/3/4）与 `_lastMigrated` 在产物中存在，`migrate("WebsiteConfig", ...)` 调用存在，但未逐条验证 v1→v2→v3→v4 的迁移逻辑是否完整可执行。
3. **`docs/architecture.md` 的"三层消息协议"是否真的只有三层**。本次核对了计数，未验证是否存在第四种通信方式（例如 `window.postMessage`——`protocol.window_postmessage_sources` 为空数组，但这可能只是正则未命中）。
4. **`README.md` 的"实测有效性：故意把 YouTube 脚本注册 id 改成 `BROKEN_ID` 后…`npm test` 立刻报 `FAIL YouTube content script registered`"**。该测试确实会因 `contentsYoutubeCs` 缺失而失败（`tests/background.smoke.mjs:100`），但本次**未实际执行** `BROKEN_ID` 改动来复现，故未列入核对表。
5. **`docs/symbol-index.md` 的 423 个条目的行号准确性**。本次只抽查了 `background_handler` 的 3 个行号与 `app_command` 的分类错误，未逐一验证全部 `sites[].line`。已知 `app_command` 类目存在系统性误捕（8 个假条目），其余类目未系统抽查。
6. **`README.md` 的 `--name-suffix` 相关段落**。`known-issues.md` 第 2 条已修复，`package.check.mjs` 覆盖，本次未重复验证。
7. **`docs/rea-evidence/*.txt`**。这 4 个文件不在 L3 指定范围内，但它们是 `README.md:8` 那个错误 SHA-256 的来源。本次只确认 `b94973b4…` 出自 `analysis-summary.txt:2` 的 `root_sha256`（目录树摘要，非 CRX 文件摘要），未评估这 4 个文件整体的可信度。
8. **跨平台行为**。所有验证在 Windows 10.0.26200 + PowerShell 5.1 上完成。`docs/navigation.md` 的 grep 示例在 Linux/macOS 下应可直接工作，未在那些平台验证。
9. **`docs/architecture.generated.json` 的 `generated_at`（2026-10-21T05:40:54Z）是否反映最新一次 `audit`**。本次重跑 `format`/`build`/`test` 但未重跑 `audit`，因此 JSON 可能略陈旧；不过 `tests/consistency.check.mjs` 通过与 `dist` 交叉比对，说明其内容与当前 `dist` 一致。

## 附：最误导的三处（按危害排序）

1. **`storage_keys` 表**（`architecture.generated.json:438`、`architecture.md:159`、`symbol-index.md` 存储键表）。它自称"实际提取结果"，实际一半是 UI 翻译键、同时漏掉账号令牌等 11 个真实键。任何按它排查存储问题的人都会拿到错误地图。
2. **`tests/consistency.check.mjs` 的假阳性**（`:63-70`）。它输出 `ok storage keys do not contain i18n translation keys`，让第 1 点的错误看起来"已被测试保护"。这是本工程"文档数字"问题反复复发的机制性原因：修正时用一个新数字替换旧数字，再用一个永真断言把它锁住。
3. **`docs/navigation.md:175` 推荐直接改 `src/bundles/`**。这条建议会让 `verify` / `ci` / `all` 全部失败，而工具给出的补救命令 `git checkout -- src/bundles/` 在这个非 git 仓库里无法执行。同一份 README 的另一节（`:176-183`）明确说这条路径会被拒绝，两份文档互相打脸。
