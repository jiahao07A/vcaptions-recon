# 第六轮：修复元守卫的覆盖缺口

承接 `SUMMARY-round-5.md` 的遗留。本轮集中修三类"断言方向对了但覆盖不足"的问题。

## 起点：验证 R2 的说法

R2 称 `validator.check` 只锁住 12 条规则中的 4 条。我先实测：

写了一个探测脚本，对 `check.mjs` 的每条规则做**精确失效**（只替换它的 `fail(...)` 调用，保留控制流），然后看元测试是否变红。

首次测量结果比 R2 说的更糟：

```
UNLOCKED  manifest_version == 3
locked    version format
UNLOCKED  permission whitelist
UNLOCKED  API/permission cross-check
UNLOCKED  content_scripts matches
UNLOCKED  WAR pattern expansion
UNLOCKED  locale file exists
UNLOCKED  locale parses
UNLOCKED  all JS parse
UNLOCKED  HTML references
UNLOCKED  resource exists
UNLOCKED  __MSG key resolves
UNLOCKED  structure required
```

**13 条规则只有 1 条被锁住。**

## 修复 1：扩展 validator.check

原测试只有 10 个场景。我补到 **23 个**，为每条规则配上专门的破坏场景：

| 新增场景 | 对应规则 |
| --- | --- |
| `manifest_version` 改为 2 | 版本必须为 3 |
| version 改为 `2.4.6.1.2` | 1-4 段数字 |
| `storage` → `stoarge` | 权限名白名单 |
| `storage` → `storage:*` | 权限名严格匹配 |
| 移除 `scripting` 权限 | API 与权限交叉检查 |
| match pattern `https://*.example.com` | 匹配模式合法性 |
| WAR 指向 `*.nonexistent` | 通配符至少匹配一个 |
| WAR 指向 `../package.json` | 路径穿越 |
| 删除 `daisyui.css` | 运行时样式表必须存在 |
| 删除 `background` / `side_panel` / `content_scripts` | 结构必存 |
| 破坏未被 manifest 引用的 bundle | 全部 JS 必须可解析 |

重测覆盖率：**14/15 locked，0 unlocked**（1 条因禁用会破坏语法而跳过）。

## 修复 2：新增 rule-coverage 元测试

把上述测量固化为 `tests/rule-coverage.check.mjs`。它做的是：

1. 对每条规则，只把它的 `fail(...)` 换成空操作
2. 确认 `check.mjs` 仍能正常运行（不是崩溃）
3. 要求 `validator.check` 变红

这一步很关键：如果替换方式导致 `check.mjs` 崩溃，测量就失去意义。我第一版探测脚本就踩了这个坑——粗暴替换条件会让代码不再合法，于是大量规则被误报为 UNLOCKED。第二版改为只替换报告调用后才得到真实数字。

## 修复 3：i18n 断言从恒真恢复为真检查

R2 指出 `consistency.check` 的 i18n 断言已退化为恒真：它取键前后 60 字符窗口，然后要求 `t(` 紧邻键——但窗口起点就是开引号，`t(` 永远不可能在窗口末尾。

更糟的是，我修正后加了 sanity 检查，立刻发现**检测器本身也是坏的**：

```
FAIL  the translation-lookup detector recognises known keys — detected 0/2
```

原因是翻译函数被压缩成单个字母：实际调用是 `e("chapterNavigation_deleteSession", "Delete session")`，而不是 `t(...)`。我最初的正则写死了 `t|i18n.t|translate`。

两次修正后：

- 按**调用形态**识别（1-2 字符标识符 + `("key"`）
- 加上**第二参数**要求（翻译调用总带 fallback 文案，存储调用不带）

结果：
```
ok    no key used as a translation lookup is reported as a storage key
ok    the translation-lookup detector recognises known keys
```

第二条 sanity 检查是这次的关键收获——**没有它，第一条会因为 regex 失效而永远通过**。

## 修复 4：文档数字断言的边界匹配

`readme.includes("16 个存储键")` 会被 `"116 个存储键"` 满足。改为 `(?<!\d)16\s*个存储键`。

同时把 `architecture.md` 和 `navigation.md` 纳入检查——它们此前**完全没被读取**，因此一直写着"14 个存储键"（实际 16）而无人发现。

新增断言：任何文档里出现 `<n> 个存储键` 且 n ≠ 审计值，都算失败。这比"检查特定数字是否存在"更彻底——它不关心错成了什么，只看是否等于真相。

修完后：
```
FAIL  architecture.md states no stale storage-key count — found 14, expected 16
FAIL  navigation.md states no stale storage-key count — found 14, expected 16
```

修正文档后全部通过。

## 修复 5：新增 doc-boundary 元测试

`tests/doc-boundary.check.mjs` 验证边界匹配真的生效：

```
ok    baseline docs pass
ok    rejects '116 个存储键' when the real count is 16
ok    the failure names the stale count
ok    rejects a wrong count in navigation.md
```

第三项确认它不只失败，还**指出了错误的值**——否则运维只看到红叉却不知道该改成多少。

## 验证结果

```
npm run ci      → 18 个测试全部通过
npm run release → packaged: 27 files
                → browser verification passed
                → FAIL: none
```

测试从 16 个增至 **18 个**。

## 本轮的方法论收获

前五轮的教训是"守卫要能被证伪"。本轮补充一条更精确的：

**元测试本身需要 sanity 检查。**

我在修 i18n 断言时，如果只写"没有翻译键被当成存储键"这一条，那么当检测正则失效（`t(` 匹配不到压缩后的 `e(`）时，断言会因为"检测不到任何翻译键"而永远通过。加上"检测器必须认出已知键"这一条后，regex 失效会立刻暴露。

同理，`rule-coverage.check` 里"确认 check.mjs 仍能运行"这一步，也是为了防止测量工具自身故障被误读成"规则未覆盖"。

## 剩余遗留

R2 还报了 10 个 P2，本轮未处理，主要是：

- `consistency.check` 的 storage-key 断言仍是单向（真实键从 audit 删掉检测不到）
- 1000 字符窗口仍是启发式，一行无关代码就能满足
- `check.mjs` 的 `API_PERMISSION` 只映射 12 个命名空间
- `validator.check` 的 locale 存在性规则因禁用方式会破坏语法而未纳入覆盖测量

这些属于"覆盖的输入空间仍可扩展"，不影响当前结论的正确性。
