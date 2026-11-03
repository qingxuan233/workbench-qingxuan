# Financial Compensation (财务报销系统) · 项目记忆

> 项目 id：`financial-compensation` ｜ 路径：`代码根\Financial Compensation` ｜ 状态：进行中 ｜ 最近更新：2026-11-02

- **状态**：进行中（P0 有条件通过，P1 进行中）
- **一句话**：约 100 人集团内网自用财务报销系统，TypeScript 单体，NestJS 12 + Prisma 6.19 + PostgreSQL + Vue 3.5。
- **技术栈**：Node.js 24 + pnpm 12 + NestJS 12 + Vue 3.5 + Prisma 6.19 + PostgreSQL + Vitest + Playwright。
- **关键入口**：
  - 启动前后端：`pnpm dev`
  - 质量门：`pnpm verify`
  - 环境预检：`powershell -ExecutionPolicy Bypass -File scripts/preflight.ps1`
  - 规划文档：`docs/10-plan/current-status.md`
- **下一步**：根据宿主需求推进 P1 阶段具体功能开发与质量门校验。
- **坑与纪律**：
  - 严格遵守该项目专属规范 `代码根\Financial Compensation\AGENTS.md`；
  - 提交前必须保证 `pnpm verify` 全绿；
  - 涉及数据库操作先查状态 `pnpm db:status`，迁移走 `pnpm db:deploy`。