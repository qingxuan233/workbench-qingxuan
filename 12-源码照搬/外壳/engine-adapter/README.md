# 外壳/engine-adapter —— DSH 引擎适配层（P2）

> 目的：把"对 DSH 引擎内部 DOM 的劫持"（选择器 / CSS / 注入脚本）收成**一份**，取代原来
> `main.js` 与 `renderer/renderers.js` 各写一遍的重复实现。契约见
> `_本机产物/优化报告/改造执行/P2-接口契约.md`（本机产物）；本文件是仓库内口径。
>
> ⚠ 这是**最脆的一层**：上游引擎换版可能静默降级（侧栏藏不住、钉会话失效、对话列变窄）。
> 动这里之前先读 `_本机产物/优化报告/DSH内核兼容.md` 与 `AGENTS.md §5-13 / §6.5`。

## 加载方式（无构建链）

`contract.js` 是 **UMD**：

- **主进程（CJS）**：`const ADAPTER = require('./engine-adapter/contract.js')`（`main.js` 顶部）。
- **渲染层（浏览器脚本）**：`renderer/index.html` 在 **`renderers.js` 之前**加载
  `<script src="../engine-adapter/contract.js"></script>` ⇒ 全局 `window.__WB_ENGINE_ADAPTER`。
  渲染页面由主进程 `win.loadFile(path.join(__dirname,'renderer','index.html'))` 打开（file:// URL），
  所以 `../engine-adapter/contract.js` 能直接解析到本目录，**不需要主进程额外做静态路由**。
- 若以后渲染页改走 HTTP（站点服务），需在站点路由里放行 `/engine-adapter/contract.js`。

## 版本策略

- `ADAPTER.VERSION` 随契约面变化递增：新增/改变选择器或注入脚本 = 至少 +0.1；
  删除/改语义 = 大版本。**引擎升级后**必须同时：跑 `engine-after`（锚点）+ `engine-selfcheck`
  （运行时命中数）+ 更新本目录注释里的实测结论。
- 两侧代码只允许通过 API 取值，**禁止再写字面量**（否则 P2 收口失效）。

## 已收口（2026-11-08，两批完成，`VERSION=1.0.0`）

| API | 内容 | 等价性（已机械核验） |
|---|---|---|
| `SELECTORS` | 14 个键 / 13 条内部契约（会话行+分组头合算一条，投影缓存+插件插槽合算一条） | 新增索引；值取两侧现状 |
| `WIDE_COL` / `WIDE_CARD` | `calc(100% - 16px)` | 与两侧原值**逐字节一致** |
| `wideCss()` | 原 `HARNESS_WIDE_CSS` 三条 CSS（返回数组） | 三元素与两侧原输出**逐字节一致** |
| `chatCss({centerColFix})` | 原 `HARNESS_CHAT_CSS`（main 传 `true` 含 centerCol 2 条规则；渲染层传 `false`） | join 后与两侧原文本**逐字节一致** |
| `widePinJs({layers})` | 原 `HARNESS_WIDE_PIN_JS`（main 传 `false`；渲染层传 `true`，多 layers 计数） | 与两侧原注入文本**逐字节一致**（1578 / 1698 字符） |
| `fixJs({profile, pinJs})` | `profile:'main'` = 布局修复+centerCol内联+完整 `window.__fixDiag`；`profile:'renderer'` = 布局修复+极简 JSON 诊断+末尾嵌 `pinJs` | **非逐字节**：去注释/空白后逐字符等价（3741 / 2318 字符，见下「差异登记」） |

## 差异登记（为什么 `fixJs()` 不是逐字节，以及验收怎么替代）

`main.js` 与 `renderers.js` 的 `FIX_JS` 在 P2 之前**已经漂移成两种载荷**（归一化逐行只有约 5 行相同）：
main 侧要 `window.__fixDiag` 完整诊断（kidsInfo/rect/pinDiag/winW/H/url…），渲染层要 `return JSON.stringify(...)`
给面板标题行、且末尾必须嵌 `${HARNESS_PIN_JS}`（钉会话脚本本来只在渲染层）。
若强行"逐字节"，只能把两份原文各存一份（去重收益≈0）。Lead 拍板采用：

