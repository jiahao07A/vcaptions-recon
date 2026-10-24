# vCaptions 架构说明

本文档描述 vCaptions 2.4.6 的实际架构。事实部分由 `tools/audit.mjs` 从产物自动提取（`architecture.generated.json`），推断部分已明确标注。

## 技术栈

产物由 **Plasmo** 框架打包（文件名形如 `icon16.plasmo.00ac8b83.png`、`Main.00175a8f.js`），底层打包器是 **Parcel 2**（`parcelRequire4da4` 模块注册表）。

UI 层：React + react-dom，样式用 Tailwind CSS + DaisyUI，Toast 用 react-toastify，长列表用 react-virtuoso。

| 库 | 作用 | 出现位置 |
| --- | --- | --- |
| `webextension-polyfill` | 跨浏览器 API 兼容层 | 全部 10 个 bundle |
| `react` / `react-dom` / `scheduler` | UI 渲染 | 6 个 UI 上下文 |
| `immer` | 不可变状态更新 | 后台与 UI |
| `i18next` | 国际化 | UI 上下文 |
| `openai` | AI 能力 SDK | 后台、设置页 |
| `buffer` / `base64-js` | 二进制与编码 | 后台、UI |
| `idb` | IndexedDB 封装 | 后台 |
| `posthog` | 使用统计 | 后台 |
| `pinyin` | 中文拼音处理 | 内容脚本、UI |
| `lodash` | 工具函数 | 广泛 |
| `react-virtuoso` | 虚拟滚动（字幕长列表） | 内容脚本、UI |
| `daisyui` / Tailwind | 样式体系 | 内容脚本 |

## 运行上下文

manifest 声明了 5 个内容脚本 + 1 个 Service Worker + 侧边栏 + 设置页 + 标签页：

| 上下文 | 产物文件 | 说明 |
| --- | --- | --- |
| Service Worker | `static/background/index.js` | 后台服务，所有业务状态的权威来源 |
| 内容脚本（主） | `MainCS.277dcde3.js` | 注入页面，桥接页面与扩展 |
| 内容脚本（IFrame） | `IFrameCS.26275720.js` | `all_frames: true`，处理视频 iframe |
| 内容脚本（YouTube） | `YoutubeCS.6bf33c81.js` | YouTube 站点适配 |
| 内容脚本（Webapp） | `WebappCS.8b5d7cd6.js` | 仅在 `*.vcaptions.com` 注入 |
| 内容脚本（应用） | `Main.00175a8f.js` | 主 UI 应用（4.74 MB） |
| 内容脚本（字幕条） | `SubtitleBar.f2dae354.js` | 页面内字幕条组件 |
| 侧边栏 | `sidepanel.65d86198.js` | Side Panel UI |
| 设置页 | `options.6406b895.js` | 设置与账号 |
| 标签页 | `tabs/tab-main.1e0435ca.js` | 独立标签页视图 |

`Main`、`sidepanel`、`tab-main` 三者共享同一套 60 个模块（按序号逐位比对，体积完全一致），差异仅在 Parcel 生成的变量名混淆。这印证它们来自同一份应用代码库，通过 `appType` 参数区分渲染形态。

## 三层消息协议

扩展内部有三种并存的通信方式，这是理解代码的关键。

### 1. 消息处理器（158 个，分三层）

同一个 `NAME: async (...) =>` 形状的处理器分布在三个上下文，数量分别是：

| 层 | 位置 | 数量 | 职责 |
| --- | --- | --- | --- |
| 后台 | `static/background/index.js` | 97 | 权威状态源，处理 `chrome.runtime` 消息 |
| UI | `Main` / `sidepanel` / `tab-main` | 31 | 应用层消息，经后台路由到具体窗口 |
| 内容脚本 | `MainCS` / `SubtitleBar` / `YouTube` 等 | 34 | 标签页内动作，如字幕条挂载与显示 |

只统计后台会漏掉一半协议，所以文档和工具都按层报告。跨层同名处理器（如 `APP_GET_SUBTITLE_BAR_STATE`）在两处都有定义，属于正常的请求/响应两端。

后台处理器按功能分类：

