# 第一轮审查汇总

五个 subagent 分层审查的结果汇总。原始报告在 `round-1/`。

## 报告索引

| 层 | 报告 | 状态 |
| --- | --- | --- |
| L1 构建与字节完整性 | `round-1/L1-build-integrity.md` | 完成 |
| L2 测试有效性 | `round-1/L2-test-effectiveness.md` | 完成 |
| L3 文档与事实一致性 | `round-1/L3-doc-consistency.md` | 完成 |
| L4 产物可运行性 | `round-1/L4-artifact-runtime.md` | 进行中 |
| L5 工具健壮性 | `round-1/L5-tool-robustness.md` | 完成 |

## 独立复核结论

我没有直接采信 subagent 的结论，对两个 P0 做了独立复现：

**P0-A 校验恒真（已复现）**
把一个模块的正文整体搬进相邻模块的 `separator_after`，模块文件只剩空注释，`parcel-split --verify` 仍输出 `IDENTICAL (19903/19903 bytes)`。

原因：`verify()` 校验的是「把切出来的碎片按原顺序拼回去等于原文件」。对任意切法都成立——即使切点完全错误。它只能证明"没有丢字节"，不能证明"模块边界正确"。

**P0-B 手改检测可被绕过（已复现）**
删除 `modules.json` 后，手改 `epilogue.js`，运行 `reconstruct.mjs --verify`：编辑被覆盖，退出码 0，输出 `all bundles reassemble byte-for-byte`。

原因：`findHandEdits()` 在 `index.json` 或 `modules.json` 缺失/损坏时直接 `return []`（视为"没有手改"），随后无条件重写。

## 去重后的核心问题（按严重度）

### P0（会丢失工作或产出错误结论，且不易察觉）

| # | 问题 | 来源 | 复核 |
| --- | --- | --- | --- |
| 1 | `verify()` 恒真，无法证明模块边界正确 | L1 | 已复现 |
| 2 | 手改检测在 `modules.json` 缺失时静默放行，编辑被覆盖 | L1 | 已复现 |
| 3 | `overlay.check` / `edit-safety.check` 无条件删除 `src/overlay/`，销毁用户未提交的编辑 | L2 | 待复核 |
| 4 | `bundles.load` 用同一 realm 加载 9 个 bundle，模块注册表互相覆盖，4 个 bundle 的回归完全不可见 | L2 | 待复核 |
| 5 | `npm run all` 在全新克隆上先跑 `audit`（`dist/` 不存在），用全零覆盖 `architecture.generated.json`，第二次运行又自动恢复 | L5 | 待复核 |
| 6 | `adopt` 重跑会无提示覆盖已编辑的 overlay | L5 | 待复核 |

### P1（功能缺陷或误导性结论）

| # | 问题 | 来源 |
| --- | --- | --- |
| 7 | `build.mjs` 对语法无效产物仍 exit 0 | L1 |
| 8 | `check.mjs` 不解析 4 个 bundle | L1 |
| 9 | `build.mjs` 比对的是 `index.json` 里的旧哈希，而非磁盘基线 | L1 |
| 10 | 两份括号匹配器行为不一致，导致 epilogue 假阳性 | L1 |
| 11 | `stripOverlayHeader` 吞掉 overlay 首部任何块注释 | L1 |
| 12 | overlay 末尾 `//` 注释会吞掉分隔逗号，产出无效包 | L1 |
| 13 | `bundles.load` 把 `Cannot read` / `is not defined` 降级为不计失败的 skip | L2 |
| 14 | `background.smoke` 只验"有回复"，不验回复内容，也不验 `return true` 契约 | L2 |
| 15 | `chrome-env` 的 IndexedDB 模拟在版本升级上出错 | L2 |
| 16 | `chrome-env` 的 `StorageArea` 未做结构化克隆，对象引用共享 | L2 |
| 17 | `architecture.generated.json` 的 `storage_keys` 混入 6 个 i18n 键，漏掉 11 个真实键（含 `vcaptions-auth-token`） | L3 |
| 18 | `consistency.check` 的 i18n 断言是循环论证，永远为真 | L3 |
| 19 | `Main` / `sidepanel` / `tab-main` 的 epilogue 行数被写成同一个值，实际三者不同 | L3 |
| 20 | `docs/navigation.md` 的行号示例已失效 | L3 |
| 21 | `architecture.md` 声称三个 UI 模块"完全相同"，实际有 2 个模块不同 | L3 |
| 22 | README 的"1,657 条中文文案"无法复现（接近的定义给出 1,646） | L3 |
| 23 | README 的"29 处 chrome.* 直接调用"口径不明（实际 24 处调用 / 80 处成员 / 12 个） | L3 |
| 24 | `format --bundle` 拼错会先删整棵 `src/readable/` 再报 0/0 并 exit 0 | L5 |
| 25 | `index.json` 的 `split_dir` 用反斜杠，POSIX 上 overlay 被静默忽略 | L5 |

### 关键洞察（来自 L3）

文档数字反复出错的**机制**：每次修正用一个未复算的新数字替换旧数字，再用永真断言锁住。`consistency.check` 的 i18n 断言把索引与审计互比，而索引正是从审计读入的，所以永远通过。

这说明问题不在"某个数字错了"，而在**校验方法本身无法证伪**。修复必须针对机制，不能只改数字。

## 修复优先级

1. **先修"校验恒真"类问题**（#1、#18）——这是所有其他问题得以存在的根因
2. **再修数据安全类**（#2、#3、#6）——会丢工作
3. **再修测试盲区**（#4、#13）——会让回归漏过
4. **再修工具健壮性**（#5、#24）
5. **最后修文档**（#17、#19-23）——在机制修好后重新生成

## 修复原则

- 修完必须有**能证伪的测试**：故意破坏，确认检测到
- 不能用"再写一个永真断言"的方式修永真断言
- 每个修复要能在报告中追溯到具体发现编号