- `wideCss()/chatCss()/widePinJs()`：主体单写，profile 条件片段拼出 ⇒ **逐字节等价**；
- `fixJs()`：单主体 + profile 片段（centerCol 段、诊断段、pin 段条件化），注释文案统一 ⇒ **非逐字节**，
  验收改为：
  1. 分 profile 去注释/空白后**逐字符等价**（`main: 3741 chars`、`renderer: 2318 chars`，共同前缀 = 全长）；
  2. 两个输出都过 `new Function()` 解析；
  3. 回归判据：main 档诊断字段一个不少、renderer 档必须 `return JSON.stringify(...)` 且末尾嵌 pin。
- 闸门侧 `check-injected.mjs` 已改为**从 adapter 生成物取脚本再做解析/断言**（PI 由 Lead 统一改），
  并新增"main.js / renderers.js 不自带注入脚本字面量"的反向断言；`PIN_JS`/`DROP_JS` 仍从 renderers.js 原样检查。

## API（`VERSION=1.0.0`，四个 face / 渲染层共用）

```js
ADAPTER.VERSION                       // '1.0.0'
ADAPTER.SELECTORS                     // 14 键 / 13 条内部契约（见下）
ADAPTER.WIDE_COL / WIDE_CARD          // 'calc(100% - 16px)'
ADAPTER.wideCss()                     // → string[]（调用方 join('\n')，原常量是 string）
ADAPTER.chatCss({centerColFix})       // → string[]（main:true / renderer:false）
ADAPTER.widePinJs({layers})           // → string（注入脚本；main:false / renderer:true）
ADAPTER.fixJs({profile, pinJs})       // → string（profile:'main'|'renderer'；renderer 档把 pinJs 嵌末尾）
```

调用方（已落地）：
- `main.js`：`const ENGINE_ADAPTER = require('./engine-adapter/contract.js')`；
  `HARNESS_WIDE_CSS = wideCss().join('\n')`、`HARNESS_CHAT_CSS = chatCss({centerColFix:true}).join('\n')`、
  `HARNESS_FIX_JS = fixJs({profile:'main'})`。
- `renderers.js`：`var ENGINE_ADAPTER = window.__WB_ENGINE_ADAPTER`（index.html 先加载）；
  `widePinJs({layers:true})`、`chatCss({centerColFix:false}).join('\n')`、
  `fixJs({profile:'renderer', pinJs: HARNESS_PIN_JS})`。

## 13 条引擎内部契约（`SELECTORS` 对应）

| # | 契约 | 值/说明 |
|---|---|---|
| 1 | `data-chat-flow` | 对话流/中心列锚点；会话列与输入卡都挂它 |
| 2 | `data-phase` | 相位容器（会话标题栏父级）；**不是**会话列锚点 |
| 3 | `data-width-handle` | 列宽拖拽手柄（侧栏/详情列） |
| 4 | `data-side` | 只挂手柄；取值只有 `left`/`right`（`sidebar`/`details` 恒 0 命中） |
| 5 | `data-composer-card` | 输入卡（max-width 需压到宽） |
| 6 | `data-composer-input` | Lexical contenteditable 输入框（拖文件插入用） |
| 7 | 内联 `grid-template-columns` + `minmax(` | 应用框架的定位方式（唯一命中元素） |
| 8 | `centerCol`/`sidebarCol`/`rightbarCol` 类名子串 + `grid-area:1/1,1/2,1/3` | 0.2.2 起三列布局；单轨道后要钉回第 1 列 |
| 9 | `:has([data-chat-flow])` | 不依赖哈希类名的中心列锚点（引擎换版仍可用） |
| 10 | `[class*="embeddedBody"]`/`[class*="column"]` 上的 `--dsh-chat-content-width` / `--dsh-composer-card-max-width` | 引擎 Composer 读这两个变量 |
| 11 | `div[role="treeitem"][aria-selected]` + `span class*="title"`；`[aria-expanded]` 分组头 | 会话行/分组头（只比对标题节点文本） |
| 12 | `dsh.sessions.current`（localStorage） | 会话选中态键 |
| 13 | `session_projcache` / 插件插槽 `conversation.chat.flow` | 会话投影缓存名 / 插件接线点 |

> 完整锚点清单与实测命中数：`_本机产物/优化报告/DSH内核兼容.md`、`engine-after.mjs` 的 `ANCHORS`。
