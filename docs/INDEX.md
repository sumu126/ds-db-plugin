# ds-db-plugin 文档索引

> 本目录存放 `dsh-ds-db` 插件的扩展能力建设文档。目标：**让第三方开发者不改本仓库，就能发布一个包，为 dsh 增加一种数据库类型。**

## 目录结构说明

工作流规范定义了 10 个标准目录（`01_Design` … `10_Templates`）。本插件是单包 TypeScript 工程，无 Java/Vue 分层，因此**只建实际使用的目录**，编号沿用规范以便对照：

| 目录 | 用途 | 状态 |
| --- | --- | --- |
| `01_Design/` | 设计方案（seam 设计、兼容性策略、里程碑） | 使用中 |
| `04_API_Docs/` | 对外契约：方言作者要实现的接口 | 使用中 |
| `05_Docs/` | 需求文档、任务清单、决策记录、项目元数据 | 使用中 |
| `08_Resources/` | 原始需求输入 | 使用中 |
| `02_CSS_Style_Guide/`、`03_Database_Design/`、`06_UI_Design/`、`07_Code/`、`09_Temp/`、`10_Templates/` | 本插件不涉及（无独立建库、无设计稿、代码在 `../src`） | 未建 |

## 文档清单

### 需求（`05_Docs/`）
- [`05_Docs/project-meta.json`](./05_Docs/project-meta.json) — 项目元数据
- [`05_Docs/requirements/01_可扩展数据库类型_需求.md`](./05_Docs/requirements/01_可扩展数据库类型_需求.md) — PRD：三类开发者、用户故事、验收标准
- [`05_Docs/requirements/01_可扩展数据库类型_任务清单.md`](./05_Docs/requirements/01_可扩展数据库类型_任务清单.md) — M0–M6 里程碑任务清单
- [`05_Docs/decisions/2026-09-22_配置字段扩展方案选型.md`](./05_Docs/decisions/2026-09-22_配置字段扩展方案选型.md) — 关键决策：通用字段 + 方言扩展字段

### 设计（`01_Design/`）
- [`01_Design/001_方言扩展能力_设计方案.md`](./01_Design/001_方言扩展能力_设计方案.md) — 核心：三条 seam 的补全方案、兼容性策略、风险
- [`01_Design/002_插件自身的插件化_设计方案.md`](./01_Design/002_插件自身的插件化_设计方案.md) — 核心不再内置方言，`dialects/` 工作区与工具注册的等待机制
- [`01_Design/003_默认值的归属_设计方案.md`](./01_Design/003_默认值的归属_设计方案.md) — 端口/账号/自述归方言（`connectionDefaults`、`description`），命名残留清理
- [`01_Design/004_多连接寻址_设计方案.md`](./01_Design/004_多连接寻址_设计方案.md) — 模型按名字选连接（`connection` 参数 + `db_connections`），会话按连接缓存

### 契约（`04_API_Docs/`）
- [`04_API_Docs/方言扩展_API.md`](./04_API_Docs/方言扩展_API.md) — 方言作者视角的 `DatabaseDialect` 接口、注册方式、自检清单

### 原始输入（`08_Resources/`）
- [`08_Resources/2026-09-22_需求原话.md`](./08_Resources/2026-09-22_需求原话.md) — 需求来源记录

### 方言工作区（`dialects/`）
- [`dialects/README.md`](./../dialects/README.md) — 工作区规则、两种开发位置、常见问题
- [`dialects/_template/`](./../dialects/_template/README.md) — 新方言起手骨架
- [`dialects/mysql/src/index.ts`](./../dialects/mysql/src/index.ts) — 完整真实实现，写新方言时的参考

