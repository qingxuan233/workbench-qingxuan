# AGENTS.md — 给 AI Agent 的工作台部署手册

> 本文件是**机器可执行版**：只有命令、判据和失败分支，背景解释在 [12-源码照搬/说明/使用说明.md](12-源码照搬/说明/使用说明.md)。
> 你（Agent）被要求"在某台新机器上把这个工作台跑起来"时，按 §2 顺序执行；
> 每条命令都给了**期望输出**，对不上就去 §5 查；§6 是脚本做不了、必须人做的三件事。
> **判据纪律**：§4 的每一条期望片段都是**实跑核实过**的（最近一次：2026-11-07）。
> 若某条判据确实不成立或未复跑核实，会在 §4 开头显式点名；**没有点名 = 都是当前真值**。
> 任何一条都不许读成"已经跑过了所以一定通过" —— 验收永远要你自己跑一遍。

> **main 分支定位**：可通用部署模板 + 通用迭代主干。
> 只保留通用机制和五个基础场景（`命令`、`B站`、`自我复盘`、`本地电脑`、`网页AI`）；
> 本机绝对路径、真实会话 id、客户/个人项目记忆一律不入库——它们只放 `工作台.json` 与本机实例数据。
> `work-dev` 这类个人场景在独立分支维护，不进 `main`。

---

## §0 事实表（先读，别猜）

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/qingxuan233/workbench-qingxuan.git`，分支 `main` |
| 应用根 | `<仓库>/12-源码照搬`（下称 `$APP`） |
| 启动入口 | `$APP\启动.bat`（外层：`<仓库>\启动工作台.bat`） |
| 实例清单 | `$APP\工作台.json` —— **不入库**，由 `初始化.mjs` 生成 |
| 数据根 | `$APP\引擎数据\.dsh`（会话 / 工作区 / 场景记忆） |
| 启动日志 | `$APP\外壳\data\startup.log`；外壳日志 `$APP\外壳\server.log` |
| 运行时 | Windows 10/11；Node.js ≥ 18（建议 20/22）；DSH 引擎可选但 AI 面板需要 |

场景/面板/端口的**唯一口径**是下面这段生成块（`场景校验.mjs --stamp` 写、`--check` 校验）；
标题必须一字不差，否则 `实例化.mjs` 配不上会话。

<!-- 场景事实表:开始（工具\场景校验.mjs --stamp 生成；勿手改） -->
| 项 | 值 |
|---|---|
| 场景数 | 5 |
| 场景（id → 标题） | `bilibili` → B站；`command` → 命令；`pc-cleanup` → 本地电脑；`self-review` → 自我复盘；`webai` → 网页AI |
| 面板总数 | 15 |
| AI 面板（harness） | 5 |
| 首屏场景 | `command` |
| 端口 | 引擎 `3083`（`DSH_PORT`）；站点 `31238`（写死）；网页版 AI 桥 `31239`（`WEB_AI_PORT`） |
| 场景配置目录 | `12-源码照搬\外壳\scenarios` |
<!-- 场景事实表:结束 -->

> ⛔ 上面标记区块**不得手改**；场景 json 变了就重跑 `node 工具\场景校验.mjs --stamp`，`--check` 会校验它与 json 是否一致。

---

## §1 前置检查（不通就别往下走）

```powershell
node -v                     # 期望 v18.x 及以上
git --version               # 期望有输出
```

引擎（DeepSeek Harness 桌面版）查找顺序，命中一个即可：

1. `$APP\工作台.json` 的 `engine.cliPath`
2. 环境变量 `DSH_CMD`
3. `where dsh`
4. `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
5. 系统常见安装目录（`%ProgramFiles%\DeepSeek Harness\…` 及各盘 Programs / DeepSeek Harness 目录）

> 找不到引擎**不阻塞启动**：界面能开，AI 面板不可用。修法见 §5-3。

---

## §2 部署步骤（顺序执行）

### ① 克隆到任意路径

```powershell
git clone https://github.com/qingxuan233/workbench-qingxuan.git
cd workbench-qingxuan\12-源码照搬
```

路径可以带空格和中文（目录名本身就是中文），代码里没有写死盘符。
**但 `.bat` 必须是 CRLF** —— 仓库用 `.gitattributes` 钉死；如果你是下 zip 解压的，先跑 §4 的编码检查。

### ② 预演，然后初始化

```powershell
node 工具\初始化.mjs --dry        # 只打印，不写文件
node 工具\初始化.mjs --install    # 真做 + 装 Electron（首次约 200 MB）
```

**它做什么**（`--dry` 会逐条列出来）：清 sessions/storages/日志/缓存 → 所有面板 `sessionId` → `__待填__`
→ 探测引擎并写 `工作台.json`（`fresh:true`）→ 修 `profiles\web\cordis.patch.yml` → 重生身份卡/场景画像/身份索引 → 跑体检。

**期望输出**：出现 `[1]`…`[6]` 六个阶段；`--install` 时会看到 `npm install` 的进度；末尾有体检汇总。
**此时体检是 `15 绿 + 2 待办`（会话库、面板绑定）——这是正常中间态，不是失败。**

### ③ 启动

```powershell
.\启动.bat
```

**期望**：约 3 秒后窗口出现，顶栏五个场景标签。
**判据（二选一即可）**：`$APP\外壳\data\startup.log` 里出现 `[exit] rc=0 … window-visible + engine ready`；
或 `$APP\外壳\server.log` **本次新增**两行 `[boot] window-visible ms=…` 和 `engine ready in …`。

