# dsh-ds-db

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的 **只读数据库插件**：自带 Web 设置页，给模型暴露只读工具，而**它面向哪种数据库由可插拔的方言（dialect）决定**。官方提供 MySQL 方言（与核心分开安装）；要支持别的数据库，发一个方言包即可，不必改本仓库。

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

**结果在会话里怎么呈现**：`db_query` 与 `db_sample` 画成**结果表**（列名、单元格、服务器报的行数、截断标记、耗时），`db_tables` 与 `db_databases` 画成**清单**（每项一行，带类型/引擎/注释之类的细节）。`db_describe` 与 `db_explain` 保持通用行——它们的价值在文本里，不在表格里。

标题也是人话：知道读了哪张表的（`db_sample`、`db_tables`）显示 `库.表` 或本地化的「表」/「数据库」，裸查询显示「查询结果」——**卡片标题里不会出现 `db_query` 这类 wire 名字**（只有回退的通用行才显示工具名）。还在跑的调用显示它拿到的参数，所以长查询在途时也能看见语句。

卡片画什么，取自 Host 为每次调用持久化的 `presentationMeta`（纯函数、有界，随会话日志一起回放）；客户端**逐字段校验后才画**，读不懂就回退通用行——所以旧版本记录的会话、失败的调用、还在跑的调用、以及嵌套分发的调用，都不会画出半张卡片。

## 组成

核心**不含任何数据库类型**，也不依赖任何一个——它的 `dependencies` 是空的。MySQL 同样是一个方言包，和第三方的形状完全一样：核心与方言是**两个独立安装的 bundle**，装完核心再按需装方言。

```
.
├── package.json            # 根包 = 核心（dsh-ds-db）：dsh.bundle + dsh.client，dependencies 为空
├── pnpm-workspace.yaml     # packages: ['.', 'dialects/*']
├── cordis.patch.yml        # 以 bundle 安装时贡献一行：核心自己（方言行在方言包自己的 patch 里）
├── src/                    # 核心（host 半边 + browser 半边），不含方言
│   ├── index.ts            # host 入口：设置命名空间、方言注册表、工具、两条 API 路由
│   ├── contract.ts         # 两半边共享的常量与类型（不含任何 import）
│   ├── settings.ts         # Schemastery 配置 schema + 组合默认值
│   ├── dialect.ts          # ★ 方言 seam：DatabaseDialect 定义 + 注册表服务
│   ├── dialect-catalog.ts  # 可安装的方言包清单与默认方言名
│   ├── dialect-audit.ts    # ★ 方言契约自检（方言作者用）
│   ├── dialect-api.ts      # ★ 方言作者的公开面，构建为 `dsh-ds-db/dialect-api`
│   ├── connection.ts       # 方言中立的会话运行器（身份换会话、超时、截断、错误包装）
│   ├── sql-guard.ts        # 只读语句判定（词法与禁止项由方言提供）
│   ├── value.ts            # 无损 JSON 投影与单元格读取器
│   ├── tools.ts            # 模型可见工具（方言中立，不含 SQL）
│   ├── card-budget.ts      # 卡片元数据的字节/行/项上限，也是配置 schema 默认值的来源
│   └── client/             # 浏览器半边：设置整页、表单状态机、双语字典、CSS Modules
├── dialects/               # ★ 数据库类型工作区（每个方言都是独立 bundle）
│   ├── mysql/              #   dsh-dialect-mysql：官方方言，自带 dsh.bundle.patch，单独安装
│   │   ├── src/index.ts    #     完整真实实现，写新方言时的参考
│   │   ├── cordis.patch.yml #    它自己那一层：只插 dialect-mysql 一行
│   │   ├── tests/          #     该方言的行为测试
│   │   ├── scripts/build.mjs #   自包含构建（prepare 在仓外副本里也要能跑）
│   │   └── scripts/verify.ts #   契约自检
│   ├── _template/          #   新方言的起手骨架（不是包；含它自己的 patch 与 build）
│   └── README.md           #   工作区说明：怎么加一个方言
├── docs/                   # 需求、设计、API 契约、决策记录
├── scripts/                # 构建、验证与探针脚本
├── lib/                    # 构建产物（npm run build 生成，不入库）：js 由 esbuild 打，types/ 由 tsc 出
├── LICENSE                 # MIT
└── .dev/                   # 开发用临时目录（三个生成的 overlay，不入库）
```

