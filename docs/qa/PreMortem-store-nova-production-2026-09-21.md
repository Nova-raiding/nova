# Pre-Mortem Analysis: Store Nova 生产上线

假设候选在 14 天内上线后失败。本分析只覆盖本地 ChatGPT 插件 → API/MCP → 模型中转 → 商家后台/桌面运营后台 → 数据、权限与发布门禁，不把插件市场、真实 ChatGPT OAuth、移动端或六平台自动连接扩成需求。

## Tigers（真实风险）

### Launch-Blocking

1. **当前候选缺少同一 release 绑定的生产证据。** 现网 `/releasez` 尚未证明 release id、Git SHA、manifest 与镜像集合一致；旧模型中转证据不能复用。
2. **真实支付、五模态中转、ChatGPT 本地宿主和人工运营证据未形成同一候选的闭环。** 单元测试和模拟回执不能替代当前 release 的鉴权、用量、成本、错误与人工回填证据。
3. **生产受保护配置未完整注入新 release。** 数据库 owner、对象存储、扫描器、部署 nonce、回滚/容量/恢复证明缺失时必须 fail closed。

### Fast-Follow

1. Merchant Studio 主包仍有大 chunk 警告；上线后 30 天内按真实加载指标拆分，不作为当前功能阻断。
2. 建立 Docker E2E 临时资产定期回收，避免本地验收再次因测试卷和镜像占满而中断。

### Track

1. 监控人工发布任务积压、复核退回率和证据缺失率。
2. 监控模型中转 429、成本偏差、五模态计量单位与价格快照版本。

## Paper Tigers（非本项目风险）

1. **未上插件市场。** 项目采用本地直装/本地 stdio，本来就不以上架公开或团队插件市场为目标。
2. **未配置真实 ChatGPT OAuth。** 本地 bridge 使用平台签发的短期 access/refresh token；ChatGPT OAuth 不是要求。
3. **未做手机和平板适配。** 运营后台明确是桌面工作台。
4. **未接六平台 OAuth/API 自动发布。** 六平台资料导入和发布均为人工流程，不应伪造自动连接成功。

## Elephants（需要持续验证）

1. 生产凭据由谁保管、轮换和审计，是否能在不泄露值的前提下完成候选注入。
2. 回滚候选能否在禁止部署时拉取镜像的条件下，使用宿主机已有不可变镜像恢复。
3. 单节点 ECS 的真实容量、备份恢复时长和故障窗口是否满足业务承诺。

## Launch-Blocking Action Plan

| 风险 | 缓解动作 | Owner | 完成时间 |
| --- | --- | --- | --- |
| release 身份未闭环 | 生成最终候选，绑定 Git SHA、manifest、镜像 digest，预检并验证 `/releasez` | 发布 owner | 切流前 |
| 真实能力证据缺失 | 在当前 release 上采集本地 ChatGPT、支付、人工运营、五模态中转的非模拟证据 | 平台 owner | 切流前 |
| 受保护配置不完整 | 按 ECS runbook 注入秘密引用和当前 release 证据路径；禁止复用旧 release 文件 | 基础设施 owner | 切流前 |

结论：代码候选可继续进入生产预检，但上述三项 Launch-Blocking Tiger 未关闭前，生产切流结论必须为 **NO-GO**。
