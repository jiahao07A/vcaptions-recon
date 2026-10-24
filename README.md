# vCaptions — 逆向还原工程

从 Chrome Web Store 发布的 **vCaptions 2.4.6** 产物还原出的可维护工程。

- 扩展 ID：`bciglihaegkdhoogebcdblfhppoilclp`
- 原始产物：`assets/baseline/vCaptions-2.4.6.crx`（8,070,620 字节，CRX3）
- 基线解包：`assets/baseline/extension-v2.4.6/`（28 个文件，18.25 MB）
- 产物 SHA-256：`b94973b4df295aaac358e82660b9528966c70eb9722c9fa285bcaea02c3eb717`

## 先说清楚还原到了什么程度

这一点很重要，因为它决定了这个工程能做什么、不能做什么。

**能做到的：** 产物里的每个字节都被完整保留并拆分成可独立编辑的单元，修改后能重新组装出可加载的扩展，且当前组装结果与官方发布产物**逐字节一致**（10/10 bundle）。

**做不到的：** 恢复成作者原始的 TypeScript 源码文件树。原因不是工具不够强，而是信息在发布时就已经被丢弃了：

| 丢失的信息 | 证据 |
| --- | --- |
| 源文件路径 | Parcel 只保留了 `node_modules` 的路径注释（`ieee754/index.js`、`buffer/index.js`），业务模块的路径注释全部被移除 |
| 原始标识符 | 全部 10 个 bundle 中 **PascalCase 函数名数量为 0**；标识符被压缩为 `e`、`i`、`c`、`G` 等 |
| Source map | 产物内无 `.map` 文件，也无 `sourceMappingURL` 注释 |
| 模块边界 | 业务代码（3.88 MB / 1939 个函数）被 Parcel 内联进入口作用域，而不是注册为独立模块 |

因此，任何声称"已还原出原始 `src/app/hooks/useSubtitle.ts`"的说法都是伪造的。本工程选择**如实重建**：保留可验证的真实产物，并在此之上建立可持续开发和维护的结构。

## 工程结构

```
vCaptions/
├── assets/baseline/                 ⚠ 不纳入版本控制，见下方「获取原始基线」
│   ├── vCaptions-2.4.6.crx          原始商店包（只读基线）
│   └── extension-v2.4.6/            解包后的权威基线（28 个文件）
├── src/
│   ├── bundles/                     拆分后的 240 个模块（构建的真实来源）
│   │   ├── index.json               模块索引 + 每个 bundle 的基线摘要
│   │   ├── sidepanel__65d86198/
│   │   │   ├── modules.json         模块清单（id / 依赖 / 分隔符 / sha256）
│   │   │   ├── preamble.js          Parcel 引导代码
│   │   │   ├── epilogue.js          入口作用域（业务代码所在）
│   │   │   └── <moduleId>.js        60 个独立模块
│   │   └── ...
│   ├── overlay/                     ★ 可编辑源码（adopt 生成，构建优先使用）
│   │   └── <bundle>/
│   │       ├── <moduleId>.js        接管的模块（已格式化）
│   │       ├── 99-epilogue.js       接管的 entry scope（业务代码）
│   │       └── 00-preamble.js       接管的 Parcel bootstrap
│   └── readable/                    格式化后的全量可读代码（派生视图，勿直接改）
│       ├── sidepanel.65d86198/
│       │   ├── 00-preamble.js
│       │   ├── 99-epilogue.js       57,140 行业务代码 ← 主要阅读入口
│       │   └── <moduleId>.js        第三方库（React 等）
│       └── ...
├── dist/                            构建产物（可直接加载为未打包扩展）
├── docs/
│   ├── navigation.md                功能导航：哪个功能在哪一行
│   ├── architecture.md              架构说明（人工撰写）
│   ├── architecture.generated.json  架构事实（自动提取）
│   ├── symbol-index.md              符号索引：消息名 → 文件:行号
│   └── symbol-index.json            同上，机器可读
└── tools/
    ├── parcel-split.mjs             Parcel 模块拆分器（带无损校验）
    ├── reconstruct.mjs              从基线重新生成 src/bundles
    ├── format.mjs                   生成 src/readable 可读代码树
    ├── index-symbols.mjs            建立符号索引
    ├── adopt.mjs                    接管模块为可编辑源码
    ├── overlay.mjs                  overlay 路径与读取逻辑
    ├── build.mjs                    组装 dist 并校验字节一致
    ├── check.mjs                    manifest/资源/语法校验
    └── audit.mjs                    提取协议、端点、依赖
├── tests/
│   ├── chrome-env.mjs              Chrome 扩展环境模拟层（storage/tabs/scripting/idb）
│   ├── background.smoke.mjs        后台冒烟测试：加载、接线、消息响应
│   ├── bundles.load.mjs            全部 9 个 bundle 的可加载性测试
│   └── overlay.check.mjs           overlay 编辑闭环回归测试
```

