# 外壳/core —— 能力层（P1）

> 目的：把"外部 Agent / CLI / REST / MCP 想做的事"收成**一套能力 + 一条中间件管线**，
> 四个协议面（MCP stdio、Streamable HTTP、REST `/v1`、CLI）只做协议翻译，不做业务。
> 定稿契约见 `_本机产物/优化报告/改造执行/P1-接口契约.md`（本机产物）；本文件是仓库内口径。

## 分层

```
face 层（协议组）        workbench-mcp.mjs / mcp-http.mjs / agent-gateway.js / 工具/派单.mjs
        │  core.call(name, args, ctx)
        ▼
utils  core/index.mjs        能力注册 + ctx 工厂 + 别名解析
        core/registry.mjs    描述符/schema 即真源（12 个能力）
        core/middleware.mjs  authz → INJ-01 → rateLimit → executor → CMP-01 → audit（顺序固定）
        core/services/*      领域服务（tasks/memory/review/webai/pc）
        core/adapters/*      engine（token/端点/RPC）· store（JSONL 台账门面）
        core/lib/*           只读文本检索（memory/review 共用）
```

## 能力表（12 项；`list()` 实测名：scene.status | task.dispatch | task.get | task.list | task.cancel | task.claim | task.complete | webai.council | pc.inspect | bilibili.extract | memory.search | review.search）

| name | 入参 | 出参（要点） | 副作用 | timeout |
|---|---|---|---|---|
| `scene.status` | `{}` | `{agents:[{id,title,bound,sessionHash}]}`（**不含真实 sessionId**） | 无 | 5s |
| `task.dispatch` | `{to,title,content,idempotencyKey?,timeoutMs?,awaitWake?,priority?,deadlineMs?,mandate?,evidenceExpected?}` | `{taskId,status,replayed,scene,priority,deadlineAt,engineRoute,engineDiag}` | 唤醒会话 | 25s |
| `task.get` | `{taskId}` | `{task,priority,timeoutMs,mandate,evidenceExpected,deadlineAt,evidenceMeta?}` | 无 | 5s |
| `task.list` | `{limit?,status?}` | `{count,limit,status,tasks:[]}` | 无 | 5s |
| `task.cancel` | `{taskId}` | `{ok,taskId,status:'cancelled',engine}` | 引擎 `session/cancel` | 25s |
| `task.claim` | `{taskId,agent?}` | `{ok,taskId,status:'claimed',claimedBy}` | 写台账（claimed） | 10s |
| `task.complete` | `{taskId,evidence,exitCode?,artifacts?:[{path,sha256?}]}` | `{ok,taskId,status:'completed',late,evidenceMeta}` | 写台账（completed + 证据） | 15s |
| `bilibili.extract` | `{quick?}` | `{status:'ok'|'not-a-video'|'unrecognized-bv'|'never-synced',bv,url,title,syncedAt,isVideo}` | 只读产物 | 10s |
| `webai.council` | `{question,sites?,timeoutMs?}` | `{ok,question,sites,results:{site:{ok,text,err}},okCount,failedCount}` | 出站网络 | 190s |
| `pc.inspect` | `{quick?}` | `{status:'cached'|'never-scanned',source,scannedAt,summary,data?}` | 读本机 | 15s |
| `memory.search` | `{query,limit?}` | `{query,count,scanned,hits:[{file,matches}],root}` | 只读人写区 | 15s |
| `review.search` | `{query,limit?}` | 同上（根= `自我复盘/`） | 只读 | 15s |

> `review.search` 是**第 9 个能力**（P1 Lead 批准）：旧 MCP 工具 `workbench__review_search`
> 在契约能力表里没有目标名，用它当别名目标，避免 `services/review.mjs` 成为死模块。
> `bilibili.extract` 是**第 11 个能力**（2026-11-10，报告 §2.1 点名的最后一个场景工具面）：
> 只读渲染层写的 `引擎数据/.dsh/场景记忆/B站/当前视频.json`（`embed-utils.js` 的 startBiliTrack 每 1.5s 同步），
> **不联网、不点网页**；没有产物就如实 `never-synced`，与 `pc.inspect` 同一套"不造假"口径。

**入参校验（2026-11-10 起）**：`middleware.validateArgs()` 在 executor 入口做**浅层** JSON Schema 校验
（入参必须是对象 / `required` 必须给值 / 声明了类型的字段必须是那个类型 / `enum` 不得越界），
失败统一 `E_VALIDATE`（HTTP 400、JSON-RPC `isError`）。形态上**不新增管线步骤**（`PIPELINE` 顺序不变）。
⛔ face 层不得先做 `String(...)` 之类的"洗参数"—— 2026-11-10 实测：`agent-gateway` 曾把 `text:123`
洗成 `"123"`，使严格校验形同虚设（已修，改为原样转发）。

**销账证据（`task.complete`，2026-11-10）**：`evidence` 必填（空话不收）；`artifacts` 只接受**应用根内**
的相对路径（`safeArtifactPath` 拒绝绝对路径/盘符/`..` 穿越），服务端自己读文件算 sha256，
与传入值不符 ⇒ `E_VALIDATE`。这是"入账成功 ≠ 真做完"的最后一道机械判据，也给外部 Agent 一条
**领了能交差**的闭环（CLI 的 `--complete --evidence-file` 与它同一套语义）。

