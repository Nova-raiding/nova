# B 桥接候选云端边界回补审计（离线，未发布）

状态：**NO-GO**。本分支保留 `98d9382c` 的真实 PG17 schema 242 API/六 worker 隔离演练结果，但该结果绑定旧 B 镜像摘要，不能转用于本分支。`45cee586` 仅将 API/worker 运行层改为 selective `COPY`；`69c1c2aa` 仅提供本地插件包签名描述符。它们不改变当前 B v1 候选包仍包含插件前端的事实。

## 必须一起回补的最小依赖图

```text
本地签名插件整包 + macOS/Windows 真实安装/测试证据
  └─ plugin-release/2 描述符和离线 Ed25519 信任锚（已有基础 signer）
      └─ Git-less staging release identity 解析（主线 5111453f）
          └─ release-manifest/2 生成及验证（主线 88b04698、11322f73）
              └─ candidate-identity/2、签名测试记录、云端 staging（dabcc8ae、70d4ccea）
                  └─ ECS preflight/host bridge hash（4efcf8ab）
                      └─ 云端专用测试集和 gate image（9222a00a、3988eb45、60948282、0d6c132e）
                          └─ 四处同一云端 Git archive pathspec、六镜像新 SHA/digest、B package/nonce 重建
```

主线 v2 批次共修改至少 24 个文件、约千行；B 基线早于 `release-identity.ts` 和部分发布证据合同。直接 cherry-pick `88b04698` 在 `scripts/release-manifest.ts`、`tests/release-manifest-gate.ts` 冲突；先取 `5111453f` 仍在三个 release-manifest 测试/校验文件冲突。把 v2 的“通过”简单套入 B 会丢失 B 的 schema 242 桥兼容、旧版回滚身份或后续生产证据门禁，不能机械解决冲突。

## 已完成与下一次安全验证

- 已回补 selective API/worker runtime COPY（`45cee586`）；源码归档当前仍为 v1，不能打镜像投产。
- 已回补本地插件包 Ed25519 描述符 signer（`69c1c2aa`），其独立篡改/身份/私钥权限 5 项测试通过；尚无本分支 macOS/Windows 真实安装签名证据。
- 四处 B 旧归档生产/核对点已统一仅排除历史 `artifacts/` 和 `screenshots/`（`8afb4ca9`），源归档契约 3 项通过。这不是云端 v2 排除插件的完成证据。
- 下一步应先把主线 v2 完整合同作为**一个可运行集成批次**移植到 B，保留 B 独有 schema/回滚代码，专门解决 release identity 与 manifest 合并；再要求云端归档、gate image、六镜像使用同一排除插件 pathspec。缺签名包、证据、类型检查、真实镜像内容扫描时失败关闭。
- 新代码提交必然改变 Git SHA、source SHA、OCI 镜像摘要和发布签名；必须新建完整固定镜像/发布清单/nonce，不能引用旧 `ee7bd0b0` API/worker 镜像或其 PG17 smoke 结果。新镜像构建后才运行同一 PG17 242 真 Docker 测试，并增加 cloud-only tar/镜像扫描。

未达到这些条件时，不向 101/CI 写入任何 B 制品，更不执行七容器接管。
