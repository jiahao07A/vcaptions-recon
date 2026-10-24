# 第二轮：修复与验证

针对 `SUMMARY-round-1.md` 列出的问题，逐项修复并留下可证伪的验证。原始审查报告在 `round-1/`。

## 修复清单

### P0 级（6 项全部修复）

| # | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 1 | `verify()` 恒真，任意切法都通过 | 改为**独立结构校验**：重新解析 bundle 得到真值，逐模块比对源码/分隔符/边界，再要求可独立解析 | `tests/guard.check.mjs` 4 个破坏用例 |
| 2 | 手改检测在 `modules.json` 缺失时静默放行 | 不再依赖 `index.json`；manifest 缺失/损坏时**拒绝**而非放行 | `guard.check` 3 个场景 |
| 3 | 测试删除 `src/overlay/` 销毁用户编辑 | 改为 `renameSync` 暂存 → 结束后恢复 | 预置 overlay 跑测试，编辑存活 |
| 4 | `bundles.load` realm 污染掩盖 4 个 bundle | 每个 bundle 在**独立子进程**加载 | 注入 `throw` 后 `8 loaded, 1 failed`（原为 `9 loaded, 0 failed`） |
| 5 | `npm run all` 顺序导致 audit 写全零 | `audit` 在 `dist/` 缺失时 exit 2 拒绝写；`all` 顺序改为 build 先于 audit | 空目录跑 audit → exit 2，不写文件 |
| 6 | `adopt` 重跑覆盖已编辑 overlay | 已有 overlay 时拒绝，需显式 `--force` | 二次 adopt 拒绝，`--force` 才覆盖 |

### P1 级（关键项）

| # | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 7 | `storage_keys` 混入 6 个 i18n 键、漏掉 11 个真实键 | 改为**按调用点提取**：解析常量、支持连字符键、过滤库噪音 | 16 个键，含 `vcaptions-auth-token` 系列 |
| 8 | `consistency.check` 的 i18n 断言循环论证 | 改为**独立验证**：直接扫产物，确认每个键出现在 storage 调用点或作为命名常量传入 | 新增 3 条断言 |
| 9 | `bundles.load` 把真实错误降级为 skip | 移除 "harness gap" 降级，任何加载异常都是失败 | 代码中已删除该分支 |

## 关键修复的细节

### P0-1：从「自我一致」到「独立校验」

原实现：
```js
const rebuilt = preamble + parts.join("") + epilogue;
return sha256(rebuilt) === sha256(text);   // 对任意切法都成立
```

新实现分五步，前四步都不依赖拼接结果：

1. 重新解析 bundle，得到模块 id 集合与顺序 → 与存储的比对
2. 每个存储模块的源码必须**逐字节等于** bundle 中对应 span
3. 每个模块必须能作为完整表达式被 `new Function` 解析
4. 分隔符必须与解析结果一致；preamble/epilogue 必须等于 span 之外的文本
5. 最后才用拼接摘要兜底（捕获编码损坏）

实测：把模块正文搬进分隔符后，输出
```
WebappCS.8b5d7cd6.js: INVALID (19903/19903 bytes)
  structural problems:
    - hEvvs: stored source differs from the bundle at byte 0 (stored 0B, expected 9523B)
```

注意字节数仍是 `19903/19903` —— 这正是旧实现会误判为通过的原因。

### P0-2：无法判断时拒绝，而不是放行

原实现遇到缺失文件时 `return []`，语义是「没有手改」。这假设了安全侧，而实际后果是覆盖。新实现区分两种结果：

```js
return { edited, unreadable };
```

`unreadable` 非空即拒绝：
```
refusing to re-split: cannot verify these bundles are unedited
  WebappCS.8b5d7cd6/modules.json is missing or not valid JSON
```

### P0-4：进程隔离消除注册表污染

实测确认了污染机制：加载 `Main` 后再加载 `sidepanel`，`globalThis.parcelRequire4da4` 是**同一个对象**（`identical: true`）。这意味着后加载的 bundle 里，凡是被前者注册过的模块 id 都不会再执行自己的工厂函数。

改为每个 bundle 一个子进程（`--worker` 模式），进程退出时注册表随之销毁。

### P1-7：存储键提取从「猜名字」到「看调用点」

原实现用命名模式匹配，把 `chapterNavigation_deleteSession`（i18n 键）当存储键，同时因 `vcaptions-auth-token` 含连字符而漏掉。

新实现追踪实际调用：
- `storage.local.get("key")` / `.set({key})` / `.remove("key")` 的直接字面量
- 计算键 `set({[K]: v})` → 解析 `K` 的常量值（要求全局唯一）
- 与 `vcaptions-auth-token` 同一批声明的常量（`GX="videoInfo"` 等）
- 排除库噪音（`buffer`、`sha512`、base64 字母表）与远程配置名（`analytics_control`）

结果 16 个键，全部可追溯到声明或调用点。

## 验证结果

```
npm run ci
→ all bundles reassemble byte-for-byte
→ build: 10/10 bundles byte-identical to baseline
→ check passed
→ guard check passed              （新增，13 项）
→ smoke test passed
→ 9 loaded, 0 failed              （原为 9 loaded, 0 skipped, 0 failed）
→ overlay check passed
→ edit-safety check passed
→ validator check passed
→ package check passed
→ consistency check passed
```

## 未修复（转入下一轮）

| 来源 | 问题 |
| --- | --- |
| L1 | `build.mjs` 对语法无效产物 exit 0 |
| L1 | `check.mjs` 不解析 4 个 bundle |
| L1 | `build.mjs` 比对 index 里的旧哈希而非磁盘基线 |
| L1 | `stripOverlayHeader` 吞掉 overlay 首部块注释 |
| L1 | overlay 末尾 `//` 注释吞掉分隔逗号 |
| L2 | `background.smoke` 不验回复内容与 `return true` 契约 |
| L2 | `chrome-env` IndexedDB 版本升级语义错误 |
| L2 | `chrome-env` `StorageArea` 未做结构化克隆 |
| L3 | `Main`/`sidepanel`/`tab-main` epilogue 行数仍写成同一值 |
| L3 | `docs/navigation.md` 行号示例失效 |
| L3 | `architecture.md` 称三 UI 模块"完全相同"（实际 2 个不同） |
| L3 | "1,657 条中文文案"、"29 处调用" 口径待重新定义 |
| L5 | `format --bundle` 拼错会清空 `src/readable/` |
| L5 | `index.json` 的 `split_dir` 反斜杠在 POSIX 上失效 |

## 方法论教训

这一轮最重要的发现不是某个 bug，而是**校验方法的失效模式**：

1. **自我一致性不等于正确性。** 「拼回去等于原文」对任意切法成立。有效校验必须引入独立真值。
2. **循环依赖的断言永远为真。** 索引从审计读数据，再用"索引与审计一致"做断言，等于什么都没验证。
3. **"假设安全侧"会掩盖数据丢失。** 无法判断时选择"没有修改"，后果是覆盖。应选择拒绝。
4. **共享状态让测试静默失效。** 同一 realm 加载多个 bundle 时，后者的代码可能根本不执行，但测试仍报通过。

对应的修复原则：**每个守卫都必须有一个"故意破坏 → 确认被拒绝"的测试**。仅验证"好输入通过"不足以证明守卫存在。
