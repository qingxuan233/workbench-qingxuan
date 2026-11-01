# AGENTS.md — 给 AI Agent 的工作台部署手册

> 本文件是**机器可执行版**：只有命令、判据和失败分支，背景解释在 [12-源码照搬/部署.md](12-源码照搬/部署.md)。
> 你（Agent）被要求"在某台新机器上把这个工作台跑起来"时，按 §2 顺序执行；
> 每条命令都给了**期望输出**，对不上就去 §5 查；§6 是脚本做不了、必须人做的三件事。

---

## §0 事实表（先读，别猜）

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/qingxuan233/workbench-qingxuan.git`，分支 `main` |
| 应用根 | `<仓库>/12-源码照搬`（下称 `$APP`） |
| 启动入口 | `$APP\启动.bat`（外层：`<仓库>\启动工作台.bat`） |
| 四个场景（标题必须一字不差） | `命令`、`B站`、`自我复盘`、`本地电脑` |
| 端口 | 引擎 `3083`（环境变量 `DSH_PORT`）、站点 `31238`（写死）、网页版 AI 桥 `31239`（`WEB_AI_PORT`） |
| 实例清单 | `$APP\工作台.json` —— **不入库**，由 `初始化.mjs` 生成 |
| 数据根 | `$APP\引擎数据\.dsh`（会话 / 工作区 / 场景记忆） |
| 启动日志 | `$APP\外壳\data\startup.log`；外壳日志 `$APP\外壳\server.log` |
| 运行时 | Windows 10/11；Node.js ≥ 18（建议 20/22）；DSH 引擎可选但 AI 面板需要 |

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
5. `C:\Program Files\DeepSeek Harness\…`、`D:\Programs\DeepSeek Harness\…`、`D:\DeepSeek Harness\…`

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

**期望**：约 3 秒后窗口出现，顶栏四个场景标签。
**判据（二选一即可）**：`$APP\外壳\data\startup.log` 里出现 `[exit] rc=0 … window-visible + engine ready`；
或 `$APP\外壳\server.log` **本次新增**两行 `[boot] window-visible ms=…` 和 `engine ready in …`。

> ⚠ 只认**本次启动之后新写**的日志（启动器会记 `offset`）。历史成功不算数。

### ④ 建 4 条会话（最容易漏，一定要做）

```powershell
node 外壳\scripts\建会话.mjs --title "命令"     --cwd "$((Get-Location).Path)"
node 外壳\scripts\建会话.mjs --title "B站"       --cwd "$((Get-Location).Path)"
node 外壳\scripts\建会话.mjs --title "自我复盘"  --cwd "$((Get-Location).Path)"
node 外壳\scripts\建会话.mjs --title "本地电脑"  --cwd "$((Get-Location).Path)"
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
node 外壳\scripts\sessions.mjs --check
```

期望片段见 §4 表格，**四组都要对上**。

---

## §3 为什么必须走 ④（给 Agent 的解释，免得你自己发明流程）

- 侧边栏按 **workspace 分组**：`建会话.mjs` 必须带 `workspaceId`，只给 cwd 的会话会掉进「未分组」；
- **空会话不进侧边栏**：`建会话.mjs` 默认建完塞一条开场消息再打断（`--no-seed` 可关）；
- **面板绑的是 sessionId + 标题**：标题对不上 ⇒ 「未切到」；cwd 不是本机路径 ⇒ 体检 A5 红；
- 所以顺序永远是：先 `建会话`，再 `实例化 --apply`，最后 `sessions.mjs --check` 验证。

---

## §4 验收判据（期望输出片段）

| 命令 | 期望片段 | 不通过看 |
|---|---|---|
| `node 工具\体检.mjs` | `汇总：15 条断言 · 15 绿 · 0 红` | §5-6、§6 |
| `node 工具\体检.mjs --self-test` | `自检：35 通过 · 0 失败` | — |
| `node 工具\编码检查.mjs` | `✓ 没有会导致乱码或静默失效的编码问题。` | §5-4 |
| `node 外壳\scripts\check-gui.mjs` | `全部通过 ✓（warning N）` | warning 属正常（缺内置引擎） |
| `node 外壳\scripts\sessions.mjs --check` | `场景↔会话对照检查通过 ✓ 共 4 个 AI 面板` | §3、§5-5 |
| 界面 | 四个场景的 AI 面板标题行都显示 `✓ 已钉绑定` | §5-5 |
| 工具面板（顶栏） | `43 个工具` | 清单缺失见 §5-7 |

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
   修：先关掉旧的；确实要并存，用**环境变量**换端口（见 §8）。

---

## §6 脚本做不了、必须人做的三件事

1. **填模型凭据**：`.credentials.yaml` 不跟仓库。启动后点顶栏「🧠 模型与提供方」填写，否则 AI 面板不回话。
2. **网页版 AI 各站登录**：`webai` 的 5 个站点（DeepSeek / 豆包 / 千问 / 智谱 / Kimi）在各自 webview 里登录一次。
3. **本地电脑面板的数据**：`node 外壳\scripts\pc-scan.mjs`（约 40–60 秒）跑一次，排行/体检/台账才有数。

---

## §7 禁止事项

- ⛔ 不要把 `工作台.json`、`引擎数据\.dsh\.credentials.yaml`、`引擎数据\.dsh\sessions\`、`storages\` 提交或拷给别人。
- ⛔ 不要为了让体检变绿去改断言；体检只报告，按它给的路径修。
- ⛔ 不要 `git push --force`。
- ⛔ 不要拷贝 `外壳\node_modules`（用 `--install` 重装）。
- ⛔ 不要把 `--no-sandbox` 当成常规方案（它关掉了 Chromium 进程隔离；只在沙箱确实起不来时用，日志里会有记录）。

---

## §8 已知口径差异（别被配置文件误导）

| 现象 | 实际情况 |
|---|---|
| `工作台.example.json` 里有 `dshPort` / `sitePort` | `main.js` **只读环境变量** `DSH_PORT`（默认 3083）；`sitePort` 写死 31238。改 `工作台.json` 的 `dshPort` **目前不生效** |
| 想同机并存两个工作台 | 引擎端口用 `DSH_PORT=3084` 之类；但 31238 只能被一个壳占住，第二个壳取主界面地址会走别的路子 |
| 源码直跑（仓库里没有 `引擎\`） | `check-gui` 的 4 条 warning 属正常；`engine-after.mjs` 会自报「不适用」 |

---

## §9 机器可读摘要

```yaml
repo: https://github.com/qingxuan233/workbench-qingxuan.git
branch: main
app_root: 12-源码照搬
entry: 12-源码照搬/启动.bat
scenes: {command: 命令, bilibili: B站, self-review: 自我复盘, pc-cleanup: 本地电脑}
ports: {engine: 3083, site: 31238, webai_bridge: 31239}
env_overrides: {engine_port: DSH_PORT, webai_port: WEB_AI_PORT, engine_cli: DSH_CMD}
steps:
  - node 工具/初始化.mjs --dry
  - node 工具/初始化.mjs --install
  - 启动.bat
  - 建会话 4 条（--title 与上文一字不差，--cwd=app_root）
  - node 工具/实例化.mjs --apply
  - node 工具/体检.mjs
gate_ok:
  体检: "15 条断言 · 15 绿 · 0 红"
  体检自检: "35 通过 · 0 失败"
  编码检查: "没有会导致乱码或静默失效的编码问题"
  check_gui: "全部通过"
  sessions_check: "4 个 AI 面板"
human_required:
  - 顶栏「模型与提供方」填 API key
  - 网页版 AI 五站各登录一次
  - node 外壳/scripts/pc-scan.mjs 跑一次
```
