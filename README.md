# dsh-ds-db

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的 **只读数据库插件**：一个独立的插件包，自带 Web 配置页面，并给模型暴露 4 个只读工具。它面向的数据库由**方言接缝**决定，当前内置 MySQL（`dialect: mysql`），加 PostgreSQL / Oracle 只需新增一个方言。

插件是独立目录、独立的 pnpm 工程，不修改 `deepseek-harness` 仓库的任何文件。

## 组成

```
.
├── package.json            # 包清单：dsh.bundle（可安装层）+ dsh.client（浏览器半边）
├── cordis.patch.yml        # 以 bundle 安装时贡献的一层：一行 ds-db
├── src/                    # 源码（host 半边 + browser 半边）
│   ├── index.ts            # host 入口：设置命名空间、方言注册表、工具、连接探测路由
│   ├── contract.ts         # 两半边共享的常量与类型（不含任何 import）
│   ├── settings.ts         # Schemastery 配置 schema + 组合默认值
│   ├── dialect.ts          # 方言 seam：DatabaseDialect 定义 + 注册表服务
│   ├── dialect-mysql.ts    # MySQL provider：驱动、连接池、元数据 SQL、语法
│   ├── connection.ts       # 方言中立的会话运行器（身份换会话、超时、截断、错误包装）
│   ├── sql-guard.ts        # 只读语句判定（词法与禁止项由方言提供）
│   ├── value.ts            # 无损 JSON 投影与单元格读取器
│   ├── tools.ts            # 4 个模型可见工具（方言中立，不含 SQL）
│   └── client/             # 浏览器半边：设置整页、表单状态机、双语字典、CSS Modules
├── scripts/                # 构建与验证脚本
├── tests/                  # 只读语句判定与 MySQL 方言的单元测试
├── lib/                    # 构建产物（npm run build 生成，不入库；`prepare` 会在安装时自动构建）
├── LICENSE                 # MIT
└── .dev/                   # 开发用临时目录（生成的 overlay、临时 DSH_HOME）
```

## 方言 seam

插件面向的数据库由**方言（dialect）**决定：`DatabaseDialect` 把一个数据库的差异全部收在一处，工具、配置页与会话运行器都不含任何方言知识。

一个方言拥有：驱动与连接池、元数据语句（列别名与行投影）、占位符写法、行数上界语法、标识符引用、词法规则（引号/注释/转义）、禁止项清单，以及模型可见文案需要的事实（自称、放行的语句族、行数上界的写法、系统库名单）。

- 注册表是 `ctx.databaseDialects`（由本插件提供）。本插件在加载时把自己那个方言注册进去，所以单包安装无需额外配置。
- **本插件内新增方言**（推荐，文案完全正确）：仿照 `src/dialect-mysql.ts` 写一个 `MYSQL_DIALECT` 那样的对象，在 `src/index.ts` 里多注册一行，然后 `dialect: <名字>` 选用。
- **单独打包一个方言**：新包 `inject: ['databaseDialects']` 后 `ctx.databaseDialects.register(dialect)`。调用会立即走这个方言；但**工具描述是注册时就写定的文本**，后到的方言只会让描述里的自称与语句族滞后到下次重载，调用本身不受影响（`described` 与 `dialect()` 在 `DatabaseToolsFace` 里是两个成员，正是这个区别）。
- 名字没注册时在**首次调用**报错并列出已注册的方言：注册表由本插件提供，别的方言包只能在之后注册，所以加载期无法知道最终集合。

## 前置条件

- Node `^22.19 || >=24`，pnpm（本插件用自己的 pnpm 工程管理依赖）。
- 一个可访问的 MySQL 服务；**建议使用只有 `SELECT`（以及 `SHOW VIEW`、`INFORMATION_SCHEMA` 读取）权限的账号**，这是只读姿态的第三层（见下）。
- 一个 `dsh` 运行环境：源码 checkout（推荐，配合 `--patch` 覆盖层）或已安装的 `dsh` CLI。

## 安装依赖并构建

```sh
cd ds-db-plugin
pnpm install          # 安装 mysql2 与构建工具
npm run build         # 产出 lib/index.js（host）与 lib/client.js（浏览器半边）
```

`lib/client.js` 是必需产物：`dsh` 的客户端模块扫描读取包的 `exports["./client"]`，源码改动后必须重新构建浏览器半边。

## 加载插件

### A. 源码 checkout（开发态，加载 `src/`）

```sh
cd ds-db-plugin
node scripts/dev-overlay.mjs            # 生成 .dev/cordis.yml（写入本机绝对路径）

cd ../deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts web --patch <插件目录>/.dev/cordis.yml
# 等价的 pnpm 写法：pnpm dsh web --patch <插件目录>/.dev/cordis.yml
```

`--patch` 里的插件路径必须是绝对路径：补丁文件本身不改变 Loader 解析模块的目录。

### B. 安装进 profile（可安装包形态）

