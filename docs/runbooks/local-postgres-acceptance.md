# 本地 PostgreSQL 验收（隔离 fixture）

本仓的数据库断言分成两半：默认套件里能跑的那半，和需要一个真实 PostgreSQL 绑定的那半。后者过去只能在 CI 跑——`npm test` 的安全启动器会剥掉 `PERSISTENCE_RELEASE_DATABASE_URL` 等绑定，于是它们全部转成 pending，本地永远看不到执行结果。这个 runbook 给出本地跑法。

## 一次性隔离 fixture

两个入口都会自己创建**本次运行独占**的 PostgreSQL 17 + Redis 容器（tmpfs 数据、随机端口、随机口令、随机 workspace），跑完即销毁，不读取任何外部 `.env`、容器或共享数据库：

```sh
# 1) 审计清单里的那批（默认，CI 同款分母）
npm run test:postgres:isolated

# 2) 全量：所有 *.postgres.test.ts 加上 DEFAULT_SUITE_PENDING_ALLOWANCES
#    里那批「文件名不是 *.postgres.test.ts 但仍需要数据库绑定」的文件
npm run test:postgres:all-local
```

`test:postgres:all-local` 会把 CI 步骤 `Run PostgreSQL migration acceptance tests without skips` 提供的全部绑定指向同一个 fixture：

`PERSISTENCE_RELEASE_DATABASE_URL`、`PLATFORM_MEDIA_SPEC_DATABASE_URL`、`MODEL_BUDGET_DATABASE_URL`、`LEGACY_BACKFILL_DATABASE_URL`、`WORKSPACE_CATALOG_DATABASE_URL`、`WORKSPACE_BOOTSTRAP_DATABASE_URL`、`BRAND_CANONICAL_DATABASE_URL`、`ASSET_PARSE_DATABASE_URL`、`STORAGE_QUOTA_DATABASE_URL`。

前置条件只有一条：本机有可用的 Docker（fixture 通过本机 socket 创建容器；`--pull=never`，镜像不在本地时先自行 `docker pull`）。任一断言 pending、任一文件为空、任一报告不自洽，启动器都判失败——不存在「跳过即通过」。

## 该选哪一个

| 场景 | 命令 |
|---|---|
| 改了一个 `*.postgres.test.ts` | `npm run test:postgres:isolated -- <文件路径>`（只接受审计清单里的精确路径） |
| 改了一个只在默认套件里 pending 的迁移文件（例如 `migration-049/051/053/063/084-088/104/126`） | `npm run test:postgres:all-local` |
| 提交前 | `npm run test:postgres:all-local`，再 `npm run check` |

## 确实只能在 CI 跑的部分

- **`test:authorization-postgres`**：它由 CI 的独立步骤运行，并要求 5 个授权 PostgreSQL 文件全部 passed、原始 JSON 报告留在 `artifacts/authorization-postgres/vitest.json` 供分母对账。本地要跑请自行绑 `PERSISTENCE_RELEASE_DATABASE_URL`；它不在 `test:postgres:all-local` 的分母里（那 5 个文件已由 `test:postgres:isolated` 覆盖）。
- **需要 schema-dump 客户端的断言**：CI 安装 PostgreSQL 17 客户端并设 `PG_DUMP_BIN`/`PG_RESTORE_BIN`；`test:postgres:all-local` 会在 Homebrew/Linux 常见路径里寻找 17 版 `pg_dump`/`pg_restore`，找不到时相关断言不可执行（本机已安装时可直接跑）。
- 其余 68 个数据库绑定断言的**全部**文件都在 `test:postgres:all-local` 的分母里（99 个文件 / 195 条断言），本地可执行。

## 中间态迁移文件为什么拿到独立空库

`migration-049`、`migration-051`、`migration-053` 从迁移链第 1 版开始应用并断言中间状态。指向 fixture 里已经迁移到末版的 `merchant` 库时，`MigrationRunner` 会正确拒绝并抛 `migration N is not present in this release`——这正是它们过去只能在 CI（绑定的库是空的）跑的原因。现在 fixture 在自己的容器内额外创建两个空库（`legacy_backfill_test`、`workspace_catalog_test`），把 `LEGACY_BACKFILL_DATABASE_URL`、`WORKSPACE_CATALOG_DATABASE_URL` 指向它们；容器销毁即消失，不引入任何共享资源。

## 已知抖动

`migration-088.test.ts` 与 `migration-104.test.ts` 会在结束时删掉自己建的库；若此时仍有连接未关闭，PostgreSQL 会终止它，`pg` 客户端在测试结束后抛出一个未处理异常。症状是 `Test Files 99 passed` + `Tests 195 passed` 但 `Errors 2`，启动器据此以 1 退出。这是这两个文件自身的清理竞态（属 `packages/**`），不是断言失败：看到 `Errors` 且没有 `×` 就重跑一次，不要据此判定回归。

## 与默认套件的关系

这些文件**不**进入默认套件的分母（`NON_HERMETIC_TEST_FILES` 会把它排除；`DEFAULT_SUITE_PENDING_ALLOWANCES` 允许默认套件里的 pending 计数）。`tests/quality-entrypoints.test.ts` 会核对两边：盘上每个测试文件必须有入口或登记为已知缺口，而入口清单里不能出现不存在的文件。