- **字幕**：`GET_SUBTITLE_CONTENT`、`STORE_SUBTITLE_CONTENT`、`ADD_SUBTITLE`、`UPLOAD_SUBTITLE`、`CLONE_SUBTITLE`、`DELETE_SUBTITLE`、`GET_NEXT_AVAILABLE_SUFFIX`
- **翻译**：`CREATE_TRANSLATE_SESSION`、`GET_TRANSLATE_SESSION`、`PAUSE_TRANSLATE_SESSION`、`RESUME_TRANSLATE_SESSION`、`RETRY_FAILED_TRANSLATE_TASKS`、`RESTART_TRANSLATION`、`ADD_TRANSLATE_TASKS`、`DELETE_TRANSLATE_SESSION`
- **章节**：`CREATE_CHAPTER_SESSION`、`TRANSLATE_CHAPTER`、`STORE_CHAPTER_INFO`、`GET_CHAPTER_INFO`、`PAUSE_CHAPTER_SESSION`、`RESUME_CHAPTER_SESSION`、`UPDATE_CHAPTER_SELECTED`
- **AI 聊天**：`CREATE_CHAT_SESSION`、`SEND_CHAT_MESSAGE`、`GET_CHAT_SESSIONS_BY_TID_AND_VID`、`CANCEL_CHAT_REQUEST`、`UPDATE_CHAT_SESSION_TITLE`
- **字幕精调**：`CREATE_FINETUNE_SESSION`、`PAUSE_FINETUNE_SESSION`、`RESUME_FINETUNE_SESSION`、`RETRY_FAILED_FINETUNE_TASKS`
- **转写**：`CREATE_TRANSCRIPTION`、`GET_TRANSCRIPTION_SESSION`、`RETRY_TRANSCRIPTION`
- **笔记**：`ADD_NOTE`、`UPDATE_NOTE`、`DELETE_NOTE`、`BATCH_DELETE_NOTES`、`RENAME_NOTE_TAG`、`DELETE_NOTE_TAG`、`GET_NOTE_INFO`
- **存储**：`STORAGE_GET`、`STORAGE_SET`、`STORAGE_KEYS`、`STORAGE_DELETE`、`STORAGE_REFRESH`
- **视频信息**：`GET_VIDEO_INFO`、`REFRESH_VID_INFO`、`REFRESH_SUBTITLE_INFO`、`FETCH_AND_SUPPLEMENT_SUBTITLES`
- **备份**：`BACKUP_VIDEO_DATA`、`RESTORE_VIDEO_DATA`、`CLEAR_VIDEO_DATA`
- **字幕条**：`GET_SUBTITLE_BAR_STATE`、`REQUEST_MOUNT_SUBTITLE_BAR`、`SAVE_SUBTITLE_BAR_CONFIG`、`SAVE_SUBTITLE_BAR_POSITION`、`SET_SUBTITLE_BAR_VISIBLE`
- **侧边栏**：`OPEN_SIDE_PANEL`、`CLOSE_SIDE_PANEL`
- **统计**：`TRACK_ANALYTICS_EVENT`

完整清单见 `architecture.generated.json` 的 `protocol.background_handlers`。

### 2. 标签页动作（8 个）

后台向内容脚本下发的小写动作：

```
vcaptions_mount            vcaptions_unmount          vcaptions_toggle_mount
vcaptions_subtitle_bar_mount   vcaptions_subtitle_bar_display
vcaptions_subtitle_bar_language_changed
vcaptions_log_config       vcaptions_assistant
```

### 3. 应用内部命令（11 个）

`APP_*` 与 `BAR_*` 是应用层（字幕列表 ↔ 字幕条）之间的定向消息，携带 `windowId`、`tabId`、`appSlot` 路由字段：

```
APP_GET_SUBTITLE_BAR_STATE          APP_GET_SUBTITLE_BAR_CHAPTER_STATE
APP_NOTIFY_SUBTITLE_BAR_HIDE        APP_NOTIFY_SUBTITLE_BAR_CHAPTER_STATE
APP_JUMP_TO_CHAPTER                 APP_JUMP_TO_TIME
APP_REFRESH_VID_INFO                APP_SET_CS_ID
APP_HEARTBEAT
BAR_SET_CHAPTER_STATE               BAR_JUMP_TO_TIME
```

## 功能域

从 158 个处理器归纳出 53 个动作前缀域，对应实际产品功能：

**核心**：字幕列表抓取与展示、字幕条悬浮显示、网站级显示配置（位置/布局/字体/行高）、多选复制、格式导出（含 LRC）。

**AI 能力**：字幕翻译、字幕精调、章节生成、章节翻译、AI 对话、语音转写。服务商支持 AI（OpenAI 兼容）、Google、小牛（Niutrans）、DeepL。

