# 生产上线执行清单

本清单用于把当前本地交付候选推进到真实生产上线。禁止使用 fixture、测试 token、localhost、占位符或手工伪造 evidence。

## 1. 生成并注入配置

以 `infra/config/staging.example.yaml` 为字段参考，部署系统渲染真实 production YAML，并通过 Secret Manager 解析密钥引用。配置必须包含：

- strict auth、MCP enforce、durable platform assignments。
- 六个平台 OAuth、回调、读写权限。
- HTTPS 商家、插件、支付和对象存储 endpoint。
- provider 支付、查询、退款、回调、对账和退款能力。
- relay 地址、API key 引用、五模态模型名、限流和成本上限。
- 对象存储版本控制、KMS、生命周期、PITR 和备份保留。
- ClamAV worker、签名回执、trusted public key、策略版本和镜像 digest。
- 每个 worker 独立 token/signing secret、告警 secret 和数据库连接池配置。

必须设置：

```sh
export PRODUCTION_CONFIG_PATH=/secure/rendered/merchant-production.yaml
```

## 2. 准备发布证据

同一 `RELEASE_ID`、git SHA、镜像 digest 和 deployment nonce 必须绑定以下文件：

- capability evidence（六平台真实 canary、签名）。
- capacity report（云容量和长稳结果）。
- model relay evidence（五模态 usage/cost/503 recovery）。
- Codex App host evidence（真实宿主工具和错误恢复）。
- payment evidence（支付、查询、退款、回调、对账）。
- object storage evidence（版本、KMS、读写和恢复）。
- restore evidence（备份恢复）。
- canonical cutover evidence。
- release manifest 和渲染 Kubernetes manifest。

## 3. 执行顺序

```sh
npm run infra:launch-preflight
npm run test:production-canary
npm run test:production-canary
```

具体命令必须在部署系统中携带真实的 `RELEASE_ID`、`IMAGE_DIGESTS_JSON`、数据库/Redis TLS URL、evidence 路径和 Secret Provider；不要在本地 shell 复制生产密钥。

## 4. 放行条件

只有以下全部满足才允许放开生产写入：

- launch preflight 退出码 0。
- production doctor 无 production fail。
- 六个平台真实读写 canary 通过。
- 支付 provider、退款、回调和对账通过。
- relay 五模态成本、用量和故障恢复 evidence 通过。
- Codex/ChatGPT 宿主 evidence 与当前 bridge SHA、MCP 地址绑定。
- 对象存储、扫描、备份恢复和告警投递通过。
- release manifest、镜像、迁移和 git worktree 完全一致。

任何一项缺失都保持 `writes=false` 和 `NO-GO`。

## 5. 当前阻断

当前环境没有 `PRODUCTION_CONFIG_PATH`，也没有真实 production evidence，因此 launch preflight 仍不能执行。配置和证据进入部署环境后，从第 1 步重新开始，不跳过门禁。