## 获取原始基线

`assets/baseline/` **不在版本控制中**。里面是扩展作者发布的原始产物，把它放进公开仓库等于再分发他人作品。

克隆本仓库后，运行一次即可恢复：

```bash
npm run fetch-baseline
```

脚本从 Chrome Web Store 的官方更新接口下载 vCaptions 2.4.6，剥离 CRX3 头并解包到 `assets/baseline/extension-v2.4.6/`。它会校验版本号，若商店已发新版会明确警告——因为那会让所有字节比对失去意义。

如果下载被网络策略阻断，手动获取也可以：

1. 打开 `https://chromewebstore.google.com/detail/bciglihaegkdhoogebcdblfhppoilclp`
2. 取得 vCaptions 2.4.6 的 CRX，放到 `assets/baseline/vCaptions-2.4.6.crx`
3. 重新运行 `npm run fetch-baseline`

`npm run build`、`verify`、`format`、`reconstruct` 在基线缺失时都会以 exit 2 退出，并提示这一条命令，不会产生错误的产物。

## 使用方式

```bash
npm run fetch-baseline  # 首次克隆后运行一次（基线不在仓库中）
npm run verify      # 从基线重新拆分全部 bundle，并验证可逐字节重组
npm run format      # 生成 src/readable/ 可读代码树（240 个模块）
npm run index       # 重建符号索引（消息名/存储键/端点 → 文件:行号）
npm run adopt       # 接管模块为可编辑源码（见"怎么改代码"）
npm run build       # 组装 dist/，报告哪些 bundle 与基线一致
npm run check       # 校验 manifest 引用、i18n 键、脚本语法
npm run test        # 运行行为测试（后台冒烟 + bundle 加载 + overlay 闭环）
npm run audit       # 重新生成 docs/architecture.generated.json
npm run all         # 完整流水线
npm run ci          # 提交前检查：verify + build + check + test
```

加载扩展：Chrome → `chrome://extensions` → 打开"开发者模式" → "加载已解压的扩展程序" → 选择 `dist/`。

## 三层验证

改动代码后，用三层检查确认没有破坏东西：

| 层次 | 命令 | 能发现什么 |
| --- | --- | --- |
| 字节一致 | `npm run build` | 改动范围是否符合预期（`10/10` = 未改，`9/10` = 改了一个） |
| 结构完整 | `npm run check` | manifest 引用缺失、i18n 键丢失、语法错误 |
| 行为正常 | `npm run test` | 启动崩溃、消息协议断裂、模块注册失败 |

第三层是关键。字节对比只能说明"和原版一样或不一样"，无法说明"改了之后还能不能跑"。行为测试在 Node 里搭了一个 Chrome 扩展环境（`tests/chrome-env.mjs`），真实加载产物并验证：

- 后台能否启动，是否注册了 `runtime.onMessage` 监听
- 是否通过 `scripting.registerContentScripts` 注册了 YouTube 内容脚本
- 侧边栏行为是否配置为不随图标点击打开
- 消息能否到达处理器并返回结构化响应
- 9 个 bundle（后台、5 个内容脚本、字幕条、侧边栏、设置页、标签页）能否各自加载

实测有效性：故意把 YouTube 脚本注册 id 改成 `BROKEN_ID` 后，字节对比完全正常，但 `npm test` 立刻报 `FAIL YouTube content script registered`。这正是这类测试的价值。

## 怎么改代码

这是工程最关键的部分。有三个目录，各有明确职责：

| 目录 | 性质 | 能否编辑 | 说明 |
| --- | --- | --- | --- |
| `assets/baseline/` | 只读基线 | 否 | 官方产物，一切的参照系 |
| `src/bundles/` | 压缩源码 | 可以但不推荐 | 字节精确，但是压缩代码 |
| `src/overlay/` | **可编辑源码** | **是** | 接管后的模块与 epilogue，构建优先使用 |
| `src/readable/` | 派生视图 | 否 | 全量可读代码，供阅读和搜索 |