## 当前状态（2026-09-22）

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| — | 多连接卡片设置页（提交 `ef834d5`） | ✅ |
| M1 | 分发：宿主包声明为可选 `peerDependencies` | ✅ 声明完成；**打包版 dsh 上的 `plugin add` 实测尚未完成**（本机无打包版 dsh） |
| M2 | 能力声明 `capabilities` + 工具降级 + 注册校验 | ✅ |
| M3 | 配置字段 `extra` + `configFields` + 方言清单路由 + 页面渲染 | ✅ |
| M4 | PostgreSQL 仓外参考实现 | ✅ 契约审计通过（无需数据库服务） |
| M5 | 方言自检套件 `auditDialect()` | ✅ 接入 `npm test`（24 例） |
| M6 | 可选工具 `db_sample` / `db_explain` 按能力注册；结果卡片（`presentationMeta` + `tool.call.toolview`）与 `verify:cards` | ✅ |

新增文件：`src/dialect-audit.ts`（自检）、`src/dialect-catalog.ts`（已知方言包清单）。

## 检查的归属（谁守什么）

越往下越贵，也越接近真实：**桩守结构、真库守行为、白盒守实现细节**。一条检查不可能同时拥有前两者。

| 检查 | 挂什么 | 守什么 |
| --- | --- | --- |
| 24 例单元 | 纯函数 | 只读判定（含字面量/注释绕过）、方言 facts、注册校验 |
| `verify:host` | 真 ToolRuntime + 桩方言 | 工具面、能力降级、**会话淘汰结构**（桩的 `opens`/`closes` 计数）、输出 schema、卡片元数据 |
| `verify:settings` | + 真设置服务 | 工具读到的是用户文档，而非组合兜底 |
| `verify:loader` | 真 Loader + 一次性 `DSH_HOME` | 组合能否解析、注入是否满足、卸载是否干净 |
| `verify:cards` | Host + 浏览器半边模型（Node） | 两端往返、畸形元数据回退、标题、字节预算与 recovery |
| `card:live`（手工） | 已记录的会话日志 | 真实数据上的卡片字节（中文三字节、宽单元格） |
| `db:live`（手工） | **真服务器** | 行形状、跨来源一致、卡片对规范值、`db_explain`、取消的**可见行为**、超时。⚠️ 取消那一行分不出「会话被淘汰」与「重试自愈」——两者各去掉一个都仍绿，只有同时去掉才红；**淘汰那层归 `verify:host` 的 `opens`/`closes` 计数** |

> 这张表的第三列按事实说话，但它的用处主要在**没写出来的那一半**：一条检查能守什么，取决于它的结论**被谁背书**。所以每条都该问两句——「这个数字是谁的函数」「这条断言被什么背书」——并在必要处写明这条检查**遮住**了什么。真库上分不出淘汰与重试，桩上分不出真驱动的行为，两者都不是缺陷，是归属。

## Backlog

都不是债，只是还没到做的时候：

| 项 | 前置条件 | 内容 |
| --- | --- | --- |
| PTC / 嵌套分发态 | 需要 PTC 环境 | 由 `parentCallId` 守卫 + 核心「只对顶层调用持久化 meta」兜着；验收即「嵌套的 `db_query` 落在通用行」 |
| 白盒假池用例 | 可选 | 把 `MysqlSession` 的池参数放宽成 `{ query, end }` 结构接口，用计数假池断言 abort 时 `end()` 被调用、且 `usable()` 随之翻 `false`（契约说这两件事耦合）。守的是「方言真的尽力了」，行为层观测不到（见 `dialects/mysql/src/index.ts` 的 `cancel` 注释） |
| Postgres 真方言 | 杠杆已铺好 | 接上后 `db:live` 五条断言立刻能跑它。第一步是把 `db:live` 里的语句片段参数化成 `{ probe, sleep, countTables, countDatabases }`；已知会撞上的四点差异：`pg_sleep`、`pg_database`、`SHOW FULL TABLES` 无对应物（`information_schema.tables` 可移植）、`database` 在 PG 上是**承重**的（连上即是一个库，`checkShapes` 里「默认库第一张表」那段要重设计） |
