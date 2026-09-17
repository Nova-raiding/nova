# 隔离本地运行态验收

`test:local-release-gate`、scanner runtime contract 和本地故障验收只允许连接一次性隔离 Compose 环境。没有下面 7 个变量时，测试会主动失败；不要把共享 `local`、生产 URL 或 `.env` 填进去。

```sh
export LOCAL_RUNTIME_TEST_RUN_ID=run-YYYYMMDD-xx
export LOCAL_RUNTIME_TEST_PROJECT=merchant-runtime-run-YYYYMMDD-xx
export LOCAL_RUNTIME_TEST_WORKSPACE_ID=ws_runtime_run_YYYYMMDD_xx
export LOCAL_RUNTIME_TEST_API_URL=http://127.0.0.1:<隔离端口>
export LOCAL_RUNTIME_TEST_API_TOKEN=<仅用于本次隔离运行的 token>
export LOCAL_RUNTIME_TEST_COMPOSE_FILE=/绝对路径/隔离目录/compose.yml
export LOCAL_RUNTIME_TEST_ENV_FILE=/绝对路径/隔离目录/runtime.env
```

启动前必须确认隔离 Compose 为 API、Postgres、Redis、ClamAV 和 worker 使用独立 project、网络、volume、workspace 和 token，并只把端口绑定到 `127.0.0.1`。测试安全层会再次检查这些条件；任何一项不满足都会停止，不会上传测试素材。

在隔离环境启动并确认容器 healthy 后执行：

```sh
npm run test:local-release-gate
npm run test:runtime:isolated
```

scanner 闭环的成功证据必须同时包含：素材初始为 `quarantined`、签名 callback 为 `accepted`、`callback_accepted_at` 为本次运行时间、heartbeat `ready=true`，以及 `worker-scan` healthy。没有 accepted callback 时，保持阻断，不手工修改数据库或 Redis。

本地隔离验收通过不等于生产上线；生产仍需单独的 release manifest、真实依赖 evidence、ECS preflight、桌面验收和回滚证据。