**辅助**：笔记与标签、按时间戳跳转、字幕搜索、备份/恢复（加密压缩）、用量与 VIP 额度。

## 外部服务

从产物提取的端点，按用途分组：

**自有服务**
```
https://api.vcaptions.com/api/v1
https://api.vcaptions.com/api/v1/settings
https://www.vcaptions.com
```

**AI 服务商**
```
https://api.openai.com/v1          https://auth.openai.com/oauth/token
https://api.deepseek.com
https://generativelanguage.googleapis.com/v1beta/openai/
```

**翻译服务**
```
https://api.niutrans.com/v2/text/translate/array
```

**站点适配**
```
https://api.bilibili.com/x/player/wbi/v2       （Bilibili 播放器信息）
https://api.bilibili.com/x/web-interface/view  （Bilibili 视频详情）
https://api.bilibili.com/x/player/pagelist     （Bilibili 分P列表）
https://www.youtube.com/youtubei/v1/next       （YouTube 内部 API）
```

**统计**
```
https://app.posthog.com
```

## 权限模型

manifest 声明的权限是 `storage`、`scripting`、`sidePanel`、`tabs`、`activeTab`，主机权限为 `<all_urls>`（通过 `https://*/*` + `http://*/*`）。

值得注意的是 `host_permissions` 覆盖所有站点，而实际网络请求集中在自有 API 与上述服务商。这是内容脚本需要在任意站点注入的必然结果。

快捷键：`Ctrl+Shift+C` 复制字幕，`Ctrl+Shift+D` 下载字幕。

## 存储键

提取到 16 个存储键，覆盖配置、会话与缓存：

```
websiteConfig        subtitleInfo         subtitleContentInfo
chapterInfo          chatSession          chat_session
noteInfo             videoInfo            transcription_deleteSession
chapterNavigation_deleteSession          chapterNavigation_noChapterInfo
videoControlBar_noVideoInfo              websiteConfigBtn_websiteConfig
vcaptions_log_config
```

存储分两层：`chrome.storage.local`（配置与会话）与 IndexedDB（大块数据，通过 `idb` 访问）。网站配置以域名为键，带 `_version` 与 `_lastMigrated` 字段，说明存在配置迁移机制。

## 关于代码可读性

压缩产物保留了全部字符串字面量，这是逆向时最有价值的信息源：

- **1,657 条去重中文文案**（45,007 个 CJK 转义序列），覆盖 UI 标签、错误提示、日志。后台日志模块甚至保留了完整的原始模块命名表（`BG:Storage`、`CS:Adapter:YouTube`、`APP:Hook:Chapter` 等 53 个前缀域），这是重建目录结构的权威依据。
- **可定位的 API 调用点**：29 处 `chrome.*` 直接调用（`runtime.id`、`runtime.lastError`、`runtime.onMessage`、`scripting.registerContentScripts` 等 6 个成员）。多数扩展 API 经 `webextension-polyfill` 包装，属间接调用。
- **可识别的第三方库签名**：见上表。

相反，标识符全部丢失（PascalCase 函数名为 0），控制流被压缩成单行。因此阅读代码时应以字符串和 API 调用为锚点，而不是从函数名推断意图。

## 数据流

以「打开视频 → 看到字幕列表」为例：

1. 内容脚本 `MainCS` 注入页面，向后台发 `GET_VIDEO_INFO`。
2. 后台识别站点，调用对应适配器（YouTube / Bilibili / 回退），抓取视频标识。
3. 后台查询字幕：命中缓存则返回，否则请求字幕源并 `STORE_SUBTITLE_CONTENT`。
4. 后台通过 `vcaptions_mount` 通知内容脚本挂载 UI。
5. `Main` 应用渲染字幕列表，同时可挂载 `SubtitleBar` 显示悬浮字幕条。
6. 用户触发翻译 → `CREATE_TRANSLATE_SESSION` → 后台建立任务队列，逐条调用翻译服务，进度通过消息回传。
7. 章节生成同理，走 `CREATE_CHAPTER_SESSION`，结果通过 `APP_NOTIFY_SUBTITLE_BAR_CHAPTER_STATE` 同步到字幕条。

> 以上流程是根据消息名、存储键与字符串文案重建的**行为模型**，非逐行验证的执行路径。实际控制流需结合 `epilogue.js` 中的实现确认。
