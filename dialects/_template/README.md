# dsh-dialect-template

新方言的起手骨架。**它是模板，不是包**——`npm run build` 与 workspace 都会跳过它（目录名以 `_` 开头）。

## 两种用法

### A. 在本仓内开发（官方/合作方言）

```sh
cp -r dialects/_template dialects/clickhouse
# 编辑 dialects/clickhouse/{package.json,src/index.ts}
npm test && npm run verify          # 在 dialects/clickhouse 下跑契约自检
```

要让它随主包分发，在**核心**的 `cordis.patch.yml` 多加一行，并把 `dependencies` 里的方言包指向它：

```yaml
- insert:
    - id: dialect-clickhouse
      name: 'dsh-dialect-clickhouse'
    - id: ds-db
      name: 'dsh-ds-db'
```

### B. 出仓成独立包（第三方）

```sh
cp -r <插件>/dialects/_template ~/dsh-dialect-clickhouse
cd ~/dsh-dialect-clickhouse
git init
# package.json 里把 devDependencies 的 "dsh-ds-db": "file:../.." 改成版本范围，并加 peerDependencies
npm install --legacy-peer-deps && npm run verify
npm publish
```

用户：`dsh plugin --profile web add dsh-dialect-clickhouse`

## 要改的地方

骨架里每个 `TODO` 都标了位置，最重要的四处：

| 位置 | 说明 |
| --- | --- |
| `name` / `label` | 注册表键与显示名 |
| `RULES` | **只读红线**：你的引号字符、注释标记、放行的语句族、要拒绝的写法 |
| `capabilities` | **如实声明**：缺什么能力就少声明什么，工具会降级而不是报错 |
| `open()` + 各元数据查询 | 换成你的驱动与 SQL；`project` 负责把**你的列名**映射成工具要的形状 |

## 别忘了

- 行数上界：`applyRowLimit` 必须保证「忘写上限也不会把整表灌进模型上下文」
- 标识符引用：`quoteIdentifier` 要挡住带引号字符的名字
- 专属字段：需要 service name、SSL 模式这类字段时声明在 `configFields`，值会进 `connection.extra`
- 自检：`npm run verify` 覆盖只读判定（含字面量/注释绕过）、上界、引用、投影、能力一致性

完整契约见 [`docs/04_API_Docs/方言扩展_API.md`](../../docs/04_API_Docs/方言扩展_API.md)。
