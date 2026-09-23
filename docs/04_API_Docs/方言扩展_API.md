# 方言扩展 API（方言作者契约）

> 面向**第三方开发者**：实现下列接口并发布一个包，即可为 dsh 增加一种数据库类型，无需修改 `dsh-ds-db` 仓库。
> 现状说明：以下契约**均已实现**（2026-09-22）。起手用 [`dialects/_template`](../../dialects/_template/README.md)，参考实现看 [`dialects/mysql/src/index.ts`](../../dialects/mysql/src/index.ts)。

## 1. 最小可运行包

```
dsh-dialect-postgres/
├── package.json
└── src/index.ts
```

`package.json`：

```json
{
  "name": "dsh-dialect-postgres",
  "type": "module",
  "main": "lib/index.js",
  "peerDependencies": { "dsh-ds-db": ">=0.2.0" },
  "dependencies": { "pg": "^8.13.0" }
}
```

`src/index.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-dialect-postgres'
export const inject = ['databaseDialects']   // 注册表由 dsh-ds-db 提供

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.databaseDialects.register(PG_DIALECT), 'postgres dialect')
}
```

注册是 effect：返回值即 disposer，插件卸载时方言自动摘除。同名重复注册会抛错。

安装：

```sh
dsh plugin --profile web add ./dsh-dialect-postgres
```

## 2. `DatabaseDialect` 接口（必须全部实现）

定义于 `dsh-ds-db/src/dialect.ts`。

### 2.1 身份与文案

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | 注册表键，配置里 `dialect: postgres` 引用它 |
| `label` | `string` | 模型可见的自称，如 `PostgreSQL` |
| `description` | `string`（可选） | 一句自述，设置页的类型卡片显示它 |
| `connectionDefaults` | `ConnectionDefaults`（可选） | 你的库的 `host`/`port`/`user`/`database`/`passwordEnv` 默认值；页面用它预填新连接，连接上留空的字段也回落到它 |
| `systemDatabases` | `readonly string[]` | `db_databases` 默认隐藏的系统库 |
| `rowBoundHint` | `string` | 告诉模型该库怎么限制行数，如 `LIMIT` / `FETCH FIRST` |
| `capabilities` | `ReadonlySet<DialectCapability>` | 本方言真正提供的能力 |
| `configFields` | `readonly DialectConfigField[]` | 额外连接字段声明 |
| `sample?` / `explain?` | 可选方法 | 声明 `sample`/`explain` 能力时必须实现 |

### 2.2 只读规则（安全红线）

```ts
readonly rules: ReadOnlyRules
```

`ReadOnlyRules` 由 `sql-guard.ts` 消费，包含：

- `lexical.quotes`：字符串/标识符的引号字符与是否支持反斜杠转义
- `lexical.lineComments`：行注释标记，及标记后是否必须跟空白（MySQL 的 `--` 需要，标准 SQL 不需要）
- `lead`：放行语句族的锚定正则
- `families`：拒绝文案里列出的语句族
- `forbidden`：看着只读、实则会写或加锁的构造（`FOR UPDATE` 等是各方言共用的 `SHARED_FORBIDDEN`）

**判定顺序**：先做词法掩码（字符串清空、注释剔除）→ 再匹配 `lead` 与 `forbidden`。因此字面量或注释里的分号、关键字不参与判定。

### 2.3 会话与语法

```ts
open(connection: DatabaseConnection): Promise<DialectSession>
applyRowLimit(statement: string, maxRows: number): string
quoteIdentifier(name: string): string
```

- `open` 返回的 `DialectSession` 需实现 `run(statement)`（返回 `{ rows, columns }`）与 `close()`
- 可选 `usable?(): boolean`：一次调用结束后由运行器询问「这个会话还能用吗」；不实现则视为可用
- `applyRowLimit` 必须保证「忘记写上限也不会把整表灌进模型上下文」：MySQL 追加 `LIMIT n+1`，PG 用 `FETCH FIRST n+1`
- 连接身份变化或插件卸载时，会话运行器会调用 `close()`；`close()` 的失败由运行器兜住，不得阻塞卸载。`close()` 应当幂等——取消与淘汰可能都来关它

**取消语义：能中断就中断，不能就退役并如实声明**

`DialectStatement.signal` 由工具层透传，方言按自己驱动的能力处理，两种结果差别很大：

| 驱动能力 | 做法 | 结果 |
| --- | --- | --- |
| 接受 `AbortSignal` | 转发给驱动 | 语句被中断，调用以取消失败，会话仍可用 |
| 只能退役会话 | 结束池 / 断开连接 | **服务端那条语句会跑完**；调用可能以取消失败，也可能返回已取回的行；会话随后不可用 |

第二种正是 MySQL 的形状：mysql2 的 Promise pool 没有 `destroy()`、只有 `end()`，而 `end()` 把 `COM_QUIT` 排在正在执行的语句**之后**。因此：

