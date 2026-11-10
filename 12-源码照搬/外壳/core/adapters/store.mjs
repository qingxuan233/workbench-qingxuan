/**
 * core/adapters/store.mjs —— 台账读写（JSONL）门面
 *
 * 唯一写入实现仍是 `工具/_派单核心.mjs`（append-only JSONL + 锁文件 + 读侧折叠状态）。
 * 本文件只做**门面**：core 不出现第二套台账逻辑，CLI/MCP/REST 三个面读到的永远是同一份数据。
 * 若将来要换存储（SQLite 等），只换这一层即可。
 */

export {
  APP,
  LEDGER,
  readTasks,
  getTask,
  findByIdem,
  sceneRegistry,
  resolveScene,
  dispatch,
  complete,
  list,
  claim,
  cancel,
  // P4-6（2026-11-10）：读时顺扫用。原先没导出 ⇒ services/tasks.list 调 ledger.sweep() 直接
  // "is not a function"（真窗口自检抓到的：面板显示「读取失败：ledger.sweep is not a function」）
  sweep,
  isOverdue,
  normalizeEnvelope,
  wake,
  wakeText,
  newTaskId,
} from '../../../工具/_派单核心.mjs';
