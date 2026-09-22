# dsh-dialect-postgres

一个**仓外**的 PostgreSQL 方言示例：不改 `dsh-ds-db` 一行代码，就能让它的 4 个只读工具跑在 PostgreSQL 上。

它证明三件事：

1. 方言通过 `inject: ['databaseDialects']` + `register()` 外挂注册，注册是 effect，卸载即摘除；
2. 缺能力时工具**降级**而不是报错——PostgreSQL 没有内置的 `SHOW CREATE TABLE` 等价物，所以本方言不声明 `createStatement`，`db_describe` 会省略该字段；
3. 方言可以自带连接字段——本例的 `sslMode` 会出现在设置页的表单里，值存进连接的 `extra`。

## 安装

```sh
dsh plugin --profile web add ./examples/dsh-dialect-postgres
```

之后在设置 → 数据库管理 → 新建连接里会出现 PostgreSQL。

## 自检

```sh
cd examples/dsh-dialect-postgres
npm install --legacy-peer-deps   # dsh-ds-db 尚未发布，peer 依赖跳过
npm run verify                   # 跑 dsh-ds-db 导出的契约审计，无需数据库服务
```

审计覆盖：只读判定（含字面量与注释绕过）、行数上界、标识符引用、能力与方法一致性、字段默认值类型、各元数据投影。

## 实现一个自己的方言

以本目录为模板，改四处：

1. `POSTGRES_DIALECT.name` / `label`
2. `rules`：词法（引号、注释标记）+ 放行语句族 + 禁止项
3. 元数据查询与 `project`（列名是你自己的，工具不读列名）
4. `capabilities`：如实声明，缺的能力工具会降级

完整契约见 [`../../docs/04_API_Docs/方言扩展_API.md`](../../docs/04_API_Docs/方言扩展_API.md)。
