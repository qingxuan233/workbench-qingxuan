# BOS (Business Operating System) · 项目记忆

> 项目 id：`bos` ｜ 路径：`代码根\bos` ｜ 状态：进行中 ｜ 最近更新：2026-11-02

- **状态**：进行中
- **一句话**：企业级数据仓库与业务运营系统，基于 Apache Hop + PostgreSQL，整合 ERP 销售、寄售、采购等业务域的 ETL 管道。
- **技术栈**：Apache Hop (ETL / MDI 元数据注入) + PostgreSQL (数仓存储) + Docker + Apache Superset (规划中)。
- **分层架构**：
  - **ODS 层**：元数据注入统一数据抽取（全量与增量同步）
  - **DWD 层**：明细事实数据层（清洗、标准化、维度打宽）
  - **DWS 层**：主题汇总数据层（轻度汇总）
  - **ADS 层**：应用数据服务层
- **关键脚本与入口**：
  - 启动 Hop：`start-hop.bat` / `start-hop.sh`
  - 管道目录：`hop/ods/`、`hop/dwd/`、`hop/dws/`
  - 数据库脚本：`sql/`
- **下一步**：根据宿主指令推进具体 ETL 管道开发、数据清洗或表结构迁移。