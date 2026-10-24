# 第四轮：L4 剩余 P2/P3 与文档遗留

承接 `SUMMARY-round-3.md`。本轮修复了 L4 报告的 5 个 P2、1 个 P3，以及第三轮列出的文档遗留。

## 修复清单

### P2（5 项）

| # | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 1 | 孤儿文件放进 `dist/` 后会通过 build + check + package，并被装入发布包 | build 改为**暂存目录 + 原子替换**，产物成为输入的纯函数 | 放入 `STALE-ORPHAN.js` 后构建，文件被清除，27 文件恢复 |
| 2 | `rmrf(RELEASE)` 删除整个 `release/`，丢失历史产物 | 只清理本次要写的目录和 zip | 放入 `MY-ARCHIVE.txt` 后打包，文件保留 |
| 3 | `browser-verify.mjs` 默认路径写死 `vcaptions-test-2.4.6`，`package:test` 的产物不会被验证 | 自动发现 `release/` 下最新的包 | 打包 `2.4.6.1` 后，脚本正确选中它 |
| 4 | `web_accessible_resources` 的 `*.css` 通配符被直接跳过，从未校验 | 展开通配符，要求至少匹配到一个文件 | 改坏为 `*.nonexistent` 后正确报错；正常时报告 5 个文件 |
| 5 | `content script` 探测依赖 `example.com`，无外网时误报失败 | 改为本地 loopback HTTP 服务 | 23/23 通过，脱离外网依赖 |

### P3（1 项）

| # | 问题 | 修复 |
| --- | --- | --- |
| 6 | zip 的 DOS 时间戳取自文件 mtime，两次打包哈希可能不同 | 固定为常量时间戳，zip 成为内容的纯函数 |

验证：连续两次打包输出相同的 `zip sha256: 77828884…`，且 zip 仍能被标准库正常解压（27 条目）。

### 文档遗留（3 项）

| # | 问题 | 修复 |
| --- | --- | --- |
| 7 | `README.md` 把 `Main` 的 epilogue 写成 57,140 行（实际 58,439） | 已更正 |
| 8 | `docs/navigation.md` 称三个 UI 模块「共享同一套代码」，暗示完全一致 | 改为说明长度不同（58,439 / 57,140 / 57,140），60 个模块中有 2 个存在差异 |
| 9 | `docs/navigation.md` 部分行号示例已失效 | 已在第 3 轮修正 |

## 一个值得记录的教训：编码故障的误判

修文档时我一度以为文件被写坏了：控制台显示 `（57,140 �?epilogue）`，看起来 `行` 字损坏。我写了检查脚本逐字符验证，结果是：

- 文件中**没有** U+FFFD 替换符
- **没有**孤立代理项
- `行` 就是正常的 U+884C

所谓「损坏」纯粹是 **PowerShell 控制台输出时的编码转换损失**。如果我按这个误判去"修复"，反而会把正常内容改坏。

这类问题的判断依据只能是**读文件的字节**，不能看控制台回显。后续所有涉及中文文本的验证，我都改用 Node 读取并输出 codepoint，而不是依赖终端显示。

## 验证结果

```
npm run release
→ build: 10/10 bundles byte-identical to baseline
→ check passed
→ guard / chrome-env / smoke / overlay / overlay-edge / edit-safety
→ validator / package / consistency 全部 passed
→ packaged: 27 files, zip sha256 稳定
→ browser verification passed（23 项）
→ FAIL: none
```

## 累计状态

四轮共修复 **6 个 P0 + 20 个 P1 + 5 个 P2 + 1 个 P3**，测试从 3 个扩展到 13 个，断言从数十项增至 130+ 项。

## 剩余遗留

| 来源 | 问题 | 说明 |
| --- | --- | --- |
| L4 | `browser-verify.mjs` 固定端口 9340 | 并发运行时会冲突，单机测试够用 |
| L4 | 进程被强杀时 Chrome profile 残留（约 15 MB/次） | 已有 `killChromeTree`，但 `SIGKILL` 场景无法保证 |
| L4 | `sidepanel.html` / `tab-main.html` 的 `<title>` 是未替换的 `__MSG_appName__` | Chrome 不在 HTML 中做 i18n 替换；改动它会破坏与基线的字节一致性，因此保持原样并在此记录 |
| L5 | `adopt --all` 中途失败会留半成品 | 边缘场景 |
| L3 | `architecture.generated.json` 的 `storage_keys` 仍有 16 个而非 L3 估计的更多 | 已按调用点提取，但 L3 认为还有若干经变量间接使用、未被解出的键 |

最后一项需要说明：L3 认为真实存储键比 16 个更多。我的提取基于「字面量出现在 storage 调用点」或「与命名空间键同批声明的常量」，对经多层变量传递的键会漏。这是方法的已知上限，已记录而非掩盖。