> ⚠ 只认**本次启动之后新写**的日志（启动器会记 `offset`）。历史成功不算数。

### ④ 建 5 条会话（最容易漏，一定要做）

```powershell
node 外壳\scripts\建会话.mjs --title "命令"     --cwd "$((Get-Location).Path)"
node 外壳\scripts\建会话.mjs --title "B站"       --cwd "$((Get-Location).Path)"
node 外壳\scripts\建会话.mjs --title "自我复盘"  --cwd "$((Get-Location).Path)"
node 外壳\scripts\建会话.mjs --title "本地电脑"  --cwd "$((Get-Location).Path)"
node 外壳\scripts\建会话.mjs --title "网页AI"    --cwd "$((Get-Location).Path)"
node 工具\实例化.mjs --apply
```

**两条硬要求**：
- 标题必须和 §0 表里**一字不差**（`实例化.mjs` 是按标题配对会话的）；
- `--cwd` 必须是**新的工作台根**（就是 `$APP`）。省掉会落到临时目录 ⇒ 面板永远「未切到」、体检 A5 红。

**期望输出**：每条 `✓ 新会话：session-…` + `sessionId = session-…`；
`实例化` 末尾出现 `✓ 已写 工作台.json（全部面板已绑定 ⇒ fresh 已清除）`。

### ⑤ 验收

```powershell
node 工具\体检.mjs
node 工具\编码检查.mjs
node 外壳\scripts\check-gui.mjs
node 外壳\scripts\ui-check.mjs
node 外壳\scripts\sessions.mjs --check
```

期望片段见 §4 表格，**每一格都要对上**。

---

## §3 为什么必须走 ④（给 Agent 的解释，免得你自己发明流程）

- 侧边栏按 **workspace 分组**：`建会话.mjs` 必须带 `workspaceId`，只给 cwd 的会话会掉进「未分组」；
- **空会话不进侧边栏**：`建会话.mjs` 默认建完塞一条开场消息再打断（`--no-seed` 可关）；
- **面板绑的是 sessionId + 标题**：标题对不上 ⇒ 「未切到」；cwd 不是本机路径 ⇒ 体检 A5 红；
- 所以顺序永远是：先 `建会话`，再 `实例化 --apply`，最后 `sessions.mjs --check` 验证。

> **本机业务场景放哪（P3-1 起）**：模板场景 = `外壳/scenarios/*.json`（入库，§0 事实表只统计这 5 个）；
> **本机要加的业务场景放 `外壳/scenarios/_local/`**——该目录被 `.gitignore` 挡、**不入库**，
> `listScenarios()` 会在模板之后追加它们（同 id 时**实例优先**并告警），`场景校验 --stamp` 的 §0 事实表**不受影响**。
> 加实例场景的步骤与模板一模一样（建 json → 建会话 → `实例化 --apply`），只是文件放 `_local/`；
> 详见 `12-源码照搬/说明/使用说明.md` §七。

---

## §4 验收判据（期望输出片段）

> **本节全部判据已于 2026-11-07 实跑核实**（含 `ui-check`，其历史误报已修复，见 §5-10）。
> 表内仍会出现 ⚠，但含义已收窄为**"使用陷阱提示"**（例：直跑 `发布前检查` 报密钥红线属预期），
> 不再表示"判据当前不成立"。若某条判据**真的**当前不满足，会在此处显式写明 —— 现在没有。

