# dsh-ds-db

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的 **只读数据库插件**：自带 Web 设置页，给模型暴露只读工具，而**它面向哪种数据库由可插拔的方言（dialect）决定**。内置 MySQL；要支持别的数据库，发一个方言包即可，不必改本仓库。

插件是独立目录、独立的工程，不修改 `deepseek-harness` 仓库的任何文件。

## 你是哪一类读者

| 你 | 直接看 |
| --- | --- |
| 想让模型查自己的库 | [快速开始](#快速开始使用者) |
| **想让 dsh 支持一种新的数据库** | [给方言作者](#给方言作者增加一种数据库类型) |
| 想加方言（起手骨架 / 工作区规则） | [`dialects/_template/`](dialects/_template/README.md)｜[`dialects/README.md`](dialects/README.md) |
| 想改插件本身（seam、工具、设置页） | [给插件开发者](#给插件开发者本地开发) |

## 能力一览

设置页管理**多条连接**（卡片列表、切换「使用中」立即生效）；模型侧的工具按当前使用的连接执行。

| 工具 | 作用 | 需要的能力 |
| --- | --- | --- |
| `db_connections` | 列出已保存的连接（名称、类型、服务器、默认库），并指出默认连接 | — |
| `db_databases` | 列出可见的库（字符集/排序规则） | `databases` |
| `db_tables` | 列出某库的表与视图（类型、引擎、行数估算、注释） | `tables` |
| `db_describe` | 描述一张表：列、索引、建表语句（有则给） | `columns` |
| `db_query` | 执行**一条**只读语句，返回列名与行 | 仅只读规则 |
| `db_sample` | 读几行样本，先看数据形状 | `sample`（可选） |
| `db_explain` | 解释一条语句的执行计划，不执行 | `explain`（可选） |

**多连接**：除 `db_connections` 外，每个工具都接受一个可选的 `connection` 参数（按连接的**名字**）。省略时走页面上标记为**默认**的那条。所以一个会话里可以同时查生产库和测试库——模型先 `db_connections` 看有什么，再按名字指定。

`db_sample` / `db_explain` 只在方言声明了对应能力时才注册——不支持的方言，模型工具列表里根本看不到它们。

## 组成

核心**不含任何数据库类型**：MySQL 也是一个方言包，和第三方的形状完全一样。

```
.
├── package.json            # 根包 = 核心（dsh-ds-db）：dsh.bundle + dsh.client
├── pnpm-workspace.yaml     # packages: ['.', 'dialects/*']
├── cordis.patch.yml        # 以 bundle 安装时贡献两行：方言包 + 核心
├── src/                    # 核心（host 半边 + browser 半边），不含方言
│   ├── index.ts            # host 入口：设置命名空间、方言注册表、工具、两条 API 路由
│   ├── contract.ts         # 两半边共享的常量与类型（不含任何 import）
│   ├── settings.ts         # Schemastery 配置 schema + 组合默认值
│   ├── dialect.ts          # ★ 方言 seam：DatabaseDialect 定义 + 注册表服务
│   ├── dialect-catalog.ts  # 可安装的方言包清单与默认方言名
│   ├── dialect-audit.ts    # ★ 方言契约自检（方言作者用）
│   ├── connection.ts       # 方言中立的会话运行器（身份换会话、超时、截断、错误包装）
│   ├── sql-guard.ts        # 只读语句判定（词法与禁止项由方言提供）
│   ├── value.ts            # 无损 JSON 投影与单元格读取器
│   ├── tools.ts            # 模型可见工具（方言中立，不含 SQL）
│   └── client/             # 浏览器半边：设置整页、表单状态机、双语字典、CSS Modules
├── dialects/               # ★ 数据库类型工作区
│   ├── mysql/              #   dsh-dialect-mysql：官方方言，随主包自动安装
│   │   ├── src/index.ts    #     完整真实实现，写新方言时的参考
│   │   ├── tests/          #     该方言的行为测试
│   │   └── scripts/verify.ts #   契约自检
│   ├── _template/          #   新方言的起手骨架（不是包）
│   └── README.md           #   工作区说明：怎么加一个方言
├── docs/                   # 需求、设计、API 契约、决策记录
├── scripts/                # 构建与验证脚本
├── lib/                    # 构建产物（npm run build 生成，不入库）
├── LICENSE                 # MIT
└── .dev/                   # 开发用临时目录（生成的 overlay）
```

## 快速开始（使用者）

### 前置条件

- Node `^22.19 || >=24`
- 一个可访问的数据库；**建议使用只有 `SELECT`（及元数据读取）权限的账号**——这是只读姿态的第三层，见 [只读姿态](#只读姿态的三层)
- 一个 `dsh` 运行环境：源码 checkout（推荐，配合 `--patch`）或已安装的 `dsh` CLI

### 安装与构建

```sh
cd ds-db-plugin
pnpm install --no-frozen-lockfile      # 首选；宿主包是可选 peer，lockfile 需随声明更新
# 若包管理器仍去解析未发布的宿主包：npm install --legacy-peer-deps
npm run build                          # 产出 lib/index.js（host）与 lib/client.js（浏览器半边）
```

`lib/client.js` 是必需产物：`dsh` 的客户端模块扫描读取包的 `exports["./client"]`，改了 `src/client` 必须重新构建。

### 加载插件

**A. 源码 checkout（开发态，加载 `src/`）**

```sh
cd ds-db-plugin
node scripts/dev-overlay.mjs            # 生成 .dev/cordis.yml（写入本机绝对路径）

cd ../deepseek-harness
pnpm dsh web --patch <插件目录>/.dev/cordis.yml
```

`--patch` 里的插件路径必须是绝对路径。

**B. 安装进 profile（可安装包形态）**

```sh
dsh plugin --profile demo add .
dsh --profile demo --dump-config        # 应能看到 "# == dsh-ds-db" 这一层
dsh --profile demo
```

### 设置页

设置 → **数据库管理**。页面管理多条连接：

- 每张卡片一条连接，悬浮抬升；徽标显示类型或「使用中」
- 右上角**新建连接** → 先选数据库类型（已安装的方言可选，未安装的显示「即将支持」及包名）→ 再填该类型的字段
- 卡片操作：**设为使用 / 测试 / 编辑 / 删除**；切换「使用中」后下一次工具调用即生效，不需要重启
- 密码只写不读：经 `credentials/set` 存入凭据存储，设置文档里只有引用名

### 配置（cordis.yml）

组合层可以只写平铺字段（得到一条默认连接），也可以预置多条：

```yaml
- insert:
    - id: ds-db
      name: 'dsh-ds-db'
      config:
        connections:
          - id: app
            name: 业务库
            dialect: mysql
            host: db.internal
            port: 3306
            user: dsh_reader
            database: app
            passwordEnv: DSH_MYSQL_PASSWORD
            connectTimeoutMs: 10000
            queryTimeoutMs: 30000
            maxRows: 200
            extra: {}          # 该方言专属字段
        activeId: app
        # 工具注册等待方言包就绪的上限（毫秒）；超时后用兜底事实注册，调用会报出未注册的方言
        dialectWaitMs: 100
        # 同时保持打开的会话数（按连接身份计），超出后关闭最久未用的一条
        sessionLimit: 4
```

补丁按行整块替换 `config`，覆盖时请写全要保留的键。

### 只读姿态的三层

1. `sql-guard.ts` 的语句判定（插件内，最先执行，规则来自方言）
2. 方言自己的协议层约束（MySQL 是 `multipleStatements: false` 与每语句超时）
3. **部署方的只读账号**——前两层是插件内的约束，只有第三层能挡住未来可能出现的绕过

## 给方言作者：增加一种数据库类型

**你不需要改本仓库。** 发一个包，注册一个方言，4 个既有工具立刻就能跑在你的数据库上，设置页也会出现你的数据库类型。

### 它为什么能这样工作

```
你的包 ──inject: ['databaseDialects']──▶ ctx.databaseDialects.register(你的方言)
                                                  │
本插件的 4 个工具 ─────────────────────────────────┘（每次调用重新解析当前方言）
```

- 注册表由本插件提供，注册是 effect，返回 disposer
- 工具每次调用都重新解析连接与方言，所以你的方言晚于插件加载也能立刻生效
- 唯一的滞后：工具**描述文案**在注册时写定，你的方言自称要等插件重载后才出现在描述里——**不影响调用**

### 五步做出来

**第 1 步：建包**

```json
{
  "name": "dsh-dialect-clickhouse",
  "type": "module",
  "main": "lib/index.js",
  "peerDependencies": { "dsh-ds-db": ">=0.2.0" },
  "dependencies": { "clickhouse-client": "^1.0.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**第 2 步：注册**

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dialect-clickhouse'
export const inject = ['databaseDialects']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.databaseDialects.register(CLICKHOUSE_DIALECT), 'clickhouse dialect')
}
```

配套 `cordis.patch.yml`（让 Loader 加载你这个包）：

```yaml
- insert:
    - id: dialect-clickhouse
      name: 'dsh-dialect-clickhouse'
```

**第 3 步：实现 `DatabaseDialect`**

这是全部工作量所在。完整契约见 [`docs/04_API_Docs/方言扩展_API.md`](docs/04_API_Docs/方言扩展_API.md)，要点如下：

| 成员 | 你要提供什么 |
| --- | --- |
| `name` / `label` | 注册表键与模型可见的自称 |
| `description` | 一句自述（页面类型卡片显示它——插件不会替你写） |
| `connectionDefaults` | 你的库的端口与账号（如 `{ port: 5432, user: 'postgres' }`）：页面用它预填新连接 |
| `rules` | **只读红线**：词法（引号字符、注释标记、是否允许反斜杠转义）+ 放行的语句族 + 禁止项（看着只读实则会写或加锁的写法） |
| `open(connection)` | 用你的驱动开一个会话，实现 `run(statement)` 与 `close()` |
| `applyRowLimit(sql, n)` | 保证「忘记写上限也不会把整表灌进模型上下文」 |
| `quoteIdentifier(name)` | 挡住带引号字符的标识符 |
| `databases/tables/columns/indexes/createStatement/version` | 元数据查询**及其行投影**：列名是你自己的，`project` 负责映射，工具层永远不读列名 |
| `rowBoundHint` / `systemDatabases` | 模型文案需要的事实：上界怎么写、哪些是系统库 |

**第 4 步：如实声明能力与专属字段**

```ts
capabilities: new Set(['databases', 'tables', 'columns', 'indexes', 'estimatedRows', 'version']),
configFields: [{ key: 'sslMode', kind: 'text', default: 'disable', required: false, label: 'SSL mode' }],
```

- **缺什么能力就别声明什么**：能力缺失时工具会降级（`db_describe` 省略建表语句、索引为空、行数估算为 `null`、字符集为空串），而不是去跑一条你的库没有的 SQL。这是契约的一部分，不是异常
- `configFields` 的值存进连接的 `extra`，设置页会为你的方言渲染这些字段
- 声明 `sample` / `explain` 就必须实现同名方法，否则注册直接抛错

**第 5 步：自检**

```ts
import { auditDialect } from 'dsh-ds-db/src/dialect-audit.ts'

const problems = auditDialect(YOUR_DIALECT)   // 空数组 = 通过
```

覆盖：只读判定（含「字面量/注释里的分号」这类绕过）、行数上界、标识符引用、各元数据投影、能力与实现一致性、字段默认值类型。**不需要数据库服务**。

### 从模板开始

一个起点，两种去向：

```sh
# 复制骨架
cp -r dialects/_template <你的方言目录>

# A. 留在本仓 dialects/ 下开发（官方/合作方言）
mv <你的方言目录> dialects/clickhouse && cd dialects/clickhouse && npm run verify

# B. 或复制出去建独立仓发布
cd <你的方言目录> && git init && npm run verify && npm publish
```

骨架里每个 `TODO` 都标了要改的位置；动手前建议先读 [`dialects/mysql/src/index.ts`](dialects/mysql/src/index.ts)——那是**完整真实的参考实现**，包括驱动接入、`information_schema` 元数据 SQL、只读规则与投影。

它也是「能力缺失如何降级」的参照：方言不声明自己没有的能力（MySQL 全声明，PostgreSQL 类没有 `SHOW CREATE TABLE` 的话就不声明 `createStatement`），工具会自行降级而不是报错。

### 在仓内加方言要不要改核心？

只有**随主包分发**时才需要，改两处：核心 `cordis.patch.yml` 加一行（**排在 `ds-db` 行之前**）、核心 `dependencies` 加该方言包。独立发布的方言，核心一行都不用动——用户自己 `dsh plugin add`。

### 常见坑

| 现象 | 原因 |
| --- | --- |
| 装不上，报找不到 `dsh-ds-db` | 它还没发布到 npm，安装时加 `--legacy-peer-deps` |
| 调用报「dialect X is not registered」 | 你的包没被加载；用 `dsh --dump-config` 确认那一层在 |
| 工具描述里还是旧的自称 | 已知行为：描述注册时写定，重载后更新；**调用不受影响** |
| 设置页没出现我的类型 | 页面从 `GET /api/ds-db/dialects` 读注册表；确认你的方言注册成功 |
| 改了浏览器侧内容没生效 | 浏览器半边是构建产物，必须重新 build |

## 给插件开发者：本地开发

```sh
pnpm install --no-frozen-lockfile   # 或 npm install --legacy-peer-deps
npm run typecheck         # 核心 + 各方言包（harness 依赖按其 .d.ts 解析）
npm test                  # 方言包的行为测试与契约审计（24 例）
npm run verify:host       # 挂真实 ToolRuntime：方言以独立插件挂载后跑通全部断言
npm run verify:settings   # 挂真实设置服务：工具读到的是用户保存的文档，而非组合兜底
npm run verify:loader     # 经 Loader + 真实 cordis.yml 组装：加载、注入、卸载
npm run build             # 核心 + 浏览器半边 + 每个方言包
npm run overlay           # 生成 .dev/cordis.yml（两行：方言包 + 核心）
```

三道 `verify` 各自覆盖不同的一半，缺一道就有一类错误能长期隐身：

| 检查 | 挂什么 | 抓什么 |
| --- | --- | --- |
| `verify:host` | 真实 ToolRuntime，**无**设置服务 | 工具注册、描述与拒绝文本、能力降级、多连接寻址、取消 |
| `verify:settings` | + 真实设置服务与 `~/.dsh/settings.yaml` | 工具读到的是**用户文档**而不是组合兜底 |
| `verify:loader` | 真实 Loader + 一次性 `DSH_HOME` 的 `cordis.yml` | 组合本身：行能否解析、注入是否满足、卸载是否干净 |

启动冒烟：

```sh
cd ../deepseek-harness
pnpm dsh web --patch <插件目录>/.dev/cordis.yml
```

`tsconfig.json` 与 `tsconfig.types.json` 里的 `../deepseek-harness/...` 是**开发期约定**：`typecheck`、`test`、`verify:host`、`verify:settings`、`verify:loader` 都需要旁边有一份 harness checkout，换机器要同步调整这些 `paths`。**`npm run build` 与用户安装不受影响**——产物里的 harness 依赖是外部的，由宿主提供。

改动落在哪一层：

| 想做什么 | 改哪 |
| --- | --- |
| 加数据库类型（第三方） | **不要改本仓库**，复制模板出去发包 |
| 加数据库类型（官方/随主包分发） | `dialects/<name>/` + 核心 `cordis.patch.yml`、`dependencies` 各一行 |
| 加工具 | `src/tools.ts`；若需要方言提供底层查询，先在 `DialectCapability` 加能力键，再在方言里实现 |
| 改设置页 | `src/client/`（改完必须 `npm run build`） |
| 改方言 seam 本身 | `src/dialect.ts`（`DatabaseDialect`、注册表、`DialectFacts`） |
| 改组合/配置 | `src/settings.ts` + `src/contract.ts` |

## 已知限制 / 暂未实现

- **随主包分发的方言只有 `dsh-dialect-mysql`**：它和第三方方言形状完全一致，只是被核心的 bundle 层与 `dependencies` 一起带上。PostgreSQL 与 Oracle 都还没有实现——加 PostgreSQL 便宜（`information_schema` 大体可移植、`?`→`$n` 是机械替换），加 Oracle 贵（无 `LIMIT`、无 `information_schema`、SID 与 service name 两种连法、`oracledb` 是重量级原生依赖）。两者都可以照 `dialects/_template` 起手，并参考 `dialects/mysql` 的完整实现
- **打包版 dsh 上的 `dsh plugin add` 安装实测未完成**：声明已补齐，缺真实打包环境验证
- **配置字段是「通用字段 + `extra`」**：Oracle 这类需要 service name 的库可以表达；但 SQLite 这类没有 host/port 概念的库仍会看到多余字段，届时升级为「字段完全由方言声明」（见 [`docs/05_Docs/decisions/`](docs/05_Docs/decisions/)）
- **命名已全中立**：工具名（`db_*`）、设置命名空间（`ds-db`）、路由（`/api/ds-db/*`）、字典命名空间（`settings.db`）、默认凭据引用（`DSH_DB_PASSWORD`）都不含数据库类型字样；带 `MYSQL_*` 的标识符只出现在 `dsh-dialect-mysql` 包内——那是这个方言自己的名字
- **定义式包（Definition）未抽出——有意偏离**：`DatabaseDialect`、只读规则、值投影与注册表定义仍住在 `dsh-ds-db` 内，所以**方言包 peer 依赖的是整个插件**（工具、设置页、客户端都在里面），而不是一份接口契约。这偏离了第一方 `dsh-shell`（定义）/ `dsh-bash-local`（实现）的 Shape。
  取舍理由：目前唯一随包发布的方言是 `dsh-dialect-mysql`，与插件同仓、同版本、同一次提交；拆出第二个发布物会引入独立版本线与构建顺序，而收益（方言包依赖面收窄）在只有一个方言时不成立。
  **触发条件**：出现任何需要**独立发布**的仓外方言时，把 `dialect` / `sql-guard` / `value` / `dialect-audit` 抽成 `dsh-db-dialect-api`，两个消费者改为只依赖它。验收标准：`grep -rn "dsh-ds-db/src" dialects/` 为空，且 `dialects/*/package.json` 不再出现 `dsh-ds-db`。
- **远程调用面走低层通道——有意偏离**：设置页用 `connection.fetch.register` 的自定义路由 + 裸 `fetch`，而不是 Typert `@Remote`（第一方 `file-upload`、`session-log-export` 是同款用法）。原因是**仓外插件无法运行仓内的 typert 生成管线**（需要 `./typert`、`./remote` 产物与 generator 参与构建）。代价是失去生成类型与统一失败词汇，`contract.ts` 里的 wire 形状是手写的——客户端因此必须自己补齐字段（`completeDescriptor`）。**触发条件**：插件进入第一方仓库，或 typert 提供面向仓外插件的生成入口。
- **没有查询结果卡片与调用卡片**：工具结果走通用呈现
- **浏览器半边需要重新构建**：改 `src/client` 后必须 `npm run build`
- 作为仓外插件，它不参与 `deepseek-harness` 仓库的 gate（每文件 100% 覆盖率等）；`typecheck`、`npm test`、`verify:host`、`verify:settings`、`verify:loader` 是本工程自带的检查

## 许可

[MIT](LICENSE) © 2026 苏慕
