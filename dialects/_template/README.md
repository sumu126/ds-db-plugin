# dsh-dialect-template

新方言的起手骨架。**它是模板，不是包**——`npm run build` 与 workspace 都会跳过它（目录名以 `_` 开头）。

## 两种用法

### A. 在本仓内开发（官方/合作方言）

```sh
cp -r dialects/_template dialects/clickhouse
# 编辑 dialects/clickhouse/{package.json,src/index.ts}
npm test && npm run verify          # 在 dialects/clickhouse 下跑契约自检
```

**核心一行都不用动。** 方言行住在**你自己的** `cordis.patch.yml` 里（骨架里就有，把两处 `<name>` 改掉即可）：核心的 `dependencies` 是空的，每个方言都自带这样一份 patch——这正是仓内方言与第三方方言同形的原因。

```yaml
- insert:
    - id: dialect-clickhouse
      name: 'dsh-dialect-clickhouse'
```

改完核对 `package.json` 的 `dsh.bundle.patch` 指向本文件——那是「这个包能被 `dsh plugin add` 装」的凭据。

### B. 出仓成独立包（第三方）

```sh
cp -r <插件>/dialects/_template ~/dsh-dialect-clickhouse
cd ~/dsh-dialect-clickhouse
git init
# devDependencies 的 "dsh-ds-db": "file:../.." 指向前面的插件检出，出仓后要改成你自己那份路径。
# 本插件不发布到 registry，所以这条解析不到版本范围——验证与构建期给一份本地检出即可，
# 运行时的 dsh-ds-db 由宿主的部署提供（它是 optional peer）。
npm install && npm run verify && npm run build
```

分发两条路，都不必先进 registry：把 tgz 交给用户 `dsh plugin add <tgz>`，或你自己发布到 registry 后让他 `dsh plugin add dsh-dialect-clickhouse`。

装法：**先装核心 `dsh-ds-db`，再装方言包**——方言依赖核心，核心不依赖方言。只装方言会在启动时报 `failed to import`（方言要读核心的 `dsh-ds-db/dialect-api`）。

## 要改的地方

骨架里每个 `TODO` 都标了位置，最重要的四处：

| 位置 | 说明 |
| --- | --- |
| `name` / `label` / `description` | 注册表键、显示名，以及**你自己写的一句话**（页面类型卡片显示它，插件不会替你写） |
| `RULES` | **只读红线**：你的引号字符、注释标记、放行的语句族、要拒绝的写法 |
| `capabilities` | **如实声明**：缺什么能力就少声明什么，工具会降级而不是报错 |
| `connectionDefaults` | 你的库的端口与账号（如 `{ port: 5432, user: 'postgres' }`）：页面用它预填新连接，插件不会替你猜 |
| `open()` + 各元数据查询 | 换成你的驱动与 SQL；`project` 负责把**你的列名**映射成工具要的形状 |

## 别忘了

- 行数上界：`applyRowLimit` 必须保证「忘写上限也不会把整表灌进模型上下文」
- 标识符引用：`quoteIdentifier` 要挡住带引号字符的名字
- 专属字段：需要 service name、SSL 模式这类字段时声明在 `configFields`，值会进 `connection.extra`
- 自检：`npm run verify` 覆盖只读判定（含字面量/注释绕过）、上界、引用、投影、能力一致性

完整契约见 [`docs/04_API_Docs/方言扩展_API.md`](../../docs/04_API_Docs/方言扩展_API.md)。
