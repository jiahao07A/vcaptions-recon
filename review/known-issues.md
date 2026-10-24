# 已知问题清单

审查时先读这里。已在册的问题不要重复报告，除非你发现了**新证据**或**更严重的影响面**（请在报告中注明"已知问题的延伸"）。

## 已修复（无需再报，但可验证修复是否彻底）

| # | 问题 | 修复方式 | 验证方式 |
| --- | --- | --- | --- |
| 1 | `check.mjs` 在 locale 文件缺失时静默通过 | 改为 fatal，并校验所有 locale 可解析 | `node tests/validator.check.mjs` |
| 2 | `--name-suffix` 产生无效 i18n 键 `"__MSG_appName__ (test)"` | 先解析真实名称再拼接 | `node tests/package.check.mjs` |
| 3 | `browser-verify.mjs` 用 `child.kill()` 泄漏 Chrome 进程树 | 改用 `taskkill /T` | 跑完检查残留进程 |
| 4 | 处理器计数三处不一致（96/159/176） | 统一为 158（后台 97 + UI 31 + 内容脚本 34） | `node tests/consistency.check.mjs` |
| 5 | `audit.mjs` 正则漏检 `async e=>{}` 无括号写法 | 正则支持三种写法 | 同上 |
| 6 | 文档声称 207 个 Chrome API 调用点（实为 REA 工具数） | 改为 6 个成员 / 29 处调用 | 同上 |
| 7 | 文档声称 7698 处中文文案 | 改为 1657 条去重字符串 | 同上 |
| 8 | 文档声称 epilogue 57,114 行（实为 57,140） | 已更正 | 同上 |
| 9 | 符号索引把 90 个 i18n 键当成存储键 | 改为从审计结果动态加载（14 个） | 同上 |
| 10 | **`npm run verify` 静默抹掉 `src/bundles/` 手改** | 加检测：有手改则拒绝并指名文件 | `node tests/edit-safety.check.mjs` |
| 11 | epilogue 无法 adopt（业务代码全在这里） | 新增 `--epilogue` / `--preamble` | 同上 |
| 12 | `build-report.json` 被写进 `dist/`（扩展包根目录） | 移到项目根 | `Test-Path dist\build-report.json` |
| 13 | 拆分器模块边界漏掉 `register(...)` 收尾括号 | 改用括号栈匹配整个调用 | `node tests/overlay.check.mjs` |
| 14 | `format.mjs` 无法格式化 preamble/epilogue 片段 | 改为格式化整个 bundle 再按边界切分 | `npm run format` 应 10/10 |

## 已知限制（不是缺陷，是产物本身的性质）

- 标识符已被压缩（`e`/`i`/`c`），无法恢复原始命名。这是发布时丢失的信息。
- 无 sourcemap，无原始文件路径。
- `node_modules` 依赖未还原为 `package.json` 条目，精确版本不可知（已识别 17 个库）。
- 未重建 Plasmo + Parcel 构建流水线；当前是"从基线重组"而非"从源码编译"。
- `_metadata/verified_contents.json` 有意不打包（商店签名文件，重新打包后必然失效）。

## 已知待观察（尚未定性）

- `dist/` 中 `options.d68fb9df.css` 为 40 字节，内容与 `options.css` 重复，疑为 Parcel 产物的冗余，未确认是否可安全移除。
- `sidepanel.65d86198.js`、`Main.00175a8f.js`、`tabs/tab-main.1e0435ca.js` 三者的 epilogue 内容高度相似（57,140 行），已确认是同源代码经 `appType` 区分，但未验证三者在所有分支上行为一致。