**超时不再等人工（2026-11-10）**：`task.list` 的读路径会先做一次 `sweep()`（幂等），
把"未结束 + 有截止 + 已过点"的任务转 `expired`，返回里带 `expiredNow`；`工具/派单.mjs --list` 同样读前顺扫。
⛔ 它仍是"有人读才转"，**不是定时器**——真要无人值守，配一个计划任务跑 `派单.mjs --sweep`。

**两点必须知道的口径（别照契约名去猜）：**

- **`pc.inspect` 是双源回退**：先读 `外壳/data/pc-scan-latest.json`（契约名，当前**没有生成器**）→
  不存在则回退 `外壳/data/pc-cleanup-scan.json`（`外壳/scripts/pc-scan.mjs` 的**实际产物**）→
  两者都没有返回 `status:"never-scanned"` + 提示（**不返回演示/占位数字**）。
  出参里的 `source` 字段标明这次实际读的是哪个文件。
- **`task.cancel` 内部用带校验的引擎 RPC**：`services/tasks.cancel` 调用 `_派单核心.cancel(taskId,
  { rpc })` 注入 `core/adapters/engine.mjs` 的 `rpc`（pid 存活 + 端口可连校验后的 token）；
  CLI/旧调用方不传 `rpc` 时，`_派单核心` 用原内部实现（向后兼容）。**别在别处再写一份 cancel**，
  否则会绕过校验、退化成"旧 token 静默失败"。
- **`task.dispatch` 的唤醒也走带校验路径**（P1 patch-1）：`services/tasks.dispatch` 给
  `_派单核心.dispatch` 传 `wakeImpl`（内部用 `engine.sessionPrompt` + 同一份 `wakeText` 模板），
  返回 `engineRoute`（`endpoint` / `log` / `config` / `env` / `none`）+ `engineDiag`；中间件 audit
  也会记 `engineRoute`。详见下面的「接口变更记录」。

### 旧 `workbench__*` 别名（只在 face 层用，core 不注册）

| 旧名 | → 能力 |
|---|---|
| `workbench__pc_inspect` | `pc.inspect` |
| `workbench__review_search` | `review.search` |
| `workbench__webai_council` | `webai.council` |
| `workbench__dispatch_task` | `task.dispatch` |

face 层可用 `ALIASES` / `resolveName(name)`（`index.mjs` 导出），不需要自己维护映射表。

## 中间件管线（`core/middleware.mjs`，顺序固定，能力不许重排）

```
authz(ctx) → INJ-01(机密出境) → rateLimit(ctx) → executor(args,ctx) → CMP-01(修剪/溢出) → audit(trace)
```

- **ctx**：`{ face:'mcp-stdio'|'mcp-http'|'rest'|'cli'|'ipc', agent, traceId, scopes, now }`；
  face 用 `makeCtx(face, {agent,traceId,scopes})` 生成；本机可信面默认 `scopes:['local-full']`。
- **失败统一** `{ ok:false, code, err }`；face 负责翻译（MCP → `isError:true` 等）。
- **INJ-01**：入参里任何字符串命中凭据模式即拒绝（`E_INJ`）；模式表只有这一份。
- **rateLimit**：默认 60 次/分（key = agent/face），可用 `ctx.rateLimitMax` 覆盖、`ctx.rateLimit:false` 关闭。
- **CMP-01**：结果 JSON > 6000 字符 ⇒ 完整结果落 `外壳/data/mcp-spool/`，返回修剪版 + `_cmp` 元信息
  （阈值/目录与旧 `workbench-mcp.mjs` 一致，face 删掉自己那份后行为不变）。
- **audit**：`外壳/data/core-audit.log`（JSONL：ts/traceId/face/agent/cap/ok/ms/code；
  涉及引擎的能力再带 `engineRoute`），机写区、被 gitignore 挡。

### 错误码

| code | 含义 |
|---|---|
| `E_AUTH` | face/scope 不足 |
| `E_INJ` | INJ-01 拦截（疑似机密出境） |
| `E_RATE` | 限流 |
| `E_TIMEOUT` | 能力执行超时 |
| `E_VALIDATE` | 参数/业务校验失败（如场景未绑定、任务不存在） |
| `E_ENGINE` | 引擎不可用（拿不到 token/cookie、RPC 失败） |
| `E_NOTFOUND` | 能力名/任务号不存在 |
| `E_INTERNAL` | 能力内部异常 |
| `E_DOMAIN` | 能力返回 `ok:false` 且未给具体 code |

## 适配器

### `adapters/engine.mjs` —— token / 端点 / RPC（P1 的"旧 token 残留"修复点）

`harness-endpoint.json` 由主进程 `publishEngineEndpoint()` 写（`{baseUrl,port,token,ts,pid}`）。
读取顺序（**先校验，后回退**）：