| 命令 | 期望片段 | 不通过看 |
|---|---|---|
| `node 工具\体检.mjs` | `汇总：16 条断言 · 16 绿 · 0 红` | §5-6、§6 |
| `node 工具\体检.mjs --self-test` | `自检：40 通过 · 0 失败` | — |
| `node 工具\编码检查.mjs` | `✓ 没有会导致乱码或静默失效的编码问题。` | §5-4 |
| `node 外壳\scripts\check-gui.mjs` | `全部通过 ✓` | 判据是**不出现 ✗**：`warning` 数取决于是否有内置 `引擎\`（见 §8-1），不是必须为 0 |
| `node 外壳\scripts\ui-check.mjs` | `✓ UI 自检全部通过` | UI 模块语法 / 加载顺序 / DOM 挂载点 / 体量红线（新增文件 ≤800 行） |
| `node 外壳\scripts\sessions.mjs --check` | `场景↔会话对照检查通过 ✓ 共 5 个 AI 面板` | §3、§5-5 |
| `node 外壳\scripts\gateway-smoke.mjs` | `结果：VERIFIED（exit 0）`（**三态**：exit 3 = 工作台没跑 ⇒ 未验证，不是通过；exit 1 = 在线但断言不满足） | 鉴权/场景/任务/MCP/INJ-01 五面；已作为 `验收` 第 2 步的子检查（工作台没跑时自动标「跳过（未验证）」） |
| 界面 | 五个场景的 AI 面板标题行都显示 `✓ 已钉绑定` | §5-5 |
| 工具面板（顶栏） | `48 个工具` | 清单缺失见 §5-7 |

**提交前红线闸**（只扫 `git ls-files` 清单，不看磁盘实例文件）：

| 命令 | 期望片段 |
|---|---|
| `node 工具\验收.mjs` | `✓ 验收通过：6 步全绿，可以提交` |
| `node 工具\代码红线.mjs --check` | `✓ 代码红线通过：0 处红 · 0 处存量黄（未增长）` |
| `node 工具\场景校验.mjs --check` | `✓ 场景校验通过：模板 5 场景 · 实例 0 · 15 个面板 · 事实表一致` |
| `node 工具\结构校验.mjs --check` | `✓ 结构与链接全部通过`（根白名单 / 文档索引 / 归档横幅 / 链接可解析） |
| `node 工具\发布前检查.mjs`（日常/不打包） | `✓ 红线检查通过（0 命中）`。⚠ 直接跑它时若因 `.credentials.yaml` 报**密钥红线**，见 §5-11 —— 那不是模板泄漏；出包请走 `验收.mjs` 的第 4 步（template 模式 + 已跟踪清单） |

---

## §5 故障处置（现象 → 判据 → 修法）

1. **双击弹「需要装依赖」**
   判据：`$APP\外壳\node_modules` 不存在。
   修：`node 工具\初始化.mjs --install`。

2. **控制台一闪就没、窗口从不出现**
   判据：Electron 退出码 `-2147483645`（`0x80000003`），`data\startup.log` 里有 `[retry] … --no-sandbox`。
   启动器已内置自愈：重试一次 `--no-sandbox` 并写 `data\no-sandbox.flag`，下次直接兼容模式。**不用手工处理。**

3. **窗口出现但一片白**
   判据：`server.log` 有 `window-visible`、**没有** `engine ready`。
   修：设 `DSH_CMD=<dsh.cmd 的绝对路径>`，或在 `工作台.json` 里填 `engine.cliPath`，重启。

4. **`.bat` 报「不是内部或外部命令」/ 中文行被切碎**
   判据：`node 工具\编码检查.mjs` 报裸 LF。
   修：`git config core.autocrlf true` 后重新检出；确认 `.gitattributes` 里的 `*.bat text eol=crlf` 还在。

5. **面板一直「未切到」**
   判据：`sessions.mjs --check` 报「id 与标题不一致」或「cwd 不在本机」。
   修：按 §2-④ 重建会话 + `实例化 --apply`；标题和 cwd 都要对。

6. **体检不是 0 待办**
   判据：输出里带「待办」的条目。
   修：`fresh:true` 且面板没绑全 ⇒ 会话库/绑定待办（做 §2-④）；其余按条目里的路径修。

7. **工具面板显示「还没登记工具清单」**
   判据：`$APP\外壳\data\工具清单.json` 不在（被 `data/*` 忽略规则误删或漏拷）。
   修：从仓库取回该文件（`.gitignore` 里已放行）。

8. **同机起第二个实例起不来**
   判据：`startup.log` 里 `[skip] port 3083 already listening`，或第二个进程秒退。
   修：先关掉旧的；确实要并存，用**环境变量**换端口（见 §8-2）。

9. **GPU 进程反复崩溃 / 内嵌网页视频发涩**（环境问题，代码只能兜底）
   判据：`外壳\data\crash-log.jsonl` 里多条 `"type":"GPU","reason":"crashed","exitCode":34`。
   原因：本机显卡驱动/安全软件与 Chromium GPU 沙箱不兼容（与「沙箱初始化失败 0x80000003、
   只能走 `--no-sandbox` 兼容模式」同源）。应用侧已自动降级，建议：更新显卡驱动 /
   把工作台目录加入安全软件白名单 / 关掉第三方硬件加速工具。
   注：`--disable-gpu` 实测**不能**解决网页版 AI 的内存问题（那是预热策略与 `theme-sync.js` 的事，已修）。

10. **`ui-check` 报「引用了不存在的 id」**（✅ 已于 2026-11-07 修复；此处保留作排障参照）
    **历史问题**：`renderer/ui/ui-shell.js` 静态依赖 `#tbs-wrap` / `#tbs-more`，而这两个 id 由
    `topbar-status.js` **运行时创建**，静态扫描看不见 ⇒ `ui-check` 第 4 项「静态 id 引用」误报 exit 1。
    **修法（关键）**：改**源码**，让 `ui-shell.js` 不再依赖运行时 id（改为问宿主 `window.topbar.pending()` 等 API）；
    `ui-check.mjs` **一行未改** —— 这证明是"修了问题"，不是"放宽了检查"。
    **若未来再次出现同类报错**：按同一原则处理 —— ⛔ **改源码，不改断言**（§7 明令）。
    代码复核依据：`git status --short -- 12-源码照搬/外壳/scripts/ui-check.mjs` 应为**空**
    （该文件未修改），而 `ui-shell.js` 显示 `M`（已修改）。

11. **`发布前检查.mjs` 直跑报「密钥 ⇒ 不出包」**
    判据：命中项是 `引擎数据\.dsh\.credentials.yaml`（模型密钥，`.gitignore` 已挡、**未被跟踪**）。
    原因：直接跑时不带清单，它会扫磁盘上的**实例文件**；`.credentials.yaml` 是"两种模式都挡"的密钥项。
    修：日常/提交用 `node 工具\验收.mjs`（第 4 步只扫已跟踪清单，template 模式），或显式
    `node 工具\发布前检查.mjs --files-from <已跟踪清单>`。⛔ 不要为了让它绿去删 `.gitignore` 里的这条规则。

12. **AI 面板/新会话在空目录里干活（工作区路径失效）**
    现象：面板能开、也能聊，但 AI 读不到项目文件；`pwd` 是旧仓库目录（目录还在、里面是空的）。
    判据：`node 工具\体检.mjs` 报 **A16**（或 A5 只证明 cwd「存在」——空目录也算存在，别只信 A5）。
    根因：仓库搬家后，引擎 `引擎数据\.dsh\storages\workspace.json` 里登记的工作区仍指旧路径。
    ⛔ 不要手工改 workspace.json 兜底 —— 引擎运行期会用自己的内存态把文件覆盖回去（实测改完 ~1 分钟即被写回）。
    修：① 备份 `外壳\data\`；② `node 外壳\scripts\建会话.mjs --title "<场景名>" --cwd "<$APP 绝对路径>"` 重建 5 条
    （标题必须与 §0 事实表一字不差）→ `node 工具\实例化.mjs --apply` 重绑 → 重启工作台；
    ③ **清掉旧登记**（2026-11-07 实测可行且持久）：先 `workspace/archiveSession`（`stopActivity:true` 停掉在跑的回合）
    把旧工作区下的**未归档**会话全部归档，再 `workspace/delete` 删登记 —— 引擎只在 `initialized:false`（首次打开）时
    才按历史会话 cwd 跑 bootstrap 重建，之后不再复活；旧目录本身留不留都不影响登记表。
    若想保留旧组可读性，也可只 `workspace/rename` 成「旧路径·已迁移」（A16 仍会红：登记项必须有效，别用它换绿）。
    前提：目标目录必须先用 `workspace/create` RPC 登记过，否则 `建会话` 会把会话丢进「未分组」。

13. **各场景 AI 面板里对话列被压成一条竖排字 / 左侧一大片空白（引擎 0.2.2 起）**
    现象：场景 AI 面板里 DSH 对话框整条挤在右侧一条，文字一个字一行；面板左边全空（用户原话
    「各场景中，DSH对话窗口宽度没有自适应」）。
    判据：`外壳\server.log` 的 `[wv:inject] diag` 里 `kidsInfo` 的 `centerCol` 不是 `x=0, w=框架宽`，
    而是 `x≈宽-122, w≈122`；`wide` 只剩几十像素（实测 `1列 35/51px`）。
    根因：引擎 0.2.2 的 AppFrame 用 **grid-area** 定位三列（sidebarCol=1/1、centerCol=1/2、rightbarCol=1/3）；
    面板精简注入只把 `grid-template-columns` 压成**一条轨道**，centerCol 的 `grid-area:1/2` 没变 ⇒
    它落进「隐式第 2 列」（auto 宽），第 1 列被 `1fr` 撑满却没内容 ⇒ 左边全空、对话列只剩几十像素。
    ⛔ 这不是"没铺满"，别去动 `HARNESS_WIDE_COL/CARD`；那两条是给 0.1.x 的 clamp 用的。
    修（2026-11-07 已落）：`外壳\main.js` 与 `外壳\renderer\renderers.js` 的 `HARNESS_CHAT_CSS` 各加两条
    `> :has([data-chat-flow])` / `> [class*="centerCol"] { grid-column: 1 / -1; grid-row: 1 }`；
    `HARNESS_FIX_JS` 的 `if (center)` 段再内联 `grid-column/grid-row`（React 重渲染后的自维持）。
    只改 renderer 半边可 `node 外壳\scripts\刷新面板.mjs all` 热更（或点 ⟳ / 切一次场景重建面板）；
    改 main.js 半边要重启工作台。验证探针：`外壳\data\probe-chat-width\probe2.cjs`（隔离窗口跑同一份注入，
    1400/863/1800 三档量宽并截图）。

14. **窗口起来了但 `engine NOT ready` / 派单报「换不到 cookie（HTTP 401）」——孤儿引擎占着 3083**
    现象：`server.log` 里有 `window-visible`、**没有** `engine ready`；或界面能开但派单失败、`/v1/health` 的
    `engine.reachable=false`（换 token 时 401）。**2026-11-10 实测踩了两次。**
    判据：`Get-CimInstance Win32_Process` 里同时存在**两个** `… cli.js web --no-open --port 3083` 引擎，
    且 3083 上在听的是**启动更早**的那个 ⇒ `harness-endpoint.json` 里的 token 是本次主进程写的，
    与在听的旧引擎对不上，必然 401。
    根因：强杀 Electron（任务管理器 / `Stop-Process`）**不会**连带杀掉它 spawn 的引擎子进程；
    孤儿引擎继续占 3083，而启动器只查「3083 有没有在听」⇒ 要么直接判「已在运行」退出，要么起了个连不上引擎的新壳。
    修：**只杀真引擎**，再确认端口释放后重启。⚠ 匹配命令行的 PowerShell **会把自己也匹配进去**
    （DSH 的子进程 runner 的 CommandLine 携带整段脚本文本 ⇒ 曾把自己的 job 杀掉），必须排除：
    ```powershell
    Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
      Where-Object { $_.CommandLine -notlike '*dsh-subprocess-local*' -and $_.CommandLine -like '*cli.js*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Test-NetConnection 127.0.0.1 -Port 3083   # 期望 False
    ```
    然后 `.\启动.bat`。判据：`server.log` 本次新增 `engine ready in …` + `/v1/health` 的 `reachable=true`。

15. **启动器卡住 / 后台起不来（自提权弹 UAC）**
    现象：调用 `启动.bat` 只打印「正在请求管理员权限（本机 explorer 以管理员运行…）」，然后没有任何窗口；
    后台/计划任务里那一步永远等不到退出。
    根因：启动器检测到当前不是管理员就 `Start-Process -Verb RunAs` 重新拉起自己 —— 交互式桌面会弹 UAC；
    无人在场（服务 / 计划任务 / 远程非交互）时没人点。
    修：`cmd /c "set WB_NO_ELEVATE=1&& .\启动.bat"`（跳过提权）。界面照常起；只有「DSH 让 shell 打开文件」
    这类动作可能被 UIPI 拦（启动器顶部注释有原委），验证派单/网关不需要提权。

---

## §6 脚本做不了、必须人做的三件事

1. **填模型凭据**：`.credentials.yaml` 不跟仓库。启动后点顶栏「🧠 模型与提供方」填写，否则 AI 面板不回话。
2. **网页版 AI 各站登录**：`webai` 的 5 个站点（DeepSeek / 豆包 / 千问 / 智谱 / Kimi）在各自 webview 里登录一次。
3. **本地电脑面板的数据**：`node 外壳\scripts\pc-scan.mjs`（约 40–60 秒）跑一次，排行/体检/台账才有数。

---

## §6.5 DSH 内核升级流程（升引擎后必做）

适用：把 DeepSeek Harness 桌面版/CLI 换到新版本之后。**顺序不能乱**，"跳过"不等于"通过"。

```powershell
cd 12-源码照搬

# 1. 记录升级前快照（产物落 外壳\data\，属运行时产物，不入库）
node 外壳\scripts\engine-before.mjs

# 2. 升级引擎（DSH 桌面版安装器或 dsh 本身），确认版本
dsh --version

# 3. 核对之后的锚点与版本
node 外壳\scripts\engine-after.mjs

# 4. 锚点与版本都过 → 同步两处版本声明（见下）
# 5. 确认版本卡与告警样式在位
node 外壳\scripts\check-gui.mjs

# 6. 重启工作台，看品牌区小点**不**转琥珀色
.\启动.bat
```

**两处必须同步的版本声明**（`engine-after` 会读它们做比对）：

| 位置 | 含义 |
|---|---|
| `外壳\renderer\renderers.js` 的 `ADAPTED_ENGINE` | 壳声明"我适配过的引擎版本"。引擎与它不一致 ⇒ 品牌区小点转琥珀色 + 控制台告警 |
| `外壳\package.json` 的 `version` | **外壳自身版本**，与引擎版本是两件事，不要机械跟随 |

**版本显示口径（2026-11-07 起）**：品牌区版本卡与 UI 2.0 左栏**都要把内核版本与外壳版本分开写清**，不许只显示一个数：

- 左栏两行：`内核 <engine>` / `GUI <gui> · UI 2.0`；数据来自 `app:version`（`main/inventory.js`）。
- 无内置 `引擎\` 时，内核版本由 `main/engine-guard.js` 的 `detectEngineVersion()` **只读**探测外部 CLI 安装目录
  （asar 内核包 → npm 全局布局 → `runtime.json` 的 `desktopVersion`）；读不到就显示"未知"，**不许拿外壳版本顶替**。
- 老主进程没有 `engineProbe` 字段 ⇒ 渲染层保持旧显示。改 `main.js` / `main/*` 必须**重启工作台**才生效（`ui/*` 可 ⟳ 热更新）。

**判据（关键）**：

- `engine-after.mjs` 三态：**`exit 0` = VERIFIED / `exit 3` = SKIPPED（未验证）/ `exit 1` = FAILED**。
  源码直跑必是 `exit 3`，此时**不得声称"锚点全绿"**，也不得据此改 `ADAPTED_ENGINE` 的注释。
- 要真正拿到锚点证据，必须在**带内置 `引擎\` 的克隆**里跑 `engine-after.mjs`，并把 after 存档留在 `data\`。
- 版本卡自检：`check-gui.mjs` 应输出 `✓ 壳里记录了"已验证的引擎版本"：<版本>` 与
  `✓ 版本不一致的提示样式在位（brand-dot-warn）`；这两行只证明**样式在位**，不证明**锚点验证过**。

**锚点表本身的现状（2026-11-07 收紧，见 `engine-after.mjs` 的 `ANCHORS` 常量）**：

| 项 | 现状 |
|---|---|
| 条数 | **10 条**（原 8 条 ⇒ 因拆分与新增而扩张） |
| 判定 | **AND**（一条锚点的所有 needle **全部**出现才算命中）。原先是 OR —— 任一命中就算过，太松 |
| 已删除锚点 | `workspace.json` —— 在 0.2.2-rc.1 里 **0 处命中**（那是壳自己的读法，不是上游契约） |
| `data-side` 取值 | 只有 **`left` / `right`**，**没有** `sidebar` / `details`。⚠ 壳侧 `[data-side="sidebar"]` 选择器在这版引擎上**选不中任何元素** |
| 单列锚点 | `data-width-handle`（壳的藏列逻辑直接依赖它） |
| 三态实测 | 三支都用假引擎验证过：VERIFIED / SKIPPED / FAILED |

> 完整锚点清单、逐条证据与三态实测记录见 [_本机产物/优化报告/DSH内核兼容.md](_本机产物/优化报告/DSH内核兼容.md)（本机产物，不入库）。

---

## §7 禁止事项

- ⛔ 不要把 `工作台.json`、`引擎数据\.dsh\.credentials.yaml`、`引擎数据\.dsh\sessions\`、`storages\` 提交或拷给别人。
- ⛔ 不要为了让体检变绿去改断言；体检只报告，按它给的路径修。`ui-check` 同理（见 §5-10）。
- ⛔ 不要 `git push --force`。
- ⛔ 不要拷贝 `外壳\node_modules`（用 `--install` 重装）。
- ⛔ **不要把「机写区」文件加回 git**（2026-11-08 ADR-10「人写区 / 机写区分离」）：
  `_共享记忆\_跨场景通知.md`、`_任务台账.json(l)`、`待确认.jsonl`、`外壳\data\*` 运行产物（含 `scene-tab-order.json`、`gateway-token.json`、`harness-endpoint.json`、`gateway-access.log`）**只由运行时写**，已全部被 `.gitignore` 挡。
  判据：`git status --short` 里出现它们 ⇒ ignore 规则被破坏，先补 `12-源码照搬\.gitignore` 的机写区段再 `git rm --cached`（磁盘文件保留）。**一份文件只允许一类写者**——人写区（记忆 md/身份卡/项目记忆）才进 git。
- ⛔ 不要把 `--no-sandbox` 当成常规方案（它关掉了 Chromium 进程隔离；只在沙箱确实起不来时用，日志里会有记录）。
- ⛔ 不要改 §0 的场景事实表标记区块（生成物，`--stamp` 重写）。
- ⛔ **不要合并 `origin/WORK-MC` / `local-ui2-wip` / `backup-pre-upstream`**（都是反向回退，见 §8.5）。
- ⛔ **不要绕过《文件归档制度》**：文档不进 `文档/`、过期文档不归档、本机产物混进 `文档/`，都会被
  `结构校验.mjs --check` 判红（§10.2）；新增根级条目必须同时改制度 §2 与校验白名单。

---

## §8 已知口径说明

1. **`check-gui` 的 warning 数**：判据是**不出现 ✗**，warning 数**不是判据**。
   源码直跑（没有内置 `引擎\`）时实测 **`全部通过 ✓（warning 1~2）`**，典型两条：
   - `! 引擎版本：未知（dsh.cmd 的 --version 跑不动）⇒ 按未验证处理`
   - `! engine-after: 跳过（没有内置 引擎\ 目录）⇒ 产物配套 / 上游锚点 / 插件接线一项都没核`

   这是 kernel-engineer 做的**诚实降级**——宁可报"没验证"，也不假装验证过，**不是故障**。
   带内置引擎且在能 spawn 子进程的环境下，这两条会消失。
   **不要**为了凑 `warning 0` 去改检查项。
   **`engine-after.mjs` 三态契约**（看退出码，不要只看有没有输出）：
   `exit 0` = **VERIFIED**（锚点全在 + 版本一致）/ `exit 3` = **SKIPPED**（**未验证**）/ `exit 1` = **FAILED**。
   ⚠ 最常见的误读：把 `exit 3` 当成"通过"。详见 [_本机产物/优化报告/DSH内核兼容.md](_本机产物/优化报告/DSH内核兼容.md)（本机产物，不入库）。
2. **`工作台.example.json` 里有 `dshPort` / `sitePort`**：`main.js` 现在优先从 `工作台.json` 中读取 `dshPort`
   （无配置时回落至环境变量 `DSH_PORT` / 默认 3083），支持单机灵活修改配置文件多实例并存；`sitePort` 默认 31238。
3. **想同机并存两个工作台**：引擎端口在 `工作台.json` 设 `dshPort: 3084` 或设环境变量 `DSH_PORT=3084`；
   31238 只能被一个壳占住，第二个壳取主界面地址会走保命代理。
4. **源码直跑（仓库里没有 `引擎\`）**：`check-gui` 全部通过（warning 1~2，见 §8-1）、
   `engine-after.mjs` 自报「**不适用（没有内置引擎目录）**」并以 **`exit 3`（SKIPPED · 未验证）** 退出
   —— **不再是 exit 0**。⚠ 这是"没法核对"，不是"核对通过"——升级流程见 §6.5。
   若你的脚本里有 `if ($LASTEXITCODE -ne 0) { 报警 }` 这类判断，`exit 3` 会被当成失败；
   应当显式区分三态（0 / 3 / 1），**不要把 3 当 0，也不要当 1**。

### §8.5 分支治理：哪些分支不该合并（2026-11-07 实测结论）

> 目的：**避免下次重复劳动**。这几条分支的 diff 看着很大（合计 1.4 万行），但方向都是 **`main` 领先、分支落后**；
> 把它们当"待落地的功能清单"，得到的是**反向回退**。完整证据见 [_本机产物/分支分析/总报告-哪些差异适合落到本地.md](_本机产物/分支分析/总报告-哪些差异适合落到本地.md)（本机产物，不入库）。

| 分支 | 差异规模 | 该落地 | 结论 |
|---|---|---|---|
| `origin/WORK-MC` | 78 文件 / +6739 | **0** | ⛔ 不合并。29 个已进 main、30 个被 main 超越、15 个是 work-dev 实例数据、4 个遗留待裁决 |
| `local-ui2-wip` | 21 文件 / +2922 | **0** | ⛔ 不取用。UI 2.0 六模块已被 main 全量承载并超越；且早于 `d7e531f`，取用会把**已故意移除**的集市/赞助入口捡回来 |
| `backup-pre-upstream` | 31 文件 / +4578 | **0** | ⛔ 已完全被 main 超越，仅作备份 |
| `perf/…optimization`、`upstream/main`、`backup-main-before-portable` | 0 | **0** | 无独有提交或早已是祖先 |

**三条高危（误采必出事）**：

1. `WORK-MC` 的 `.gitignore` 是**回退**（删掉了 `preset-*.optimized.patch.yml` 与 `.dsh-switchman/` 规则）；
2. `WORK-MC` 的 `scenarios` 是**互斥替换**（把 `webai` 换成 `work-dev`）——任何 scenarios / 身份索引的 WMC 版本都会打死网页AI 场景；
3. 所有分支的旧文档版本都会把 main 已脱敏的盘符 / 用户名**写回去**。

**通用判据（下次判断任何分支都适用）**：

- `git diff 分支 main -- <path>` **非空 ≠ 有残留** —— 先看 `+` 属于哪一侧（`git diff A B` 的 `+` 属于 B）；
- 判据是 **"分支独有、main 缺失的机制能力"是否 > 0**，不是"文件有没有差异"；
- 实例数据（真实 sessionId / 本机路径 / 私有记忆）**永远不算可落地内容**；
- 本机未提交改动才是真要动手的地方（`renderers.js` 的 `ADAPTED_ENGINE`、实例态 `profiles/web/package.json` 走 skip-worktree、
  `server.log.prev` 补 ignore），详见 C 组报告。

---

## §9 文档地图（谁写给谁看、什么时候读）

> 入口只有两个：**人**从 [README.md](README.md) 进，**AI Agent** 从本文件进。其余文档按"何时读"取用，不必通读。

| 文档 | 写给谁 | 什么时候读 |
|---|---|---|
| [README.md](README.md) | 人（首次接触） | 第一站：这是什么、5 分钟上手、板块索引 |
| **本文 AGENTS.md** | AI Agent | 被要求"把这套装起来"时，按 §2 执行 |
| [文档/README.md](文档/README.md) | 所有人 | 跨板块文档总索引（现行 / 应用文档 / 归档 / 本机产物） |
| [文档/文件归档制度.md](文档/文件归档制度.md) | 维护者 | 新增/搬迁文档、归档之前 —— 分区、根白名单、保留期、SOP |
| [总纲.md](文档/总纲.md) | 人（想知道为什么这么设计） | 看六层拓扑 / 记忆不丢 / 派单规矩 |
| [新手必读.md](文档/新手必读.md) | 人（动手前） | 知道自己要改哪几处、哪几步最容易劝退 |
| [仓库分工与上游变更规矩.md](文档/仓库分工与上游变更规矩.md) | 维护者 | 同步上游、动引用之前 |
| [12-源码照搬/说明/判据与工具.md](12-源码照搬/说明/判据与工具.md) | 维护者 | "这条规矩由谁执行、怎么证明" |
| [12-源码照搬/外壳/core/README.md](12-源码照搬/外壳/core/README.md) | 接外部 Agent / 改能力层的人 | 能力表（10 项）、中间件顺序、face 接线、任务信封口径 |
| [12-源码照搬/外壳/engine-adapter/README.md](12-源码照搬/外壳/engine-adapter/README.md) | 改注入脚本 / 应对引擎升级的人 | 动 `contract.js` 之前：差异登记、自检三态、等价性口径 |
| [12-源码照搬/说明/记忆约定.md](12-源码照搬/说明/记忆约定.md) | 场景 AI + 维护者 | 写 §〇 交接、换会话之前 |
| [12-源码照搬/说明/使用说明.md](12-源码照搬/说明/使用说明.md) | 人（日常使用） | 快捷键、常用命令、FAQ |
| [12-源码照搬/说明/部署.md](12-源码照搬/说明/部署.md) | 换机器部署的人 | 带走什么、不带走什么、路径为什么不会错 |
| [12-源码照搬/说明/架构分析与UI重构-2026-11-03.md](12-源码照搬/说明/架构分析与UI重构-2026-11-03.md) | 改渲染层的人 | 动 `renderer/ui/` 之前（既定设计意图，勿推翻） |
| [12-源码照搬/说明/内存诊断与修复-2026-11-04.md](12-源码照搬/说明/内存诊断与修复-2026-11-04.md) | 排查内存/白屏的人 | 见 §5-9 同类现象时 |
| [更新清单.md](文档/更新清单.md) | 维护者 | 每次同步后追加一行（含"故意不公开什么"） |
| [工具与技能目录.md](文档/工具与技能目录.md) | 人（找现成的） | 想知道"有没有现成工具"时 |
| [分支分析/](_本机产物/分支分析/) | 维护者 | 想合并任何分支之前 —— **先读总报告的"0 落地"结论**。⚠ 本机产物（`.gitignore` 已挡）：含本机绝对路径，**不入库**，链接只在本机可点 |
| [优化报告/](_本机产物/优化报告/) | 维护者 | 每轮改造的改动清单 + 未做项 + 验证输出。⚠ 同上：本机产物、含本机路径，**不入库**；要公开需先脱敏再放行 |
| [差异审计-本地vs云端-2026-11-01.md](文档/归档/差异审计-本地vs云端-2026-11-01.md) | ⚠ 历史 | **已过期**（已归档），仅在追溯 11-01 那代问题时读；现行结论看 `_本机产物/分支分析/` |
| [方法论分析与优化方案-2026-11-01.md](文档/归档/方法论分析与优化方案-2026-11-01.md) | ⚠ 历史 | **已过期**（已归档），O1~O7 多数已落地，读它只为了解当时的诊断思路 |

**已经发现的重复 / 矛盾，以本表右侧为准**：

| 现象 | 现行口径 |
|---|---|
| 场景记忆落盘位置两套叫法（`引擎\场景记忆\` vs `引擎数据\.dsh\场景记忆\`） | 唯一口径 = `引擎数据\.dsh\场景记忆\`（体检 A9 守这个东西） |
| 面板 `_场景身份索引.md` 手抄 vs 生成 | 生成物，`node 工具\身份索引.mjs --stamp` 写，手改即校验失败 |
| `check-gui` 的 warning 数（§4 与 §8 曾打架） | 判据是"不出现 ✗"，warning 数随有无内置引擎变化（§8-1） |

---

## §10 提交前红线闸

### 10.1 启用方式（有正确姿势，别耍小聪明）

```powershell
# ✅ 推荐：保留仓库现有的 .git/hooks/reference-transaction 上游闸，只补 pre-commit
Copy-Item .githooks\pre-commit .git\hooks\pre-commit
```

⛔ **绝不能 `git config core.hooksPath .githooks`** —— 一旦设置，Git **只读** `core.hooksPath` 指向的目录，
`.git/hooks/reference-transaction` 里的**上游闸立即失效**：任何把上游提交引入 `main` 的引用更新
（ff 合并 / 合并提交 / reset 到上游 / cherry-pick）将**不再被拦下**。而 `.githooks/` 里**只有** `pre-commit`，
没有上游闸，等于把 `仓库分工与上游变更规矩.md` 第三节那张表整条废掉。
如果确实非用 `core.hooksPath` 不可，**必须同时**把上游闸搬进 `.githooks/`（并重新验证它会拦）——不推荐，容易忘。

判据（确认闸还在）：

```powershell
git config --get core.hooksPath        # 期望：无输出（= 未设置）
Get-ChildItem .git\hooks -Name | Where-Object { $_ -notlike '*.sample' }
# 期望至少看到：reference-transaction、post-merge（+ 你抄进去的 pre-commit）
```

### 10.2 闸里跑什么

`node 12-源码照搬\工具\验收.mjs` 串行六步：编码检查 → 体检自检 → 身份索引 → 发布前检查（template ·
仅 `git ls-files` 清单 + 暂存新增）→ 场景校验 → 代码红线。第 4 步不看磁盘上的实例文件，
只看「会被提交的文件」，所以 `工作台.json`、真实会话 id、本机绝对路径蒙混不过去。

**结构闸（pre-commit 先跑它）**：`node 12-源码照搬\工具\结构校验.mjs --check` —— 根目录白名单、
`文档/` 索引完整性、归档文档横幅、全仓已跟踪 `.md` 的相对链接可解析、已跟踪清单不含运行产物。
判据：`✓ 结构与链接全部通过`。规则出处：[文档/文件归档制度.md](文档/文件归档制度.md)。

场景事实表（本文档 §0 的生成块）由 `node 12-源码照搬\工具\场景校验.mjs --stamp` 生成，
不要手改标记区块内的行；`--check` 发现与场景 json 不一致会直接失败。

体量红线：`node 12-源码照搬\工具\代码红线.mjs --check`（新文件 ≤800 行；存量
超大文件只许变短；源码里禁止新增盘符硬编码、真实会话 id 与 eval）。

> 模板/实例真值口径：`scenarios\*.json` 只写 `sessionId: "__待填__"`，真实会话 id
> 只存 `工作台.json`；`main.js` 运行时叠加。提交前闸只扫已跟踪文件，所以实例文件
> 不参与；但一旦真实 id / 本机路径被写进模板文件，闸会红。

**附带发现（2026-11-07）**：[12-源码照搬/说明/判据与工具.md](12-源码照搬/说明/判据与工具.md) 第 96-100 行曾给出 `git config core.hooksPath .githooks`（现已在 §六/文件头改成 `Copy-Item` 正确姿势，**以本节为准**）；
该文件另有两处 outdated（"12 套坏样本"、体检项数"14 项"），实际分别是 40 项自检与 16 条断言，已在文件头标注。

---

## §11 机器可读摘要

```yaml
repo: https://github.com/qingxuan233/workbench-qingxuan.git
branch: main
app_root: 12-源码照搬
entry: 12-源码照搬/启动.bat
scenes: {command: 命令, bilibili: B站, self-review: 自我复盘, pc-cleanup: 本地电脑, webai: 网页AI}   # 模板场景；本机业务场景放 外壳/scenarios/_local/（不入库）
ports: {engine: 3083, site: 31238, webai_bridge: 31239}
env_overrides: {engine_port: DSH_PORT, webai_port: WEB_AI_PORT, engine_cli: DSH_CMD}
steps:
  - node 工具/初始化.mjs --dry
  - node 工具/初始化.mjs --install
  - 启动.bat
  - 建会话 5 条（--title 与上文一字不差，--cwd=app_root）
  - node 工具/实例化.mjs --apply
  - node 工具/体检.mjs
gate_ok:
  体检: "16 条断言 · 16 绿 · 0 红"
  体检自检: "40 通过 · 0 失败"
  编码检查: "没有会导致乱码或静默失效的编码问题"
  check_gui: "全部通过（判据是不出现 ✗；源码直跑常见 warning 1~2，诚实降级非故障）"
  ui_check: "UI 自检全部通过"
  sessions_check: "5 个 AI 面板"
  acceptance: "验收通过：6 步全绿，可以提交"
  code_redline: "0 处红 · 0 处存量黄（未增长）"
  structure: "结构与链接全部通过（根白名单 / 文档索引 / 归档横幅 / 链接可解析）"
engine_upgrade:
  - node 外壳/scripts/engine-before.mjs
  - dsh --version                     # 确认新版本
  - node 外壳/scripts/engine-after.mjs  # exit 0=VERIFIED / 3=SKIPPED(未验证) / 1=FAILED
  - 同步 renderers.js 的 ADAPTED_ENGINE（package.json 的 version 是外壳自身版本）
  - node 外壳/scripts/check-gui.mjs
human_required:
  - 顶栏「模型与提供方」填 API key
  - 网页版 AI 五站各登录一次
  - node 外壳/scripts/pc-scan.mjs 跑一次
never_merge:
  - origin/WORK-MC
  - local-ui2-wip
  - backup-pre-upstream
forbidden:
  - git config core.hooksPath .githooks   # 会关掉 .git/hooks/reference-transaction 上游闸
```
