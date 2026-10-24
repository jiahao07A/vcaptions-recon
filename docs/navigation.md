# 功能导航

「某个功能在哪」的速查表。所有位置指向 `src/readable/` 中的**格式化后可读代码**，行号可直接跳转。

## 怎么用

1. 在下面的表里找到你要改的功能
2. 打开对应的 `bundle/99-epilogue.js`，跳到标注的行号
3. 改完后运行 `npm run build`，确认只有预期的 bundle 变化

完整符号清单（158 个消息处理器、16 个存储键、25 个端点）见 `symbol-index.json`。

## 后台服务

所有后台逻辑集中在 `src/readable/static__background__index/99-epilogue.js`（22,393 行）。处理器是一个大对象字面量，键名即消息名：

```js
CREATE_TRANSLATE_SESSION: async (I, G) => { ... }
```

用 `grep` 定位最快：

```bash
grep -n "CREATE_TRANSLATE_SESSION:" src/readable/static__background__index/99-epilogue.js
```

### 功能域与处理器

| 功能 | 处理器前缀 | 数量 | 代表处理器 |
| --- | --- | --- | --- |
| 读取状态 | `GET_*` | 21 | `GET_CHAPTER_INFO`、`GET_CHAT_SESSION`、`GET_VIDEO_INFO` |
| 更新状态 | `UPDATE_*` | 15 | `UPDATE_AUTH_STATE`、`UPDATE_DISPLAY`、`UPDATE_CURRENT_TIME` |
| 删除数据 | `DELETE_*` | 13 | `DELETE_SUBTITLE_CONTENT`、`DELETE_NOTE_INFO`、`DELETE_CHAPTER` |
| 应用层路由 | `APP_*` | 9 | `APP_GET_SUBTITLE_BAR_STATE`、`APP_JUMP_TO_TIME` |
| 写入状态 | `SET_*` | 9 | `SET_SUBTITLE_INFO`、`SET_CHAPTER_INFO`、`SET_VID_INFO` |
| 内容脚本请求 | `CS_*` | 9 | `CS_REFRESH_SUBTITLE_INFO`、`CS_REQUEST_UPDATE_DISPLAY` |
| 刷新数据 | `REFRESH_*` | 7 | `REFRESH_SUBTITLE_INFO`、`REFRESH_VID_INFO` |
| 创建会话 | `CREATE_*` | 5 | `CREATE_TRANSLATE_SESSION`、`CREATE_CHAPTER_SESSION`、`CREATE_CHAT_SESSION` |
| 存储服务 | `STORAGE_*` | 5 | `STORAGE_GET`、`STORAGE_SET`、`STORAGE_KEYS` |
| 重试失败任务 | `RETRY_*` | 4 | `RETRY_FAILED_TRANSLATE_TASKS` |
| 字幕条路由 | `BAR_*` | 3 | `BAR_SET_CHAPTER_STATE`、`BAR_JUMP_TO_TIME` |
| 笔记 | `*_NOTE*` | 8 | `ADD_NOTE`、`RENAME_NOTE_TAG`、`BATCH_DELETE_NOTES` |
| 播放笔记 | `*_PLAY_NOTE*` | 5 | `FIRST_PLAY_NOTE`、`NEXT_PLAY_NOTE`、`START_PLAY_NOTES` |
| Bilibili 适配 | `*_BILIBILI*` | 5 | `BILIBILI_MODE_CHANGED`、`APPLY_BILIBILI_WIDTH`、`PREVIEW_BILIBILI_WIDTH` |
| 下载 | `DOWNLOAD_*` | 2 | `DOWNLOAD_SUBTITLES`、`DOWNLOAD_AUDIO` |
| 侧边栏 | `OPEN/CLOSE_SIDE_PANEL` | 2 | — |
| 统计 | `TRACK_ANALYTICS_EVENT` | 1 | — |

### 按功能定位

**字幕抓取与展示**
```
GET_SUBTITLE_CONTENT        src/readable/static__background__index/99-epilogue.js
STORE_SUBTITLE_CONTENT      → 同上
FETCH_AND_SUPPLEMENT_SUBTITLES
UPLOAD_SUBTITLE / ADD_SUBTITLE / CLONE_SUBTITLE / DELETE_SUBTITLE
GET_NEXT_AVAILABLE_SUFFIX
```

**翻译（AI / Google / 小牛 / DeepL）**
```
CREATE_TRANSLATE_SESSION: async (I, G) => {     ← 第 21097 行
ADD_TRANSLATE_TASKS / RESTART_TRANSLATION
PAUSE_TRANSLATE_SESSION / RESUME_TRANSLATE_SESSION
RETRY_FAILED_TRANSLATE_TASKS / DELETE_TRANSLATE_SESSION
```

**AI 章节**
```
CREATE_CHAPTER_SESSION / TRANSLATE_CHAPTER
STORE_CHAPTER_INFO / GET_CHAPTER_INFO
PAUSE_CHAPTER_SESSION / RESUME_CHAPTER_SESSION
UPDATE_CHAPTER_SELECTED / DELETE_CHAPTER
```

**字幕精调**
```
CREATE_FINETUNE_SESSION / PAUSE_FINETUNE_SESSION
RESUME_FINETUNE_SESSION / RETRY_FAILED_FINETUNE_TASKS
```