```sh
cd ds-db-plugin
dsh plugin --profile demo add .          # pnpm 把本目录按 link: 装进 profile，并把本 bundle 追加进 dsh.profile.bundles
dsh --profile demo --dump-config         # 应能看到 "# == dsh-ds-db" 这一层
dsh --profile demo
```

bundle 的 `cordis.patch.yml` 用包名引用本插件；profile 的 `dsh.profile.bundles` 顺序决定层序，profile 自己的 `cordis.patch.yml` 与 `--patch` 覆盖层永远排在后面（后者按行覆盖 `config`，是整块替换）。

**这条路本机未验证**（`pnpm` 不在 PATH 上，且它依赖的是打包版 dsh 的模块解析），已实测的是：

- 行指向 `src/index.ts`：在源码 checkout 下由 tsx 按 cwd 的 tsconfig `paths` 解析 `@deepseek-ai/*`，可用（下面「加载插件 A」即此路径，已跑通）。
- 行指向 `lib/index.js`：在源码 checkout 下同样可用（tsx 的 `paths` 对 `.js` 生效，实测 `Object.keys` 为 `Config,apply,inject,name`）；但用**纯 Node**（不带 tsx）导入 `lib/index.js` 会 `ERR_MODULE_NOT_FOUND`——`@deepseek-ai/*` 是裸导入，需要由运行环境提供。装进打包版 dsh 时，本插件需自行声明这些 harness 包为依赖，这一步没有验证。

## 配置页面

设置 → **MySQL**（`settings.section`，`id` 为 `ds-db`，`order: 40`，排在通用设置 / 模型 / 内置插件之后）。页面读写的是一份 User Settings 命名空间 `ds-db`，只有被改动过的字段会落盘（例如只改端口时 `settings.yaml` 里只有 `ds-db.port`）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | MySQL 地址 |
| `port` | `3306` | MySQL 端口 |
| `user` | `root` | 连接账号 |
| `database` | 空 | 默认库；留空则每次工具调用都要指定 |
| `passwordEnv` | `DSH_MYSQL_PASSWORD` | 密码在凭据存储中的引用名 |
| `connectTimeoutMs` | `10000` | 建连超时 |
| `queryTimeoutMs` | `30000` | 单条语句超时 |
| `maxRows` | `200` | 单次查询返回给模型的最大行数 |

- **密码走凭据服务**：页面上的密码框是只写的，输入后经 `credentials/set` 写入凭据存储（引用名即 `passwordEnv`），设置文档里只有引用名，返回值里永远没有密码字面量。页面只显示「已配置 / 未配置」。
- **改动立即生效**：每次工具调用与连接探测都重新读取设置，连接身份变化时连接池被替换，不需要重启插件。
- **测试连接**：页面上的「测试连接」调用插件自己挂在 `POST /api/ds-db/test` 的精确路由（走 `/api` 的鉴权栅栏：无 cookie 返回 401），Host 侧用当前保存的连接执行版本查询，成功显示版本与耗时，失败显示服务器的原始拒绝信息。

同名值可以来自三层：schema 默认值 → 组合层（`cordis.yml` 里该行的 `config`）→ 用户层（配置页面）。用户层里「存在」即视为已覆盖，页面会打「已覆盖」标记并提供「恢复默认」。

### cordis.yml 配置

```yaml
- insert:
    - id: ds-db
      name: 'dsh-ds-db'
      config:
        # 组合层字段，不在配置页上：选用注册表里的哪个方言（默认本插件自带的 mysql）
        dialect: mysql
        host: db.internal
        port: 3306
        user: dsh_reader
        database: app
        passwordEnv: DSH_MYSQL_PASSWORD
        connectTimeoutMs: 10000
        queryTimeoutMs: 30000
        maxRows: 200
```

`dialect` 与其余字段一样可选，缺省即本插件自带的 `mysql`。字段全部可选；缺省即用上表默认值。补丁按行整块替换 `config`，覆盖时请写全要保留的键。

## 模型可见的工具

| 工具 | 作用 |
| --- | --- |
| `db_databases` | 列出可见的库（字符集/排序规则），默认隐藏 `information_schema`/`mysql`/`performance_schema`/`sys` |
| `db_tables` | 列出某个库的表与视图（类型、引擎、行数估算、表注释） |
| `db_describe` | 描述一张表：列（类型/可空/默认值/键/extra/注释）、索引（唯一性/类型/列序）、`SHOW CREATE TABLE` 原文 |
| `db_query` | 执行**一条**只读语句，返回列名与行（JSON） |

工具名用中立的 `db_` 前缀（不是 `mysql_`）：它们服务的是配置里选中的那个方言，具体连到哪种库由各自的 description 说明（例如 `db_query` 的描述会写 "Run one read-only MySQL statement…"，换方言后自动变成该方言的自称）。

`db_query` 的语句判定（结构在 `src/sql-guard.ts`，规则由方言给出）：

