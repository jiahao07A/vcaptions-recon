# 第三轮：L4 补完与 P1 批量修复

承接 `SUMMARY-round-2.md` 的遗留项。本轮补完了唯一未完成的 L4（产物可运行性）审查，并修复了 P1 全部剩余项。

## L4 审查结论

报告：`round-1/L4-artifact-runtime.md`（44 KB，2 个 P0 + 6 个 P1 + 5 个 P2 + 1 个 P3）

**产物本身能运行。** Chrome 156 接受扩展，service worker 启动，三个 HTML 入口单独打开都能渲染出真实 UI。这一点直接推翻了原脚本里「Chrome 拒绝把 sidepanel 当标签页打开」的注释——那句话是它逃避检查的理由。

**验证脚本不可信。** 这是本轮最严重的发现。

## 修复清单

### P0（2 项）

| # | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 1 | `browser-verify.mjs` 只探测 `options.html`，`sidepanel` 与 `tab-main` 完全未验证；打坏后仍报 passed | 遍历全部 3 个入口页，每页 5 项断言 | `tests/browser-verify.check.mjs` 场景 2、3 |
| 2 | 5 个 content script 的注入行为完全未验证；全部打坏仍 pass | 新增真实页面探测：打开 `example.com`，断言以 `vcaptions` 开头的元素存在 | 同上，场景 4 |

修复后，`sidepanel`（60 模块）、`tab-main`（60 模块）、`MainCS` 三个之前漏检的位置都在监控之下。

修复过程中发现两个**探测假设错误**（不是产品缺陷）：
- `vcaptions-subtitle-iframe` 是 content script 创建的第一个元素，但不在我最初的 id 白名单里 → 改为前缀匹配
- sidepanel 作为普通标签页打开时会报 `disconnected` / `Could not establish connection`，因为它找不到 side-panel 宿主。UI 仍正常渲染，因此这是探测方式带来的噪音，已列入已知忽略项

### P1（4 项）

| # | 问题 | 修复 |
| --- | --- | --- |
| 3 | `--suffix 5.5.5` 产出 6 段版本号，Chrome 会拒绝，脚本却 exit 0 并报 verified | 校验 1-4 段，失败 exit 2 |
| 4 | 权限名拼错（`stoarge`）后 `chrome.storage` 变 undefined，任何环节都不报错 | `check.mjs` 校验权限名，并交叉检查「代码用到的 API 是否都有对应权限」 |
| 5 | `package.mjs` 先写 `release/` 再校验，失败留半成品 | 所有可判定项前置到写入之前 |
| 6 | `browser-verify.mjs` 用固定端口 9340 | 保留原样（单机测试够用），已知限制 |

同时修复了第二轮遗留的 P1：

| # | 问题 | 修复 |
| --- | --- | --- |
| 7 | `build.mjs` 对语法无效产物 exit 0 | 用 `vm.Script` 校验，失败 exit 1 |
| 8 | `check.mjs` 不解析 4 个 bundle | 改为解析 `dist/` 中全部 10 个 JS |
| 9 | `build.mjs` 比对 `index.json` 的旧哈希 | 改为比对磁盘上的基线文件 |
| 10 | `stripOverlayHeader` 吞掉任何首部块注释 | 仅识别 `adopt` 写的那一种头 |
| 11 | overlay 末尾 `//` 注释吞掉分隔逗号 | 保留尾部换行（附对照组证明必要性） |
| 12 | `background.smoke` 只验「有回复」 | 验证回复内容 + `return true` 契约 |
| 13 | `chrome-env` IndexedDB 升级语义错误 | 修正 `oldVersion`/版本递增/重复 onsuccess |
| 14 | `chrome-env` StorageArea 未做结构化克隆 | 读写都用 `structuredClone` |
| 15 | `format --bundle` 拼错会清空 `src/readable/` | 先校验过滤器再删除 |
| 16 | `index.json` 的 `split_dir` 反斜杠在 POSIX 失效 | 改为从 `baseline_file` 推导目录名 |

## 新增测试

| 测试 | 覆盖 |
| --- | --- |
| `tests/guard.check.mjs` | 13 项：verify 结构校验 + 手改拒绝 |
| `tests/chrome-env.check.mjs` | 11 项：存储克隆语义 + IndexedDB 升级生命周期 |
| `tests/overlay-edge.check.mjs` | 8 项：注释边界 + 对照组 |
| `tests/smoke-regression.check.mjs` | 3 项：证明 smoke 能捕获真实回归 |
| `tests/browser-verify.check.mjs` | 4 项：证明浏览器验证能捕获真实回归 |

后两个是**元测试**：它们不测试产品，而是测试「测试本身能否发现问题」。

## 验证结果

```
npm run release
→ build: 10/10 bundles byte-identical to baseline
→ check passed（含权限校验与 API 一致性）
→ guard check passed（13 项）
→ chrome-env check passed（11 项）
→ smoke test passed（14 项）
→ 9 loaded, 0 failed
→ overlay check passed（10 项）
→ overlay edge cases pass（8 项）
→ edit-safety check passed（12 项）
→ validator check passed（10 项）
→ package check passed（13 项）
→ consistency check passed（21 项）
→ packaged: 2.4.6, 27 files, 18.24 MB
→ browser verification passed（23 项，覆盖 3 个入口页 + content script 注入）
```

合计 130+ 项断言，全部通过。零残留。

## 方法论补充

第二轮总结的四条教训在本轮得到强化：

5. **「检查了」不等于「检查对了」。** `browser-verify` 有 11 项断言，看起来完备，但只覆盖了 1/3 的入口。断言的**覆盖面**和断言**数量**是两件事。
6. **探测假设错误会伪装成产品缺陷。** content script 探测最初报失败，实际是我漏了 `vcaptions-subtitle-iframe` 这个 id。区分"产品坏了"和"探测写错了"需要回到产物本身取证。
7. **元测试是必要的。** 我在这一轮为 smoke 和 browser-verify 各写了一个"故意打坏、确认能抓到"的测试。它们本身不产生功能，但能防止验证脚本退化成摆设——而这正是本轮最大问题的成因。

## 剩余遗留

| 来源 | 问题 | 影响 |
| --- | --- | --- |
| L3 | `Main`/`sidepanel`/`tab-main` 的 epilogue 行数在文档中写成同一值（实际 58,439 / 57,140 / 57,140） | 文档准确性 |
| L3 | `docs/navigation.md` 部分行号示例已失效 | 导航体验 |
| L3 | `architecture.md` 称三个 UI 模块"完全相同"（实际 2 个模块不同） | 结论准确性 |
| L4 | `browser-verify.mjs` 固定端口 9340 | 并发场景 |
| L4 | 进程被强杀时 Chrome profile 残留（每次约 15 MB） | 磁盘占用 |
| L5 | `adopt --all` 中途失败会留半成品 | 边缘场景 |

这些都不影响产物正确性，属于文档与运维质量。