**AI 对话**
```
CREATE_CHAT_SESSION / SEND_CHAT_MESSAGE / CANCEL_CHAT_REQUEST
GET_CHAT_SESSIONS_BY_TID_AND_VID / UPDATE_CHAT_SESSION_TITLE
```

**语音转写**
```
CREATE_TRANSCRIPTION / GET_TRANSCRIPTION_SESSION / RETRY_TRANSCRIPTION
DOWNLOAD_AUDIO / ADJUST_VOLUME / PLAY / STOP / MOVE
```

**字幕条**
```
GET_SUBTITLE_BAR_STATE: async (t, e) => {       ← 第 20641 行
REQUEST_MOUNT_SUBTITLE_BAR                       ← 第 20699 行
SAVE_SUBTITLE_BAR_CONFIG / SAVE_SUBTITLE_BAR_POSITION
SET_SUBTITLE_BAR_VISIBLE / NOTIFY_SUBTITLE_BAR_HIDE
```

**网站配置**
```
WEBSITE_CONFIG_UPDATED
SAVE_SUBTITLE_BAR_CONFIG → 按域名写入 websiteConfig（带 _version / _lastMigrated 迁移字段）
```

**备份与恢复**
```
BACKUP_VIDEO_DATA / RESTORE_VIDEO_DATA / CLEAR_VIDEO_DATA
→ 备份格式含 _vcaptions_backup: { version: "1.0", timestamp }（加密压缩）
```

## UI 应用

`Main`、`sidepanel`、`tab-main` 共享同一套源码，通过 `appType` 参数区分渲染形态。三者的 epilogue 长度不同（`Main` 58,439 行，`sidepanel` 与 `tab-main` 各 57,140 行），60 个模块中也有 2 个存在差异——共用的是应用主体，差异集中在渲染入口。

| 入口 | 文件 | 说明 |
| --- | --- | --- |
| 页面内应用 | `src/readable/Main.00175a8f/99-epilogue.js` | 注入网站的浮层 UI |
| 侧边栏 | `src/readable/sidepanel.65d86198/99-epilogue.js` | Side Panel |
| 独立标签页 | `src/readable/tabs__tab-main.1e0435ca/99-epilogue.js` | 全屏视图 |

状态管理用 **react-redux + redux-toolkit**。定位 action：

```bash
grep -n 'createSlice' src/readable/sidepanel.65d86198/99-epilogue.js | head -20
```

## 字幕条组件

`src/readable/SubtitleBar.f2dae354/99-epilogue.js`（7,130 行）。消息监听在 6959 行附近：

```js
if (e?.action === "vcaptions_subtitle_bar_mount") { ... }
if (e?.action === "vcaptions_subtitle_bar_display") { ... }
if (e?.action === "vcaptions_subtitle_bar_language_changed") { ... }
```

## 站点适配器

| 站点 | 文件 | 说明 |
| --- | --- | --- |
| 主脚本 | `MainCS.277dcde3`（2,317 行） | 通用注入与桥接 |
| IFrame | `IFrameCS.26275720`（3,560 行） | `all_frames: true` |
| YouTube | `YoutubeCS.6bf33c81`（726 行） | 调用 `youtubei/v1/next` |
| Bilibili | 在后台 epilogue 内 | `api.bilibili.com/x/player/wbi/v2` 等 |
| vCaptions 官网 | `WebappCS.8b5d7cd6`（513 行） | 仅 `*.vcaptions.com` |

## 设置页

`src/readable/options.6406b895/99-epilogue.js`（18,262 行）。包含日志配置面板（可切换 36 个模块的日志级别）、翻译服务商配置、账号与 VIP 额度。

## 常用检索

```bash
# 找某个消息的实现
grep -rn "GET_SUBTITLE_CONTENT" src/readable/ --include=99-epilogue.js

# 找某个存储键的所有读写点
grep -rn '"websiteConfig"' src/readable/

# 找某个外部接口
grep -rn "api.niutrans.com" src/readable/

# 找 UI 文案对应的代码（中文以 \u 转义保存在压缩产物中，
# 格式化后仍是转义形式，需搜索转义序列或直接搜英文标识）
grep -rn 'type: "button"' src/readable/sidepanel.65d86198/99-epilogue.js | head
```

## 修改时的注意事项

**改动会改变产物摘要。** 这是预期的：`npm run build` 会显示 `9/10 bundles byte-identical`，并列出被修改的 bundle。只要列表里只有你改的那个，就说明改动范围正确。

**不要直接改 `src/readable/`。** 它是从 `src/bundles/` 派生的只读视图，下次 `npm run format` 会覆盖。真正要改的是 `src/bundles/<bundle>/<moduleId>.js`（压缩格式，但改动会进入构建）。

如果要在可读代码上工作，建议流程是：在 `src/readable/` 里读懂逻辑 → 把改动应用到对应的 `src/bundles/` 模块 → `npm run build` 验证。

**跨模块改动要同步依赖。** 若某模块新增了对另一模块的 `C("id")` 引用，`modules.json` 里的 `dependencies` 需要更新，否则构建仍会通过但运行时可能找不到模块。