1. 先做词法掩码：字符串字面量清空、注释剔除——字面量或注释里的分号与关键字不参与判定。引号字符、注释标记、是否允许反斜杠转义都由方言声明（MySQL 里 `#` 是注释，PostgreSQL 里它是运算符，这类差异不会互相污染）。
2. 只放行方言声明的语句族打头的**单条**语句（MySQL：`SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` / `TABLE` / `VALUES`）；分号结尾会被去掉。
3. 拒绝「看着只读、实际会写或加锁」的写法。MySQL 的清单是 `INTO OUTFILE` / `INTO DUMPFILE`、`FOR UPDATE`、`LOCK IN SHARE MODE`、`PROCEDURE ANALYSE`（注释穿插的写法同样会被识破，因为判定走掩码后的文本；`FOR UPDATE` 这对是各方言共用的）。
4. 行数上界由方言拼：MySQL 追加 `LIMIT maxRows + 1`；返回时统一截断到 `maxRows` 并标记 `truncated`。

结果值统一投影为无损 JSON（`Date` → ISO 字符串，`bigint`/`DECIMAL` 保持字符串，`Buffer` 转为有上界的十六进制预览），因为工具结果必须是 JSON 可重建的。

### 只读姿态的三层

1. `sql-guard.ts` 的语句判定（插件内，最先执行，规则来自方言）；
2. 方言自己的协议层约束——MySQL 是连接池 `multipleStatements: false` 与每语句超时；
3. **部署方的只读账号**——前两层是插件内的约束，只有第三层能挡住未来可能出现的绕过。

## 命令

```sh
npm run build        # 构建 host 与浏览器半边（`prepare` 钩子在安装时也会调用它）
npm run typecheck    # tsc 类型检查（harness 依赖按已构建的 .d.ts 解析）
npm test             # 单元测试（18 例）：语句判定 + MySQL 方言的语法/语句/投影
npm run overlay      # 生成 .dev/cordis.yml

# host 半边组合自检：挂到真实 ToolRuntime 上，断言工具注册、描述文本与拒绝文本
# 逐一比对重构前的字符串，并验证一个「加载后才注册」的第二个方言能跑通全部工具
npm run verify:host
```

`verify:host` 依赖同一个 checkout 旁的 `deepseek-harness`（`tsconfig.json` 的 `paths` 把 `@deepseek-ai/*` 指向 harness 源码），因此它在这台机器上是自包含的，换机器需要同步调整 `paths`。

## 已知限制 / 暂未实现

- **只有 MySQL 一个方言**：seam 已就位（见上），但 PostgreSQL / Oracle 尚未实现。加 PostgreSQL 便宜（`information_schema` 大体可移植、`LIMIT` 同样存在、`?`→`$n` 是机械替换，主要重写 `SHOW CREATE TABLE` 的替代）；加 Oracle 贵（无 `LIMIT`、无 `information_schema`、SID 与 service name 是两种连法、`DBMS_METADATA` 常需额外授权、`oracledb` 是重量级原生依赖），建议单独评估。
- **配置页字段仍是 MySQL 形状**：`host/port/user/database` 与默认端口 3306。Oracle 需要 service name 之类的字段时，要同时改 `settings.ts`、`contract.ts`、配置页与字典。
- **客户端字典命名空间与内部标识符仍带 MySQL 字样**：工具名（`db_*`）、设置命名空间（`ds-db`）、探测路由（`/api/ds-db/test`）、包名与插件行 id 都已中立，但客户端字典命名空间仍是 `settings.mysql`，TS 内部标识符（`MysqlSettings`、`MysqlSettingsPage`、`MYSQL_SETTINGS_NAMESPACE` 等常量名）也保持原样——它们不对外暴露，改名属纯内部重构。配置页的导航标题也仍是「MySQL」，因为它配的就是默认方言的连接。
- **不做 TLS/SSL 选项**：连接固定走 `mysql2` 默认（无 TLS）。需要 TLS 的远端库要额外加配置字段（schema、cordis.yml、配置页各一处）。
- **单个连接身份**：一个插件实例只服务一份连接配置，没有多数据源切换；`dialect` 是选择一个方言，不是并联多个库。
- **没有采样数据与执行计划工具**：`EXPLAIN` 目前只能通过 `db_query` 手写（工具集按需求只包含库表清单、表结构、查询三类能力）。
- **没有查询结果卡片**：工具结果走通用呈现，没有做 Web 侧专用卡片。
- **浏览器半边需要重新构建**：它是构建产物（`lib/client.js`），改 `src/client` 后必须 `npm run build`，Host 侧源码态改动则随 `tsx` 热加载。
- 作为仓外插件，它不参与 `deepseek-harness` 仓库的 gate（每文件 100% 覆盖率、双语 README 配对、生成物目录等）；`typecheck`、`npm test` 与 `scripts/verify-host.mjs` 是本工程自带的检查。

## 许可

[MIT](LICENSE) © 2026 苏慕
