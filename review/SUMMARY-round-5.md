# 第五轮：验证修复本身（round-2 审查产物）

第二轮审查（`round-2/`）的目标不是找新 bug，而是**检验前四轮的修复能否被绕过**。结果：三份报告共 3 个 P0、14 个 P1，全部指向「修复看起来存在、实际拦不住」。

## 审查的自我否证

三份报告最有价值的地方是它们推翻了几个我此前当作"已修好"的结论：

| 声称的修复 | 审查结论 |
| --- | --- |
| `modules.json` 缺失/损坏时拒绝覆盖编辑 | **不成立**：`{}`、`[]`、`{"modules":null}` 都是合法 JSON，遍历 0 次即放行，一次编辑可覆盖 60 个模块的手改 |
| `dist/` 原子替换 | **不成立**：`rmrf(DIST)` 与 `renameSync` 之间无保护，文件被占用时把 27 文件毁成 18 |
| 语法校验 | **实现选错目标**：`vm.Script` 按 script goal 解析，而三个产物是 `<script type="module">`，`with` 语句穿过全部五道关 |
| `check.mjs` 权限白名单 | **可绕过**：`storage/`、`storage:*` 因含 `/ : *` 被判为 host pattern 而放行 |
| `check.mjs` WAR 通配符 | **覆盖不足**：`*.css` 只要有一个文件存在就算通过，删掉三个运行时样式表仍绿 |

## 本轮修复

### P0（3 项）

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | `modules.json` 结构削弱时静默放行 | 要求 `modules` 是**非空数组**；并从基线枚举模块，manifest 漏列即报告 |
| 2 | 补救建议「删除 bundle 目录」会连手改一起删 | 改为明确警告 **Do NOT delete**，并给出保留编辑的三步操作 |
| 3 | 编辑 `modules.json` 字段被静默还原 | 同 #1，结构校验覆盖 |

验证：`tests/guard-structure.check.mjs`，5 种削弱方式 × 3 项断言 = 15 项全部通过。

### P1（6 项）

| # | 问题 | 修复 |
| --- | --- | --- |
| 4 | `dist` 替换非原子 | 改为 `rename(DIST→RETIRED)` → `rename(STAGING→DIST)` → 删除 RETIRED，失败可回滚 |
| 5 | 语法校验漏 module 语义 | 从 HTML 读取 `<script type="module">`，对这类产物以 `"use strict"` 前缀解析 |
| 6 | `check` 缺结构必存校验 | 增加 `background`/`side_panel`/`options`/`content_scripts`/`icons` 的存在性断言 |
| 7 | WAR 通配符覆盖不足 | 显式校验 `daisyui.css`、`style.css`、`subtitleBar.css` 三个运行时样式表 |
| 8 | WAR 路径穿越 | 拒绝含 `..` 或解析到 dist 之外的 pattern |
| 9 | overlay 静默忽略 | 构建时比对「磁盘上的 overlay」与「实际使用的」，未被使用的直接报错并拒绝发布 |
| 10 | `stripOverlayHeader` 误判用户注释 | 只认 adopt 写出的**精确首行**，用户注释即使含相同字样也保留 |

验证：`tests/check-hardening.check.mjs`（11 项，逐条复现 R2 的攻击）、`tests/round2-repairs.check.mjs`（14 项）。

## 修复过程中我自己引入的 bug

加 overlay 使用校验时，`readFragment` 往 `overlaid` 里推的是内部片段名 `epilogue`，而 `listOverlays` 报告的是文件名 `99-epilogue`。两者不一致，导致**合法的片段 overlay 被误判为"被忽略"**，构建拒绝。

`edit-safety.check` 立刻抓到了这个回归（`FAIL edit from the overlay reaches dist`）。修正后：

```
overlays in use: 1 module(s)
modified (expected while editing): WebappCS.8b5d7cd6.js
exit: 0
marker in dist: True
```

这印证了第二轮的方法论：**新加的守卫本身也需要被验证**。如果当时没有 `edit-safety.check`，这个 bug 会让所有片段 overlay 失效，而且构建会声称"文件名不匹配"——指向完全错误的方向。

## 验证结果

```
npm run ci
→ all bundles reassemble byte-for-byte
→ build: 10/10 bundles byte-identical to baseline
→ check passed
→ guard / guard-structure / chrome-env / smoke 通过
→ 9 loaded, 0 failed
→ overlay / overlay-edge / edit-safety 通过
→ validator / check-hardening / round2-repairs 通过
→ package / consistency 通过

npm run release
→ packaged: 27 files
→ browser verification passed
→ FAIL: none
```

测试从 13 个增至 **16 个**。

## 尚未修复（本轮未触及）

R2 报告还有 10 个 P2 和若干 P1 未处理，主要类型：

- `validator.check` 只锁住 12 条规则中的 4 条（把其余 8 条改成 `if (false)` 后测试仍全绿）
- `consistency.check` 的 i18n 断言从循环论证**退化成了恒真**（切片把开引号算进 `before`，`t(` 后永远跟着 `"`，107 个真实键 0 触发）
- `consistency.check` 的文档数字断言是 `includes` 子串匹配，`116 个存储键` 能满足 `16 个存储键`
- `architecture.md` 与 `navigation.md` 现存"14 个存储键"（实际 16），但这两个文件未被一致性测试读取

这些都指向同一个模式：**断言写对了方向，但覆盖的输入空间不足**。下一轮应优先修 `validator.check` 的规则覆盖——它是所有其他守卫的元守卫。