- 用第二种做法就**必须**实现 `usable()`（不再可用即返回 `false`）。否则运行器不知道该淘汰它，那条连接会在本插件重载前**每一次调用都失败**，报错只有驱动的 "pool is closed"，没有任何线索指向真因
- 运行器在**成功路径**与失败路径都会淘汰：被取消过、或 `usable()` 为 `false` 的会话一律丢弃，下一次调用重建
- 想真正中断，方言要自己持有单条连接（`pool.getConnection()` → `conn.query()` → abort 时 `conn.destroy()`），而不是用池的高层 API

### 2.4 元数据查询

```ts
databases(): DialectQuery<DialectDatabaseRow>
tables(database: string): DialectQuery<DialectTableRow>
columns(database: string, table: string): DialectQuery<DialectColumnRow>
indexes(database: string, table: string): DialectQuery<DialectIndexRow>
createStatement(database: string, table: string): DialectQuery<string>
version(): DialectQuery<string>
```

`DialectQuery<R>` = `{ statement: DialectStatement, project: (row: DbRow) => R }`。

**关键点**：列名是方言自己的，`project` 负责把驱动行投影成上表约定的形状，工具层永远不读列名。不支持的能力 **[M2]** 之后可在 `capabilities` 里声明缺失，届时无需伪造 SQL；当前版本仍需实现（可返回空查询）。

### 2.5 连接入参

`open` 收到的 `DatabaseConnection`：`host / port / user / password / database? / connectTimeoutMs / queryTimeoutMs / maxRows`。
`database` 缺失表示用户没配默认库，此时工具调用必须显式带库名。**[M3]** 之后方言声明的额外字段从 `extra` 读取。

### 2.6 值投影

`toJsonRow()` 统一把 `Date` → ISO 字符串、`bigint`/`DECIMAL` → 字符串、`Buffer` → 有上界的十六进制预览。方言的 `project` 只需处理列名映射，不必关心类型投影。

## 3. 能力声明

```ts
export type DialectCapability =
  | 'databases' | 'tables' | 'columns' | 'indexes' | 'createStatement'
  | 'estimatedRows' | 'charset' | 'version' | 'sample' | 'explain'
```

缺失时工具的行为（契约的一部分，不是异常）：

| 缺失能力 | 行为 |
| --- | --- |
| `createStatement` | `db_describe` 省略 `createStatement` |
| `indexes` | `db_describe` 的 `indexes` 为空数组 |
| `estimatedRows` | `db_tables` 该项为 `null` |
| `charset` | `db_databases` 的 charset/collation 为空串 |
| `databases` / `tables` / `columns` | 对应工具直接拒绝并说明该方言不支持 |

未知能力键在注册时抛错。

## 4. 配置字段 **[M3]**

```ts
export interface DialectConfigField {
  key: string
  kind: 'text' | 'number' | 'secret-ref'
  default: string | number
  required: boolean
  hint?: string
  sensitive?: boolean
}
```

值落在连接的 `extra` 里。例如 Oracle 的 service name：

```ts
configFields: [{ key: 'serviceName', kind: 'text', default: 'ORCL', required: true }]
```

**文案**：`label` 与 `hint` 都是**方言自带的文本**，页面直接显示——插件字典不可能为每种方言的每个字段备一句话。省略 `hint` 时页面回退到通用提示（必填 / 可留空）。

## 5. 已知行为（不是 bug）

1. **描述滞后**：工具描述在注册时写定。你的方言若在 `dsh-ds-db` 之后注册，**调用立即生效，但工具描述里的自称要等插件重载后才更新**。
2. **方言名未注册时首次调用才报错**：注册表由本插件提供，加载期无法知道最终集合，因此错误会列出已注册的方言。
3. **浏览器半边是构建产物**：若你的方言包带客户端内容，改完必须重新构建，`lib/client.js` 才会被扫描。

## 6. 自检清单（发包前）

- [ ] `rules.lead` 只放行只读语句族，且 `forbidden` 覆盖该库的写/加锁写法
- [ ] 字面量与注释里的分号、关键字无法绕过判定（用 `assertReadOnlyStatement` 验证）
- [ ] `applyRowLimit` 对「无上限语句」生效
- [ ] `quoteIdentifier` 能挡住带引号字符的标识符
- [ ] 每条元数据查询都给出正确的 `project`
- [ ] `close()` 不抛出阻塞卸载的异常，且可被重复调用
- [ ] 取消靠「退役会话」的话，实现了 `usable()` 并在退役后返回 `false`
- [ ] `capabilities` 如实声明
- [ ] `peerDependencies` 声明 `dsh-ds-db`
- [ ] 在打包版 dsh 上 `dsh plugin add` 实测通过（不是只在源码态跑通）
