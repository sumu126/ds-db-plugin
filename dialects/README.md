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
| `Cannot find package 'dsh-ds-db'` | 核心没被链接进来；跑 `pnpm install`（按 workspace 链接）。包管理器不可用时手工建**目录联接**，但注意：`New-Item -ItemType Junction -Path node_modules\dsh-ds-db -Target $PWD` 会让 `node_modules` 自我引用，**遍历文件时必须排除 `node_modules`**（git、ripgrep、编辑器默认都排除），否则会无限展开 |

## 一个已知的依赖方向偏离（有意）

本仓的方言包 `peerDependencies` 是 **`dsh-ds-db`（整个插件）**，不是一份接口契约包。第一方 harness 不这样做：`dsh-bash-local` 只 peer `dsh-shell`（定义），绝不 peer `dsh-tool-bash`（消费者）。

**为什么现在这样**：唯一随包发布的方言是 `dsh-dialect-mysql`，与插件同仓同版本，拆出第二个发布物只会多一条独立版本线。**什么时候改**：一旦有方言需要独立发布，就把 `dialect` / `sql-guard` / `value` / `dialect-audit` 抽成 `dsh-db-dialect-api`，方言包改依赖它（验收：`grep -rn "dsh-ds-db/src" dialects/` 为空）。理由与验收写在同一处：[`../README.md`](../README.md) 的已知限制。
| 类型检查报 harness 源码的错 | 用了 `tsconfig.json` 而不是 `tsconfig.types.json` |
| 工具描述里是兜底文案 | 方言注册晚于工具注册；确认方言行排在了 `ds-db` 行之前 |
| 设置页没出现我的类型 | 页面读的是 `GET /api/ds-db/dialects`，确认方言已注册 |
| npm 报 `Unsupported URL Type "workspace:"` | 核心对本地方言包用的是 `file:dialects/mysql`，npm 与 pnpm 都能解析；若你改成了 `workspace:^`，就只用 pnpm 安装 |

## 发布时的依赖替换

核心的 `dependencies` 用 `file:dialects/mysql` 指向本地方言包，**发布前必须替换成真实版本号**（`dsh-dialect-mysql@^0.1.0`），否则装包的人解析不到该路径。用 pnpm 发布时，`workspace:^` 会被自动替换，`file:` 不会。
