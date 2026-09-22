# dialects/ — 数据库类型工作区

这个目录是**插件自身的插件化**：`dsh-ds-db` 核心只提供方言注册表与工具，**不含任何数据库类型**；每种数据库都是一个平级的方言包。

```
dialects/
├── mysql/        dsh-dialect-mysql —— 官方方言，随主包自动安装
├── _template/    ★ 新方言的起手骨架（不是包，不参与构建与 workspace）
└── <你的>/       复制 _template 得到的方言
```

**核心不 import 任何方言**。MySQL 之所以可用，是因为 `dsh-dialect-mysql` 像第三方包一样 `inject: ['databaseDialects']` 后注册了自己——和第三方方言走的是同一条路径，没有后门。

## 两种开发位置

| 你 | 放哪 | 说明 |
| --- | --- | --- |
| 官方 / 合作方言 | 本目录 `dialects/<name>/` | fork 本仓开发，随本仓 CI 与发布节奏 |
| 第三方方言 | **复制出去建独立仓库** | 见 `_template/README.md` 的用法 B |

两者代码形状**完全一致**，区别只在谁维护、谁发布。

## 加一个方言要动的地方

1. `cp -r dialects/_template dialects/<name>`
2. 改 `package.json` 的 `name`（用 `dsh-dialect-<name>` 命名）
3. 实现 `src/index.ts`：`name` / `label` / `rules` / `capabilities` / `configFields` / `open()` / 元数据查询
4. `npm test && npm run verify`（在方言包目录下）
5. **要随主包分发**才需要改核心两处：
   - `cordis.patch.yml` 增加一行 `- id: dialect-<name>` + `name: 'dsh-dialect-<name>'`，**放在 `ds-db` 行之前**
   - 核心 `package.json` 的 `dependencies` 加上该方言包
   - 不随主包分发的话，这两处都不用动——用户独立安装即可

## 为什么方言行要排在核心行之前

工具的描述文案在**注册时写定**，而它来自方言自己的事实（自称、放行的语句族、行数上界写法）。核心因此会等一下：`registry.whenRegistered(方言名, 注册工具)`，方言一注册就把工具注册出来。

顺序对了，描述一次就写对；顺序错了或包没装，核心在 `DIALECT_WAIT_MS`（100ms）后用兜底事实注册工具——调用会明确报出「方言未注册，已注册的是 X」。

## 每个方言包自带

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 方言本体 + `apply()` 注册 |
| `tests/` | 该方言的行为测试（语法、投影、拒绝清单） |
| `scripts/verify.ts` | 契约自检，**不需要数据库服务** |
| `package.json` | 自己的驱动依赖；`dsh-ds-db` 作为 peer |
| `tsconfig.json` / `tsconfig.types.json` | 前者供 tsx 运行时（指向 harness 源码），后者供类型检查（指向 `.d.ts`） |

## 命令（在方言包目录下）

```sh
npm run verify     # 契约自检：只读判定、上界、引用、投影、能力一致性
npm test           # 行为测试
npm run build      # 打包成 lib/index.js（主包的 npm run build 也会遍历这里）
```

## 常见问题

| 现象 | 原因 |
| --- | --- |
| `Cannot find package 'dsh-ds-db'` | 核心没被链接进来；跑 `pnpm install`（按 `workspace:*` 自动链接）。包管理器不可用时手工建：`New-Item -ItemType Junction -Path node_modules\dsh-ds-db -Target $PWD`（在插件根执行） |
| 类型检查报 harness 源码的错 | 用了 `tsconfig.json` 而不是 `tsconfig.types.json` |
| 工具描述里是兜底文案 | 方言注册晚于工具注册；确认方言行排在了 `ds-db` 行之前 |
| 设置页没出现我的类型 | 页面读的是 `GET /api/ds-db/dialects`，确认方言已注册 |