### 推荐工作流：adopt → 编辑 → 验证

```bash
# 1. 先找到要改的模块
node tools/adopt.mjs --list-available

# 2a. 改某个模块
node tools/adopt.mjs WebappCS.8b5d7cd6 hEvvs
# 2b. 或改业务逻辑（在 entry scope 里）
node tools/adopt.mjs WebappCS.8b5d7cd6 --epilogue

# 3. 编辑生成的文件
#    src/overlay/WebappCS.8b5d7cd6/hEvvs.js        （模块，已格式化）
#    src/overlay/WebappCS.8b5d7cd6/99-epilogue.js  （业务代码，压缩但可读）

# 4. 构建并验证
npm run build   # 会显示 9/10 + [overlay: ...]
npm run test    # 确认还能跑
```

接管后的模块是**格式化过的普通 JavaScript**，可以直接阅读和修改。构建时 overlay 会替代对应的压缩模块。

### 为什么可以这样做

这不是猜测，是验证过的：格式化只改变空白和冗余括号，不改变语义。我把格式化后的模块拼回 bundle，在真实的扩展环境里运行，结果与原始版本一致。`tests/overlay.check.mjs` 固化了这个结论，包含 6 项检查：

1. 基线字节一致（`10/10`）
2. `adopt` 生成格式化后的 overlay 文件
3. 构建时该 bundle 报告为已修改（`9/10`），且 overlay 被计数
4. **带 overlay 的 bundle 仍能正常加载运行**
5. 对 overlay 的编辑确实进入 `dist`
6. 删除 overlay 后恢复 `10/10` 字节一致

第 6 项保证测试不留残留，可以在 CI 里反复跑。

### 业务代码在 epilogue 里

业务逻辑主要在 `epilogue.js`（入口作用域）。它不是独立的 `register(...)` 调用，无法单独格式化，但**同样必须通过 overlay 修改**：

```bash
node tools/adopt.mjs <bundle> --epilogue
# 编辑 src/overlay/<bundle>/99-epilogue.js
```

epilogue overlay 是原样复制的压缩代码（后台 epilogue 有 52 行，相对规整），可以配合 `src/readable/<bundle>/99-epilogue.js` 里同位置的格式化版本对照阅读。

### 直接改 src/bundles/ 会被拒绝

`npm run verify` 会用基线重写 `src/bundles/`。如果你直接改了那里的文件，`verify` 会**拒绝执行并列出被改的文件**，而不是静默覆盖：

```
refusing to re-split: these files contain edits that would be lost

  WebappCS.8b5d7cd6/epilogue.js

Adopt them into src/overlay/ first, then re-run:
  node tools/adopt.mjs WebappCS.8b5d7cd6 --epilogue
```

这个防护由 `tests/edit-safety.check.mjs` 覆盖，包含 12 项检查——曾经这里会静默丢失修改，而文档恰好推荐直接编辑那些文件。

**不要用 PowerShell 的 `Set-Content -Encoding UTF8` 编辑这些文件**——它会引入 BOM 并损坏多字节字符，导致字节校验失败。用支持 UTF-8 无 BOM 的编辑器。

## 从哪里开始读代码

压缩代码格式化为可读代码后，业务逻辑变得可导航：

| 想做的事 | 打开 |
| --- | --- |
| 改翻译逻辑 | `src/readable/static__background__index/99-epilogue.js`，搜 `CREATE_TRANSLATE_SESSION` |
| 改字幕列表 UI | `src/readable/Main.00175a8f/99-epilogue.js`（58,439 行） |
| 改侧边栏 | `src/readable/sidepanel.65d86198/99-epilogue.js` |
| 改悬浮字幕条 | `src/readable/SubtitleBar.f2dae354/99-epilogue.js` |
| 改设置页 | `src/readable/options.6406b895/99-epilogue.js` |
| 找某功能在哪 | `docs/navigation.md` 或 `docs/symbol-index.md` |

`docs/symbol-index.md` 收录了 158 个消息处理器、16 个存储键、25 个端点的精确位置。处理器分布在三个上下文（后台 97 个、UI 31 个、内容脚本 34 个），例如：

