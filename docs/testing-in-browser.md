# 在浏览器中测试

本工程产出的扩展包可以直接导入 Chrome 或 Edge 运行。

## 已构建好的包

运行 `npm run package` 后，`release/` 目录下会生成：

```
release/
├── vcaptions-test-2.4.6/          ← 导入这个目录（未打包形式）
└── vcaptions-test-2.4.6.zip       ← 同内容压缩包，用于分发
```

`vcaptions-test-2.4.6/` 里有 27 个文件、18.24 MB，版本号 `2.4.6`，与官方商店版完全一致（字节级重建）。

## 导入步骤

### Chrome / Edge

1. 地址栏打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `release/vcaptions-test-2.4.6` 目录（**不是** zip 文件）

导入后应该看到：
- 名称：vCaptions - Video Caption List
- 版本：2.4.6
- 一个正在运行的 service worker

### 验证是否正常

打开任意视频页面（如 YouTube 或 Bilibili），扩展会注入字幕列表 UI。点击工具栏图标可以打开侧边栏。

也可以打开扩展的选项页检查设置界面是否正常渲染。

## 已验证的事实

我没有只做结构检查，而是用真实的 Chrome 155 加载并运行了产物：

```
chrome:    chrome.exe (Chrome/155.0.8059.85)
extension: release\vcaptions-test-2.4.6
version:   2.4.6
ok    Chrome accepts the unpacked extension
extension id: fcdboeobnnkhhgodpgdichclhcbbolil
ok    service worker is running
ok    extension runtime is live in the worker
ok    worker reports the packaged version
ok    onMessage API is available to the worker
ok    worker started without uncaught exceptions
ok    extension page opens
ok    React root exists in the page
ok    UI actually rendered
ok    page has content
ok    page rendered without uncaught exceptions

browser verification passed
```

这证明了：Chrome 接受了 manifest、service worker 真实启动、扩展运行时可用、React UI 确实渲染出来了。

随时可以自己复验：

```bash
npm run verify:browser
```

## 关于与商店版共存

Chrome 用扩展 ID 区分安装。**未打包加载的扩展 ID 由目录路径推导**，与商店版的固定 ID（`bciglihaegkdhoogebcdblfhppoilclp`）不同，因此两者可以同时存在、互不冲突。

代价是：未打包加载的版本有自己的独立存储，不会读取商店版已有的配置、字幕缓存和登录状态。这是测试时的正常现象。

如果要区分得更清楚，可以打包一个带版本后缀的变体：

```bash
npm run package:test    # 版本变成 2.4.6.1
```

## 测试时的注意事项

**扩展需要联网。** 字幕抓取、翻译、AI 章节、账号登录都依赖外部服务（`api.vcaptions.com`、`api.openai.com`、`api.niutrans.com` 等）。离线状态下 UI 能打开，但功能会报错。

**设置页的日志面板很有用。** 打开选项页可以按模块调整日志级别（`BG:Translate`、`CS:Adapter:YouTube`、`APP:Hook:Chapter` 等 36 个模块），排查问题时先调成 `trace`。

**Chrome 137+ 移除了 `--load-extension` 命令行参数。** 所以自动化验证走的是 CDP 的 `Extensions.loadUnpacked`，手动测试则用上面的 UI 步骤。

**不要用商店版覆盖测试版。** 如果两者都装了，确认你在 `chrome://extensions` 里操作的是 ID 以 `fcdboeobn...` 开头那个（每次加载路径不同 ID 会变）。

## 打包参数

```bash
npm run package                      # 版本 2.4.6，与商店版一致
npm run package -- --suffix test.1   # 版本 2.4.6.1
npm run package -- --name-suffix     # 名称加上 (test)
```

`npm run release` 会一次性完成：干净构建 → 结构校验 → 行为测试 → 打包 → 真实浏览器验证。