方言另有一个**发布镜像仓**：[`dsh-dialect-mysql`](https://github.com/sumu126/dsh-dialect-mysql)。源始终是本仓的 `dialects/mysql/`（门禁与打包都跑这一份）；镜像的存在只是让别人不装插件仓也能单独装方言。发版时同步，脚本会把镜像的提交标上来源 commit，所以两边不会悄悄漂移——见[发布前清单](#发布前清单)。

## 快速开始（使用者）

### 前置条件

- Node `^22.19 || >=24`
- 一个可访问的数据库；**建议使用只有 `SELECT`（及元数据读取）权限的账号**——这是只读姿态的第三层，见 [只读姿态](#只读姿态的三层)
- 一个 `dsh` 运行环境：源码 checkout（推荐，配合 `--patch`）或已安装的 `dsh` CLI

### 安装与构建

```sh
cd ds-db-plugin
pnpm install --no-frozen-lockfile      # 必须 pnpm：本仓是 pnpm workspace（dialects/* 是成员包）
npm run build                          # 产出 lib/index.js（host）、lib/client.js（浏览器半边）与 lib/types/**（类型声明；旁边没有已构建的 harness 时这一步自动跳过，见「给插件开发者」）
```

> **必须用 pnpm。** 本仓是 pnpm workspace：`pnpm-workspace.yaml` 把 `dialects/*` 声明为成员包，而 `autoInstallPeers: false` 这类开关也只有 pnpm 读。本插件声明的 `@deepseek-ai/*` 全是**宿主运行时提供**的 optional peer，它们没有发布到 npm，包管理器去自动安装只会失败——这条配置就是把这个默认行为关掉。
>
> **本项目不发布到 npm**：核心与方言两个清单都带 `private: true`，`npm publish` 被物理拒绝。发行形态是 **tarball**（`pnpm pack`，见「加载插件」B）或源码 checkout（A）。

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

**这条路径必须用源码启动器（`pnpm dsh`）。** 已安装形态的 CLI（`node apps/cli/lib/bin.js` 或 npm 装的 `dsh`）加载不了 profile 之外的 `file://` 插件行：框架只对位于 `$DSH_HOME/profiles` **之内**的模块做裸包路由，profile 外的插件因此回落到原生解析，找不到宿主提供的 `@deepseek-ai/*`（它们是 optional peer，不在插件自己的 `node_modules` 里）。`pnpm dsh` 之所以可以，是因为它带 tsx，而 tsx 走本仓库 `tsconfig.json` 的 `paths` 把 `@deepseek-ai/*` 指到 harness 源码。失败时是这样：

```
dsh: warning: 1 entry did not activate
ds-db (file:///…/ds-db-plugin/lib/index.js): failed to import
```

用装了 `dsh` 的机器做开发时，走 B（装进 profile），不要指望 `dsh web --patch <checkout 里的插件>`。

**B. 安装进 profile（可安装包形态：两次 add）**

核心与方言是**两个独立的 bundle**，各装一次——核心不需要任何 override，也不会先失败一次：

  ```sh
  pnpm pack --pack-destination .                                   # 核心（根包）
  pnpm pack ./dialects/mysql --pack-destination .                  # 方言包；给目录参数，`--prefix` 不换目录会打出根包
  tar -tzf dsh-dialect-mysql-0.1.0.tgz | head -3                   # 先确认打的是方言包，再拿它去 add
  dsh plugin --profile web add ./dsh-ds-db-0.1.0.tgz               # ① 核心
  dsh plugin --profile web add ./dsh-dialect-mysql-0.1.0.tgz       # ② 方言
  dsh --profile web --dump-config      # 应看到两个独立层：# == dsh-ds-db 与 # == dsh-dialect-mysql
  dsh --profile web
  ```

  **profile 要选带 Web 的那一个**（如 `web`）。`demo` 只有 base 层：工具装得上，但设置页起不来。

  **只装核心是可用状态**：工具照常注册，只是没有可用类型——设置页把已知类型显示为「即将支持」+包名，工具调用返回指明「当前注册了什么」的拒绝。

  **只装方言没有意义**：方言运行时 import 核心的 `dsh-ds-db/dialect-api`，核心不在时该行以 `failed to import` 不激活（启动会明确告警，不影响其它行）——事后补装核心即恢复。

### 设置页

设置 → **数据库管理**。页面管理多条连接：

- 每张卡片一条连接，悬浮抬升；徽标显示类型或「使用中」
- 右上角**新建连接** → 先选数据库类型（已安装的方言可选，未安装的显示「即将支持」及包名）→ 再填该类型的字段
- 卡片操作：**设为使用 / 测试 / 编辑 / 删除**；切换「使用中」后下一次工具调用即生效，不需要重启
- 连接字段留空表示**由所选类型决定**：新建时按方言默认值预填，编辑时保留空值（组合层只写平铺字段得到的那条默认连接，因此也能在页面上改）
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
        # `db_sample` 未指定行数时读几行（也会写进该工具的模型可见描述）
        sampleRows: 5
        # 设置页「即将支持」提示的方言包；留空/不写就用本插件自带的那份清单
        knownDialectPackages:
          - name: clickhouse
            label: ClickHouse
            package: dsh-dialect-clickhouse
        # 一次调用的卡片元数据上限（UTF-8 字节，含卡片自身字段）；触顶就少带几行并标「已截断」
        cardMaxBytes: 16384
        # 表格卡最多带几行、清单卡最多带几项
        cardMaxRows: 50
        cardMaxItems: 100
```

补丁按行整块替换 `config`，覆盖时请写全要保留的键。

方言行也可以带自己的配置——连接池上限是**部署**的取值，不是数据库的：

```yaml
- insert:
    - id: dialect-mysql
      name: 'dsh-dialect-mysql'
      config:
        connectionLimit: 4    # 每个连接保持打开的 socket 数
        queueLimit: 32        # 排队等待的语句数，超出即拒绝
```

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
- **驱动侧的可调参数写成方言自己的 `Config`**：连接池上限这类取值随部署而变，不是数据库的事实——导出 Schemastery schema，在 `apply(ctx, config)` 里读，默认值写进 schema。`dialects/mysql` 的 `connectionLimit` / `queueLimit` 就是例子，配置写在方言行上（见[配置](#配置cordisyml)）
- `configFields` 的值存进连接的 `extra`，设置页会为你的方言渲染这些字段
- 声明 `sample` / `explain` 就必须实现同名方法，否则注册直接抛错

**第 5 步：自检**

```ts
import { auditDialect } from 'dsh-ds-db/dialect-api'

const problems = auditDialect(YOUR_DIALECT)   // 空数组 = 通过
```

方言要的东西——`DatabaseDialect` 及其行类型、只读判定的 `scanStatement` / `SHARED_FORBIDDEN` / `ReadOnlyRules`、值读取器 `cell*`、以及自检的 `auditDialect`——都从 **`dsh-ds-db/dialect-api`** 这一个入口取。它是**构建产物**（`lib/dialect-api.js`），因为安装形态的 `dsh` 只加载已构建的 JavaScript、没有 TypeScript 加载器：`dsh-ds-db/src/*.ts` 那条路径只在源码 checkout 下成立，装出来的包会在启动时报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，方言行直接挂不上。构建脚本会拒收任何残留 `.ts` 导入的产物。

这个入口**带类型声明**：`npm run build` 的 `build:types` 步骤用 `tsc -p tsconfig.emit.json` 把 `src/` 的声明出到 `lib/types/`，`exports` 的每个入口都带 `types` 条件（`./dialect-api` → `lib/types/dialect-api.d.ts`）。所以仓外方言包在 `strict` 下直接拿到 `DatabaseDialect` 等类型，不必去够本仓的 TypeScript 源码——那正是只有本仓方言（靠 `tsconfig` 的 `paths`）才能做到的事。类型声明是**开发态增益**：`tsconfig.emit.json` 的 `paths` 指向旁边的 harness checkout，从 git 安装本仓库的机器没有这一份，`scripts/build-types.mjs` 检测到后就跳过这一步（打一行 `skipping type declarations…`），其余 esbuild 步骤把 `@deepseek-ai/*` 全部 external，不依赖类型解析——所以 `prepare`/`prepack` 在无 harness 的机器上照样成功。

覆盖：只读判定（含「字面量/注释里的分号」这类绕过）、行数上界、标识符引用、各元数据投影、能力与实现一致性、字段默认值类型。**不需要数据库服务**。

### 从模板开始

一个起点，两种去向：

```sh
# 复制骨架
cp -r dialects/_template <你的方言目录>

# A. 留在本仓 dialects/ 下开发（官方/合作方言）
mv <你的方言目录> dialects/clickhouse && cd dialects/clickhouse && npm run verify

# B. 或复制出去建独立仓分发
cd <你的方言目录> && git init && npm run verify
# 分发两条路都行：交付 tarball（装的人 dsh plugin add <你打的 tgz>），或发布到 registry 供他人按包名安装
```

骨架里每个 `TODO` 都标了要改的位置；动手前建议先读 [`dialects/mysql/src/index.ts`](dialects/mysql/src/index.ts)——那是**完整真实的参考实现**，包括驱动接入、`information_schema` 元数据 SQL、只读规则与投影。

它也是「能力缺失如何降级」的参照：方言不声明自己没有的能力（MySQL 全声明，PostgreSQL 类没有 `SHOW CREATE TABLE` 的话就不声明 `createStatement`），工具会自行降级而不是报错。

### 在仓内加方言要不要改核心？

**不用。** 方言行住在方言包自己的 patch 里，核心不引用任何方言（它的 `dependencies` 是空的）——仓内方言与仓外方言在这一层完全同形，区别只是你的目录在 `dialects/` 下、由本仓一起打包。放下一个目录、`pnpm install` 让它成为 workspace 成员、并在它的清单里把 `dsh.bundle.patch` 指向自己的 patch，就完事了。

### 常见坑

| 现象 | 原因 |
| --- | --- |
| `npm install` 装出一堆 `@deepseek-ai/*`，或 workspace 相关报错 | 本仓是 pnpm workspace（`dialects/*` 是成员包），`autoInstallPeers: false` 这类开关只有 pnpm 读 |
| 装了方言，启动却报 `dialect-mysql (dsh-dialect-mysql): failed to import` | 方言运行时 import 核心的 `dsh-ds-db/dialect-api`，而核心没装或没激活。先装核心 |
| `pnpm install` 一直重试解析 `@deepseek-ai/dsh-*` | 那些是宿主提供的 optional peer，仓库已用 `autoInstallPeers: false` 关掉自动安装；仍出现说明你不在本仓库根目录 |
| 调用报「dialect X is not registered」 | 你的包没被加载；用 `dsh --dump-config` 确认那一层在 |
| 工具描述里还是旧的自称 | 已知行为：描述注册时写定，重载后更新；**调用不受影响** |
| 设置页没出现我的类型 | 页面从 `GET /api/ds-db/dialects` 读注册表；确认你的方言注册成功 |
| 我声明了 `sample`，却没有 `db_sample` 工具 | 工具按**活动连接的方言**描述。活动连接指向的方言尚未注册时（或超过 `dialectWaitMs` 才注册），描述来自拒绝桩，两个可选工具就不注册——重载插件即可 |
| 改了浏览器侧内容没生效 | 浏览器半边是构建产物，必须重新 build |

## 十分钟上手

```sh
git clone https://github.com/sumu126/ds-db-plugin.git
cd ds-db-plugin
# 同级目录需要一份 harness checkout（tsconfig 的 paths 指向 ../deepseek-harness）
pnpm install --no-frozen-lockfile
node -v                                  # 需要 22.x
pnpm run typecheck && pnpm test
pnpm run verify:host && pnpm run verify:cards
```

**Node 22 是硬要求**：`Promise.withResolvers`、`node:zlib` 的 zstd、`--experimental-strip-types` 都在用；低于 22 会直接报错而不是降级。

**harness 版本前提**：本工程验证于 `deepseek-harness` @ `ddefc45`（`0.1.6-alpha.2`），且那份 checkout 里 `packages/core/tools/src/index.ts` 带一处**有意的一行改动**——`Symbol('@deepseek-ai/dsh-tools.scheduler')` 改为 `Symbol.for(...)`，让同一进程里两份 `dsh-tools` 共享同一个调度器符号（仓外插件在开发态与安装态正是这种情况）。harness 的 API 是 pre-stable：**换版本、或去掉这一行之后，请重跑上表与下表全部检查**。

| 检查 | 前置 | 新人能直接跑吗 |
| --- | --- | --- |
| `typecheck` / `test`（24 例） | 兄弟 `../deepseek-harness` | ✅ |
| `verify:host` / `verify:cards` | 同上 | ✅ |
| `verify:settings` | 同上；读**你自己**的 `~/.dsh/settings.yaml` | ✅（空文档时回落到工具自身计数，不会假红） |
| `verify:loader` | 同上；自带一次性 `DSH_HOME` | ✅ |
| `card:live` | **你自己的会话日志路径** | ❌ 不属于上手路径 |
| `db:live` | **你自己的连接名 + 凭据** | ❌ 同上 |
| `scripts/web-probe.mjs` | 先 `pnpm run build`，再用源码启动器在 3099 起一个服务器 | ❌ 同上 |
| `scripts/install-probe.mjs` | 先把插件装进一个 profile | ❌ 同上 |

两条手工检查和两个探针都要显式传你自己环境的东西、或先备好一个运行中的服务器 / 已安装的 profile，所以它们不是上手路径的一部分——它们是**你改完东西之后的回归工具**。

## 给插件开发者：本地开发

```sh
pnpm install --no-frozen-lockfile   # 必须 pnpm，见上
npm run typecheck         # 核心 + 各方言包（harness 依赖按其 .d.ts 解析）
npm test                  # 方言包的行为测试与契约审计（24 例）
npm run verify:host       # 挂真实 ToolRuntime：方言以独立插件挂载后跑通全部断言
npm run verify:settings   # 挂真实设置服务：工具读到的是用户保存的文档，而非组合兜底
npm run verify:loader     # 经 Loader + 真实 cordis.yml 组装：加载、注入、卸载
npm run verify:cards      # 两端往返：Host 写的会话卡片，客户端读回同一张
npm run verify:client     # 真的跑一遍浏览器半边：apply 注册了什么、卸载是否收干净
npm run build             # 类型声明 + 核心 + 浏览器半边 + 每个方言包
npm run overlay           # 生成三个 overlay：.dev/cordis.yml、.dev/built.yml、.dev/install-probe.yml
```

`npm run overlay` 写三个 overlay（行里是本机绝对路径，所以生成而不入库）：`.dev/cordis.yml` 挂**源码**两行（日常开发），`.dev/built.yml` 挂**构建产物**两行（`pnpm run build` 之后，看真实产物的行为），`.dev/install-probe.yml` 只挂一个探针行（见下）。从 harness checkout 启动：

```sh
pnpm dsh --profile web --patch <插件目录>/.dev/cordis.yml --port 3099 --no-open
```

**必须用源码启动器 `pnpm dsh`**：已安装的 `dsh` 加载不了 profile 之外的 `file://` 行（原因见「加载插件」一节），会报 `failed to import`。

四道 `verify` 各自覆盖不同的一半，缺一道就有一类错误能长期隐身（`verify:client` 是第五道，覆盖浏览器半边自身的注册与卸载）：

| 检查 | 挂什么 | 抓什么 |
| --- | --- | --- |
| `verify:host` | 真实 ToolRuntime，**无**设置服务 | 工具注册、描述与拒绝文本、能力降级、多连接寻址、取消、输出 schema 与卡片元数据 |
| `verify:settings` | + 真实设置服务与 `~/.dsh/settings.yaml` | 工具读到的是**用户文档**而不是组合兜底 |
| `verify:loader` | 真实 Loader + 一次性 `DSH_HOME` 的 `cordis.yml` | 组合本身：行能否解析、注入是否满足、**插件行 fiber 卸载后工具消失而注册表仍在** |
| `verify:cards` | Host + **浏览器半边**的卡片模型（Node 即可，无 DOM） | 两端往返：Host 写的元数据，客户端读回同一张卡片；畸形元数据一律回退 |
| `verify:client` | **浏览器半边的 `apply`**（Node 双替掉它 inject 的五个服务） | 注册面本身：两份字典、`settings.section` 与四个 `tool.call.toolview` 席位、注入面、以及**卸载后是否收干净**（HMR 的前提） |

另有两个**人工回归工具**，故意不叫 `verify:`（不进 gate、不进 CI）：

```sh
npm run card:live -- <会话日志路径>            # 读已记录的会话，量其中持久化的卡片
npm run db:live -- "<连接名>" ["<另一个连接>"]  # 打真库，跑插件的只读工具
```

**`card:live`** 读一份真实会话日志（多帧 zstd，按帧解压），把里面**持久化的卡片**逐条用客户端模型读回并量字节——这是唯一能看到预算在真实数据上如何表现的场合（中文三字节、超宽单元格、DECIMAL/BIGINT 字符串）。它只断言「每个工具**最新**一张卡在预算内」（新写的才代表当前代码），更早的卡片是历史版本写的，只报告不判失败。会话日志是用户数据，所以路径必须显式传。

**`db:live`** 把插件放到真服务器面前，这是其它检查做不到的：`verify:host` 连的是不可达端口，`verify:cards` 喂的是手写值，所以两处承重假设——结果行是「列名 → 值」的对象、声明了的能力真的能答——此前只被读代码确认过。它用真设置文档 + 真凭据存储，断言：行形状、跨来源一致（`db_tables` 对 `SHOW FULL TABLES`、`db_databases` 对 `SHOW DATABASES`）、卡片与同一次调用的规范值逐格一致、`db_explain` 给出非空计划、**取消之后下一次调用仍能成功**、以及超时真的会掐断语句。

约束：只走插件的只读工具；连接名必须显式给，未知名字响亮失败（exit 2 并列出可用的）；**不断言业务数据**——活表的行数会变，只断言形状、跨来源一致性与自洽。

另有两个**探针**，覆盖前四道 `verify` 都够不到的两段交付链路（同样不进 gate）：

```sh
# 客户端半边：证明 boot 清单里有这个客户端行、registry 服务的确实是构建产物、
# 产物符合 lazy-CJS 契约、物化时导出 apply/inject 并注入 CSS、探针路由不是 404
pnpm run build && node scripts/dev-overlay.mjs
pnpm dsh --profile web --patch <插件目录>/.dev/built.yml --port 3099 --no-open   # 记下打印出的 token
node scripts/web-probe.mjs http://127.0.0.1:3099 <token>

# 已安装形态：报告装出来的那一版究竟注册了什么，然后自行退出
dsh --profile <name> --patch <插件目录>/.dev/install-probe.yml
```

**`scripts/web-probe.mjs`** 读启动清单后，按模块表契约在 Node 里把浏览器半边**物化**一遍（stub `window.__ModuleLoader__` + 只含基线模块的 require）。它证明的是"产物能到达页面并被正确物化"，**不能**证明 React 画得对不对——那必须用浏览器看（见下）。
**`scripts/install-probe.mjs`** 只报事实（`dialects=["mysql"] tools=[...]`）并以退出码表态，用来验证**装出来的那一版**，而不是源码。

启动冒烟：

```sh
cd ../deepseek-harness
pnpm dsh web --patch <插件目录>/.dev/cordis.yml
```

`tsconfig.json` 与 `tsconfig.types.json` 里的 `../deepseek-harness/...` 是**开发期约定**：`typecheck`、`test`、`verify:host`、`verify:settings`、`verify:loader`、`verify:cards` 都需要旁边有一份 harness checkout，换机器要同步调整这些 `paths`。**`npm run build` 与用户安装不受影响**——产物里的 harness 依赖是外部的，由宿主提供；唯一吃这份约定的是 `build:types`（类型声明），它由 `scripts/build-types.mjs` 守卫：旁边没有已构建的 harness 就跳过并打一行提示，构建照常成功。

### 发布前清单

```sh
pnpm install --frozen-lockfile        # lockfile 必须与 package.json 一致
pnpm run typecheck && pnpm test
pnpm run verify:host && pnpm run verify:settings && pnpm run verify:loader && pnpm run verify:cards
pnpm pack --pack-destination .                   # 核心
pnpm pack ./dialects/mysql --pack-destination .  # 方言包给目录参数；`--prefix` 不换目录，会打出根包
# 落点显式给出，下一行的相对路径才是确定的（两行都支持 --pack-destination）
tar -tzf dsh-dialect-mysql-0.1.0.tgz | head -3   # 先确认打的是方言包，别拿根包去 add
dsh plugin --profile web add ./dsh-ds-db-0.1.0.tgz          # ① 核心
dsh plugin --profile web add ./dsh-dialect-mysql-0.1.0.tgz  # ② 方言
dsh --profile web --dump-config | grep -E 'dsh-ds-db|dsh-dialect-mysql'   # 两个独立层都在
dsh --profile web                     # 起得来、无 FAILED fiber、模型侧能看到 db_connections
# 顺手在装出来的那一版上跑 db:live / card:live —— 别人替代不了这条验据
git tag v0.1.0                        # 只有上面全绿才打
# 方言的发布镜像跟着这一版走：同步 + 打 v<version> + 推（镜像仓的本地检出路径作为参数）
pnpm run sync:dialect -- <镜像检出> --tag --push
```

`sync:dialect` 按 `git ls-files dialects/mysql` 取内容，删掉镜像里多出来的文件（镜像自己的 `.gitignore` 除外），并把来源 commit 写进提交信息；**源侧有未提交改动会被拒绝**（否则镜像会声称自己来自一个并不包含这些内容的 commit）。不带 `--tag` / `--push` 就只在镜像里本地提交；tag 推送不加 `--force`——移动一个已发布的 tag 该由人决定。

`--frozen-lockfile` 只说"此刻一致"，不说"真的重生成了"。三条判据一起看才分得清：

```sh
Select-String -Path pnpm-lock.yaml -Pattern '^  (\.|dialects/mysql):'      # 两个 importer
Select-String -Path pnpm-lock.yaml -Pattern 'clsx|autoInstallPeers'         # clsx 出现；autoInstallPeers 翻成 false
pnpm install --frozen-lockfile                                             # 一致
```

后两条与 importer 数量无关，所以它们能和第一条交叉验证——**单一判据容易被同源的东西喂饱**，这正是这几轮反复踩的那个坑。

几条从**产物反推**的习惯（方言包的三处问题——无 `files` 白名单、缺 `LICENSE`、缺 `README`——都是这么发现的；第四处见第二条）：

- **打包后先 `tar -tzf` 看清单，再看 npm 页面。** `README` 是唯一 `files` 白名单管不住的东西（npm 总是包含它），所以"加了白名单就干净了"是错的。
- **清单里的每条命令都要按原文跑过一次。** 第四处就是这么发现的：`npm --prefix dialects/mysql pack` **不会**换目录，打出来的是根包 `dsh-ds-db-0.1.0.tgz`，于是下一行的 `add ./dsh-dialect-mysql-0.1.0.tgz` 必然 file-not-found——这条命令在写进清单时从未被执行过。现在改成 `npm pack ./dialects/mysql`，并在 `add` 之前加一道 `tar -tzf` 确认打的是哪个包。
- **`pack` 必须排在所有会进包的改动之后。** 「`tag` 在最后」只防 tag 与产物漂移，不防"pack 之后又改了包内文件"——曾经出现过 pack 在 19:00、19:08 又提交了 README 的情况，那份快照里装的就是旧清单。
- **再查一次时间轴：包里那份 `lib/` 是不是当前源码构建的。** 内容对了，产物仍可能是旧**行为**。分两层，都要看，而且都只看时间戳、没有文本管线的风险：

  ```sh
  git status --porcelain                                          # 必须为空
  git log -1 --format='%ad' --date=format:'%m-%d %H:%M' -- src dialects/mysql/src
  ls -l --time-style=+%m-%d\ %H:%M lib/*.js dialects/mysql/lib/*.js *.tgz
  ```

  1. **`lib/` 的 mtime ≥ `src/` 的 mtime** —— 产物是基于当前源码构建的。这是 `prepack` 在起作用（两个包都声明了它）；若 `lib/` 比 `src/` 旧，说明有人绕过了 `prepack` 手工打包。
  2. **工作区干净 + `src` 的最后提交 ≤ `tgz` 的 mtime** —— 产物包含了最新提交。`git log` 给的是最后一次**提交**时间，工作区若有未提交的 src 改动，它代表不了源码的实际状态，判据会假阴性。

  一条经验读数：**`lib/` 的 mtime 应当与 `tgz` 同分钟**（`prepack` 在打包时重建）。不同分钟不等于内容不同，但它意味着那次打包**没有走 `prepack`**——方言包正是因为缺 `prepack` 才被这一条抓出来的。

  文档漂移只让人看到旧清单，**源码与产物时间倒挂会把旧行为直接发出去**。

第一条不是形式主义：这个仓库的 `pnpm-lock.yaml` **曾经在主分支上腐烂了十几个提交**——它的根 importer 还停在"依赖只有 mysql2"的形态，`dialects/mysql` 这个 workspace 成员从未出现在里面。原因是本仓的 pnpm 路径长期没被走通（一直在用 `npm install --legacy-peer-deps` 绕），于是同时掩盖了两件事：pnpm 会自动安装缺失的 peer（而本插件的 peer 全是宿主提供、未发布的包），以及 lockfile 早已过期。两笔账在依赖改用只有 pnpm 才能正确处理的形态那一刻同时到期。所以：**lockfile 要么被 gate，要么删掉——一个说谎的 lockfile 比没有更糟**。这里选 gate，就是这第一条。

改动落在哪一层：

| 想做什么 | 改哪 |
| --- | --- |
| 加数据库类型（第三方） | **不要改本仓库**，复制模板出去发包 |
| 加数据库类型（随本仓一起分发） | `dialects/<name>/`（自带 `dsh.bundle.patch`）；核心一行都不用动 |
| 加工具 | `src/tools.ts`；若需要方言提供底层查询，先在 `DialectCapability` 加能力键，再在方言里实现 |
| 改设置页 | `src/client/`（改完必须 `npm run build`） |
| 改方言 seam 本身 | `src/dialect.ts`（`DatabaseDialect`、注册表、`DialectFacts`） |
| 改组合/配置 | `src/settings.ts` + `src/contract.ts` |

## 已知限制 / 暂未实现

- **破坏性变更：多连接改造之前的用户文档不再被读取**。设置页保存的连接从「平铺字段」改成了 `connections[]`，旧文档里的 `ds-db.host` / `port` / `user` 等键不在当前 schema 内，会被静默丢弃，工具回落到组合层的默认连接（`127.0.0.1:3306`），需要在新设置页重录一条。这是有意接受的取舍：改造当时两个包都未发布（`npm view dsh-ds-db` / `dsh-dialect-mysql` 均 404），不存在持有旧文档的外部用户，为不存在的安装基础永久保留一条兼容读取路径不划算。组合层（`cordis.yml`）的平铺字段**不受影响**，仍然兼容。
- **只有 MySQL 一个方言包**：它和第三方方言形状完全一致——自带 `dsh.bundle.patch`，作为独立 bundle 单独安装，核心不引用它。PostgreSQL 与 Oracle 都还没有实现——加 PostgreSQL 便宜（`information_schema` 大体可移植、`?`→`$n` 是机械替换），加 Oracle 贵（无 `LIMIT`、无 `information_schema`、SID 与 service name 两种连法、`oracledb` 是重量级原生依赖）。两者都可以照 `dialects/_template` 起手，并参考 `dialects/mysql` 的完整实现
- **发行形态是 tarball，不发布到 npm——安装固定走 A/B**：两个清单都带 `private: true`，`npm publish` 被物理拒绝。核心与方言是**两个独立 bundle**，各装一次（见「加载插件」B 节）；核心零依赖，因此不需要任何 override，也不会先以 404 失败一次。tarball 形态**已实测**：核心单独装 exit 0；补装方言后 `--dump-config` 出现 `# == dsh-ds-db` 与 `# == dsh-dialect-mysql` 两个独立层，启动后 `install-probe` 报 `dialects=["mysql"]` 与四个工具；只装核心时 `dialects=[]` 而四个工具仍注册。**git-URL 安装（`dsh plugin add github:…`）在这一形态下未验证**：核心已自包含（零 `dependencies`，`prepare` 也不再依赖旁边的 harness checkout），原先那道障碍不再存在，但本仓没有对这条路径做过端到端复验，所以不写进安装说明
- **配置字段是「通用字段 + `extra`」**：Oracle 这类需要 service name 的库可以表达；但 SQLite 这类没有 host/port 概念的库仍会看到多余字段，届时升级为「字段完全由方言声明」（见 [`docs/05_Docs/decisions/`](docs/05_Docs/decisions/)）
- **命名已全中立**：工具名（`db_*`）、设置命名空间（`ds-db`）、路由（`/api/ds-db/*`）、字典命名空间（`settings.db`）、默认凭据引用（`DSH_DB_PASSWORD`）都不含数据库类型字样；带 `MYSQL_*` 的标识符只出现在 `dsh-dialect-mysql` 包内——那是这个方言自己的名字
- **定义式包（Definition）未抽出——有意偏离**：`DatabaseDialect`、只读规则、值投影与注册表定义仍住在 `dsh-ds-db` 内，所以**方言包 peer 依赖的是整个插件**（工具、设置页、客户端都在里面），而不是一份接口契约。这偏离了第一方 `dsh-shell`（定义）/ `dsh-bash-local`（实现）的 Shape。
  取舍理由：目前唯一的官方方言是 `dsh-dialect-mysql`——与本插件同仓、同版本、同一次提交（作为独立 bundle 打包；另有一个发布镜像仓，但源在本仓，见[组成](#组成)）；拆出第二个发布物会引入独立版本线与构建顺序，而收益（方言包依赖面收窄）在只有一个方言时不成立。
  **触发条件**：出现任何需要**独立发布**的仓外方言时，把 `dialect` / `sql-guard` / `value` / `dialect-audit` 抽成 `dsh-db-dialect-api`，两个消费者改为只依赖它。其中**「方言不再够到 TypeScript 源码」这一半已完成**：`dsh-ds-db/dialect-api` 是构建产物，方言只依赖它（`grep -rn "dsh-ds-db/src" dialects/` 已为空）。剩下的是包级依赖面——方言仍 peer 整个插件包。验收标准：`dialects/*/package.json` 不再出现 `dsh-ds-db`。
- **远程调用面走低层通道——有意偏离**：设置页用 `connection.fetch.register` 的自定义路由 + 裸 `fetch`，而不是 Typert `@Remote`（第一方 `file-upload`、`session-log-export` 是同款用法）。原因是**仓外插件无法运行仓内的 typert 生成管线**（需要 `./typert`、`./remote` 产物与 generator 参与构建）。代价是失去生成类型与统一失败词汇，`contract.ts` 里的 wire 形状是手写的——客户端因此必须自己补齐字段（`completeDescriptor`）。**触发条件**：插件进入第一方仓库，或 typert 提供面向仓外插件的生成入口。
- **MySQL 上的取消是「退役会话」而非「中断语句」**：mysql2 的 Promise pool 没有 `destroy()`、只有 `end()`，所以中止一次调用会让池关闭、而 `COM_QUIT` 排在正在执行的语句之后——**服务端那条语句会跑完**；随后该会话被淘汰、下一次调用重建连接。要真正中断需要方言自己持有单条连接（`pool.getConnection()` → `conn.query()` → abort 时 `conn.destroy()`）
- **卡片只覆盖四个工具**：`db_describe` 与 `db_explain` 走通用行（有意——收益低，而认领一个 wire 工具名就接管那个调用的全部状态）。要加，给工具加 `presentationMeta` 并在 `src/client/DbToolRows.tsx` 认领 key，两处都要动
- **卡片认领即接管**：`tool.call.toolview` 是 keyed slot，注册 `db_query` 就接管该工具的**所有**状态渲染，包括还在跑、失败、嵌套分发——所以视图必须有回退分支（现在的四个都有）
- **宽单元格会被裁到 320px**：列宽固定是「一列不要吃掉整屏」的取舍，代价是超过 320px 的单元格显示省略号——单个值的完整内容靠 hover（原生 tooltip）。整张卡被截断时（有 `已截断` 标记）卡片下方另有「显示完整结果」，展开的是这次调用的**结果全文**（取自会话记录，不必重新查库）
- **数字列看起来是文本**：mysql2 对 BIGINT / DECIMAL 的默认映射就是字符串，卡片忠实呈现——`id` 是 `"156"`、`price` 是 `"45.00"`、且左对齐。要做数字右对齐就得往卡片元数据里加「列类型」，那会撑大本来就有上限的元数据，收益不值，记在这里当已知取舍
- **二进制单元格预览固定 256 字节，不可配置**：`src/value.ts` 的 `BINARY_PREVIEW_BYTES` 决定 BLOB/BINARY 单元格渲染成多长的十六进制预览。按插件的配置约定（「随部署而变的取值必须是配置字段」）它本可以做成 `Config` 字段，但它是**表示层界限**而非部署取值——与上面那条 320px 列宽同类，因此**有意不做成配置**。读到的是预览，完整内容要靠 `db_query` 取该列原文
- **卡片元数据按 UTF-8 字节计量**（16 KB，含卡片自身的字段）：触顶就少带几行并标 `已截断`，行数与条目数另有 50 / 100 的上限。中文一字三字节，所以行数上限与字节上限通常由后者先触发。三条上限都随行配置走（`cardMaxBytes` / `cardMaxRows` / `cardMaxItems`），`src/card-budget.ts` 里的常量就是 schema 默认值的来源
- **嵌套 / PTC 分发态未经真机验证**：本地工具集里没有 `run_code`，造不出嵌套调用。它由两道保证兜着——`dbCardModel` 在 `parentCallId` 有值时直接返回 `null`（嵌套调用拿不到 meta，核心只对顶层调用持久化 `presentationMeta`），这与第一方 search 卡片是同款实现。将来若拿到 PTC 环境，验收就是看嵌套的 `db_query` 是否落在通用行
- **浏览器半边需要重新构建**：改 `src/client` 后必须 `npm run build`
- **React 渲染没有自动测试**：`verify:cards` 覆盖的是客户端**卡片模型**（纯 Node、无 DOM），`verify:client` 覆盖的是浏览器半边 `apply` 的**注册与卸载**（同样无 DOM、无渲染）。设置页、四张卡片、弹窗的**渲染行为**仍没有自动化断言。改 `src/client/**` 之后请用浏览器过一遍：设置页的新建/编辑/测试连接、`db_query` 的结果表、`db_tables`/`db_databases` 的清单、截断时的「显示完整结果」、以及中英切换后的耗时文案
- 作为仓外插件，它不参与 `deepseek-harness` 仓库的 gate（每文件 100% 覆盖率等）；`typecheck`、`npm test`、`verify:host`、`verify:settings`、`verify:loader`、`verify:cards` 是本工程自带的检查

## 许可

[MIT](LICENSE) © 2026 苏慕