```
CREATE_TRANSLATE_SESSION  →  static__background__index/99-epilogue.js:21097
GET_SUBTITLE_BAR_STATE    →  static__background__index/99-epilogue.js:20641
```

## 日常工作流

修改代码后按顺序跑：

```bash
npm run build   # 看改动范围
npm run check   # 确认结构没坏
npm run test    # 确认还能跑
```

`build` 输出里的标记含义：

- `=` 表示该 bundle 与官方产物字节一致（未改动）
- `~` 表示该 bundle 已被修改
- `[overlay: xxx]` 表示该模块使用了可编辑源码

这是判断"改动是否只影响预期范围"的直接依据。实测：改一个模块后输出 `9/10 bundles byte-identical` 并列出被改的 bundle；还原后恢复 `10/10`。

**注意 PowerShell 的编码陷阱：** 用 `Set-Content -Encoding UTF8` 写 `src/bundles/` 里的文件会引入 BOM 并可能损坏多字节字符，导致构建不再是 `10/10`。编辑这类文件请用支持 UTF-8 无 BOM 的编辑器，或改完后跑 `npm run verify` 确认字节完好。

## 修改代码时的现实约束

拆分出的模块可编辑，格式化后也可读，但需要理解它们的形态：

1. **标识符仍是压缩名。** 变量是 `e`、`i`、`c`，没有类型注解。可读性来自结构、保留的字符串字面量（1,657 条去重中文文案，覆盖 UI 标签与错误提示）和可直接定位的 API 调用点（29 处 `chrome.*` 直接调用，另有经 `webextension-polyfill` 包装的间接调用）。
2. **业务逻辑主要在 `99-epilogue.js`。** 以 `sidepanel` 为例，57,140 行的入口作用域里是应用本身，`<moduleId>.js` 里主要是 React、react-dom、buffer 等第三方库。
3. **改动受模块边界约束。** 改某个模块不会影响其他模块，但跨模块重构需同步更新 `modules.json` 的依赖映射。

建议的渐进策略：先用 `docs/navigation.md` 定位功能 → 在 `src/readable/` 读懂逻辑 → 把改动应用到 `src/bundles/` 对应模块 → `npm run build` 确认只有它变化 → 继续下一个。这样每一步都有字节级校验兜底。

## 验证基线

本工程的所有结论都基于可复现的校验，而不是推断：

```
10 bundles, 240 modules
all bundles reassemble byte-for-byte
build: 10/10 bundles byte-identical to baseline
9 loaded, 0 skipped (harness gap), 0 failed
smoke test passed
```

拆分器（`tools/parcel-split.mjs`）通过配对括号、跳过字符串/模板/注释/正则字面量来定位模块边界，并原样记录模块之间的分隔符。重组时按 `preamble + Σ(module + separator) + epilogue` 拼接，再与原始 SHA-256 比对。

行为测试（`tests/`）在 Node 中构建了一个最小 Chrome 扩展环境，包含 `storage`（local/session/sync + 变更事件）、`tabs`、`scripting`、`sidePanel`、`i18n`、`runtime` 消息分发、IndexedDB 子集和 DOM/XMLHttpRequest 模拟。它刻意不模拟真实网络：`fetch` 被替换为抛错，因此测试是离线且幂等的。后台启动时会尝试拉取 `api.vcaptions.com/api/v1/settings` 并记录一条 error，这是预期行为，不影响测试结论。

## 已知限制

- `node_modules` 依赖未还原为 `package.json` 条目。已识别 17 个库（见架构文档），但精确版本无法从压缩产物中确定。
- 未重建原始构建流水线（Plasmo + Parcel）。当前构建是"从基线重组"，不是"从源码编译"。若要从头编译，需要先按上文策略把模块改写为可读源码。
- 官方更新会改变产物摘要。重新还原需替换 `assets/baseline/` 并重跑 `npm run verify`。
- 行为测试覆盖的是**启动与协议接线**，不覆盖业务逻辑正确性。翻译、章节生成、字幕抓取等依赖外部服务的路径需要联调或录制回放才能验证。
- 模拟层只实现了产物实际调用的 API 子集。若代码改动引入新的 Chrome API，测试会以 `ReferenceError` 失败——这是有意的，避免静默通过。

## 授权说明

本工程用于对已合法获取的扩展进行互操作性与学习研究。产物版权归原作者所有。请勿用于重新发布或分发他人作品。