1. `DSH_TOKEN` 环境变量（显式覆盖）
2. `harness-endpoint.json` —— **必须** `pid` 进程存活（`process.kill(pid,0)`）+ 引擎端口可连（TCP 800ms）；
   任一不满足就**整份跳过**（不拿旧 token/旧 baseUrl）
3. `工作台.json` 的 `dshPort`（baseUrl）
4. `server.log` 正则兜底（ADR-11 降级路径；只读日志尾部 256KB）

对外导出：`resolveAuth()`（带 `diag` 说明走了哪一级）、`endpointInfo()`、`routeLabel()`（把
`resolveAuth().source` 归成 `endpoint|log|config|env|none` 五态，给审计/排障用）、`rpc()`、
`sessionCancel()`、`sessionPrompt()`、`health()`。

### `adapters/store.mjs` —— 台账门面

唯一写入实现仍是 `工具/_派单核心.mjs`（append-only JSONL + 锁文件 + 读侧折叠状态）；
这里只做门面，core 不出现第二套台账逻辑。换存储只换这一层。

## 接口变更记录

### 2026-11-08 · P1-A patch-1（Lead 批准）：派单唤醒注入 + token 路径可观测

背景：`cancel` 已用带校验 RPC，但 `dispatch` 的唤醒内部仍是 P0 的 endpoint-first
（`harness-endpoint.json` 若是上一个壳进程留下的，就会拿着旧 token 静默失败）。

变更（全部**纯追加**，默认行为不变）：

- `工具/_派单核心.mjs`
  - `dispatch(opts)` 新增可选 `opts.wakeImpl`（自定义唤醒实现）/ `opts.rpc`（注入引擎 RPC）；
    **两个都不传时调用路径与 P0 完全一致**（同步 `wake()` → 内部 `engineRpc`）。
  - `wake({...}, rpcFn?)` 新增可选第二参（默认 `engineRpc`）。
  - 新增导出 `wakeText({taskId,title,content,from})`（唤醒提示词模板；定制 wakeImpl 复用它，
    避免出现第二套文案）。
- `core/services/tasks.dispatch`
  - 先 `resolveAuth()`（pid 存活 + 端口可连校验；不满足自动回退）；
  - 给 `_派单核心.dispatch` 传 `wakeImpl`（内部 `engine.sessionPrompt` + `wakeText`）；
  - 返回 `engineRoute`（`endpoint|log|config|env|none`，`engine.routeLabel()` 归一）+ `engineDiag`（逐级原因）。
- `core/middleware.mjs`：审计行在结果带 `engineRoute` 时一并记录（排障时看
  `外壳/data/core-audit.log` 就能知道"这次唤醒用的是 endpoint 还是日志兜底"）。

默认路径影响面：CLI `工具/派单.mjs`、旧网关等不传新 opts 的调用方行为与 P0 一致
（已复跑 `验收` 6 步与 `派单.mjs --list`/实测派单）。延迟说明：dispatch 前做一次端点解析，
endpoint 探测结果缓存 5s；最坏 800ms 只发生在"pid 存活但端口不通"的情形。

## 用法

```js
// ESM（face 本身是 ESM，如 workbench-mcp.mjs / mcp-http.mjs）
import { call, list, makeCtx, ALIASES } from '../core/index.mjs';
const ctx = makeCtx('mcp-stdio', { agent: 'cursor', traceId: incomingTraceId });
const r = await call('pc.inspect', { quick: true }, ctx);

// CJS（agent-gateway.js）：动态 import（已有 corePromise 先例）
const core = await import(url.pathToFileURL(corePath).href);
const r = await core.call('task.dispatch', args, core.makeCtx('rest', { agent, traceId }));
```

## 硬约束

- 全部 **ESM**；单文件 **≤800 行**；无盘符绝对路径、无真实 session UUID、无 `eval`。
- **不 spawn 子进程**（派单/检索/体检读数全部进程内或 HTTP）。
- `memory.search` / `review.search` **只读**人写区（ADR-10）；审计/spool 只写机写区（`外壳/data/`，被 ignore）。
- 新增能力 = `registry.define(...)` 一处 + `services/` 一个实现；**不要**在 face 里写业务逻辑。

## 自检

```powershell
# 11 个能力名（P1 判据；2026-11-10 P4 增 task.claim，D 增 bilibili.extract）
node -e "import('./12-源码照搬/外壳/core/index.mjs').then(m=>{console.log(m.list().map(x=>x.name||x).join(' | '))})"
# 契约回归（路由编码 / 能力表 / 信封字段 / 入参校验）
node 12-源码照搬\外壳\core\core-contract.test.mjs
# 面板运行时自检（默认关）：启动 12 秒后自动切到「命令」场景，核对任务台账面板是否真挂载/取数/展开证据
#   （在 12-源码照搬 目录下执行）
#   cmd /c "set WB_NO_ELEVATE=1& set WB_SELFCHECK=1& .\启动.bat"
# 整套闸门
node 12-源码照搬\工具\验收.mjs
```

历史执行记录见 `_本机产物/优化报告/改造执行/P1-A-能力层.md`（本机产物，不入库）。
