# dialects/ — 数据库类型工作区

这个目录是**插件自身的插件化**：`dsh-ds-db` 核心只提供方言注册表与工具，**不含任何数据库类型**；每种数据库都是一个平级的方言包。

```
dialects/
├── mysql/        dsh-dialect-mysql —— 官方方言，自带 dsh.bundle.patch，与核心分开安装
├── _template/    ★ 新方言的起手骨架（不是包，不参与构建与 workspace）
└── <你的>/       复制 _template 得到的方言
```

**核心不 import 任何方言**。MySQL 之所以可用，是因为 `dsh-dialect-mysql` 像第三方包一样 `inject: ['databaseDialects']` 后注册了自己——和第三方方言走的是同一条路径，没有后门。

**核心也不依赖任何方言**：它的 `dependencies` 是空的，方言行住在方言包**自己的** patch 里。所以仓内方言与仓外方言在这一层完全同形，区别只是目录在不在本仓、由谁打包。

## 两种开发位置

| 你 | 放哪 | 说明 |
| --- | --- | --- |
| 官方 / 合作方言 | 本目录 `dialects/<name>/` | fork 本仓开发，随本仓 CI 与发布节奏 |
| 第三方方言 | **复制出去建独立仓库** | 见 `_template/README.md` 的用法 B |

两者代码形状**完全一致**，区别只在谁维护、谁发布。

## 加一个方言要动的地方

1. `cp -r dialects/_template dialects/<name>`
2. 改 `package.json` 的 `name`（用 `dsh-dialect-<name>` 命名），并确认 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`
3. 在 `cordis.patch.yml` 里插一行 `- id: dialect-<name>` + `name: 'dsh-dialect-<name>'`
4. 实现 `src/index.ts`：`name` / `label` / `rules` / `capabilities` / `configFields` / `open()` / 元数据查询
5. `npm test && npm run verify`（在方言包目录下）

**核心一行都不用动**——没有"随主包分发"这条特殊路径：装的人先装核心，再 `dsh plugin add` 你的方言包。

## 方言行与核心行的先后

工具的**描述文案在注册时写定**，而它来自方言自己的事实（自称、放行的语句族、行数上界写法）。核心因此会等一下：`registry.whenRegistered(方言名, 注册工具)`，方言一注册就把工具注册出来。

方言先注册，描述一次就写对；方言晚到（或没装），核心在 `DIALECT_WAIT_MS`（100ms）后用兜底事实注册工具——调用会明确报出「方言未注册，已注册的是 X」。

**两种顺序都能跑通**（核心→方言、方言→核心都实测过）：它们是两个独立 bundle，装序不敏感，区别只是晚到的那种要等满这 100ms。

## 每个方言包自带

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 方言本体 + `apply()` 注册 |
| `cordis.patch.yml` | 它自己那一层：只插 `dialect-<name>` 一行 |
| `scripts/build.mjs` | 自包含构建（`prepare` 会在仓外取回的副本里跑，那里没有父仓脚本） |
| `tests/` | 该方言的行为测试（语法、投影、拒绝清单） |
| `scripts/verify.ts` | 契约自检，**不需要数据库服务** |
| `package.json` | 自己的驱动依赖；`dsh-ds-db` 作为 optional peer；`dsh.bundle.patch` 指向自己的 patch |
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
| `Cannot find package 'dsh-ds-db'` | 核心没被链接进来。在**仓根**跑 `pnpm install`：解析靠仓根的 `dsh-ds-db: file:.` 自引用，方言目录自己没有这个链接 |
| 启动报 `dialect-<name> … failed to import` | 方言运行时 import 核心的 `dsh-ds-db/dialect-api`，而核心没装或没激活。先装核心 |
| 类型检查报 harness 源码的错 | 用了 `tsconfig.json` 而不是 `tsconfig.types.json` |
| 工具描述里是兜底文案 | 方言注册晚于工具注册（或没装）；核心等满 `DIALECT_WAIT_MS` 后就用兜底事实注册了 |
| 设置页没出现我的类型 | 页面读的是 `GET /api/ds-db/dialects`，确认方言已注册 |

## 打包

每个方言包单独打包，落点显式给出：

```sh
pnpm pack ./dialects/mysql --pack-destination .
```

核心与方言是**两个独立的 bundle**，所以安装也是两次 `dsh plugin add`——装核心不会把方言带上。

## 独立发布仓是镜像

`dialects/mysql/` 另有一个发布仓：[`dsh-dialect-mysql`](https://github.com/sumu126/dsh-dialect-mysql)，好让别人不装插件仓也能单独装这个方言。

**源永远是本仓这一份**：门禁（`verify:*`）与打包（`pnpm pack ./dialects/mysql`）都跑它，镜像只是副本。发版时同步：

```sh
pnpm run sync:dialect -- <镜像的本地检出> --tag --push
```

脚本按 `git ls-files dialects/mysql` 取内容、删掉镜像里多出来的文件（镜像自己的 `.gitignore` 除外），并把来源 commit 写进提交信息；**源侧有未提交改动会被拒绝**——否则镜像会声称自己来自一个并不包含这些内容的 commit。不带 `--tag` / `--push` 就只在镜像里本地提交。

## 一个已知的依赖方向偏离（有意）

本仓的方言包 `peerDependencies` 是 **`dsh-ds-db`（整个插件）**，不是一份接口契约包。第一方 harness 不这样做：`dsh-bash-local` 只 peer `dsh-shell`（定义），绝不 peer `dsh-tool-bash`（消费者）。

**为什么现在这样**：唯一的官方方言是 `dsh-dialect-mysql`，与插件同仓同版本，拆出第二个发布物只会多一条独立版本线。**什么时候改**：一旦有方言需要独立发布，就把 `dialect` / `sql-guard` / `value` / `dialect-audit` 抽成 `dsh-db-dialect-api`，方言包改依赖它（验收：`dialects/*/package.json` 不再出现 `dsh-ds-db`）。注意**能不能加载**与**依赖面大小**是两件事：方言一律从构建产物 `dsh-ds-db/dialect-api` 取 API（`grep -rn "dsh-ds-db/src" dialects/` 已为空），因为安装形态的 `dsh` 没有 TypeScript 加载器。理由与验收写在同一处：[`../README.md`](../README.md) 的已知限制。
