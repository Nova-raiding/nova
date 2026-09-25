# 平台规则数据采集与上线验收

## 当前结论

截至 2026-09-26，六个平台不依赖平台 OAuth、Cookie 或店铺授权。规则运营可以人工整理 Markdown 并上传为未验证的内部草稿，但该草稿不能通过普通审批激活为平台规则，也不会被商家插件、生成预检或发布前复检读取。正式生效规则必须从核验的官方来源生成受信签名清单，并经受控同步服务验证、导入和激活。不能把人工填写的“官方依据”字段当作来源真实性证明。

当前链路已经具备：签名清单校验、来源 URL 绑定、版本冲突检测、原子导入、激活审计、过期阻断、运营 Markdown 内部草稿导入和 `rule.sync.status`/`rule.sync.now` MCP 入口。`manual://` 只表示人工上传的未验证草稿，不表示来源已核实或规则已生效。

## 官方来源与采集限制

| 平台 | 官方来源 | 当前采集限制 |
| --- | --- | --- |
| 京东 | https://rule.jd.com/rule/ruleDetail.action?ruleId=1249712217973198848 | 页面依赖 JavaScript，不可直接作为稳定机器清单 |
| 淘宝 | https://developer.alibaba.com/doc/doc.htm?articleId=120797&docType=1&treeId=23 | 需要受控采集器或人工导出 |
| 天猫 | https://www.tmall.com/wow/seller/act/guize | 可浏览目录，但不能直接信任网页内容为版本化规则 |
| 拼多多 | https://www.yangkeduo.com/home/help/ | 规则入口跳转到商家中心，需官方授权采集 |
| 小红书 | https://school.xiaohongshu.com/ | 当前不稳定，需人工或平台授权导出 |
| 抖音 | https://school.jinritemai.com/doudian/web/home | 可浏览学习/新规目录，但需版本化抽取和人工复核 |

## 正式采集流程

### A. 运营人工整理（仅内部草稿，不是生效路径）

1. 运营人员从对应平台官方后台或官方规则页面取得原始规则，并保存来源 URL、检查时间和适用平台。
2. 按 `## PDD-xxx｜规则名称` 卡片格式整理 Markdown；每张卡片必须包含 `- 平台：...` 和 `- 官方依据：...`。
3. 在运营后台“平台规则 → 上传平台规则 Markdown”上传。系统创建 `manual://` 内部草稿并计算 checksum，但它不是公共已生效规则。
4. 规则管理员可查看草稿并补充核验记录；当前 API 明确拒绝激活 `manual://` 草稿，普通审批不能改变其未验证状态。
5. 只有从官方来源核验后生成并通过受信签名同步服务导入的版本，才能被激活并供商家 `rule.list`、生成前预检和发布前复检读取；过期、来源不完整或未签名的规则保持阻断。

人工上传只用于内部草稿采集，不替代官方来源核验或签名清单导入，不能被描述为六个平台当前默认的生效规则采集路径，也不允许把商家自定义规则冒充平台规则。

### B. 签名清单自动同步（可选增强路径）

1. 由规则运营人员从官方来源取得原始页面、公告或平台授权 API 结果，并保存原始证据和采集时间。
2. 将结果转换成签名 manifest；每个 entry 必须包含 `platform`、`pack_id`、`version`、`source_reference`、`source_checked_at`、`checks`、`severity`、`action`。
3. `source_reference` 必须与 `packages/review/src/platform-rule-sync.ts` 中的官方 URL 完全一致。
4. 对 manifest 原始字节做 HMAC-SHA256 签名；签名密钥只能来自 Secret Manager，不能提交仓库。
5. 将 manifest 发布到 HTTPS、不可变、可审计的地址，并配置：

   ```env
   PLATFORM_RULE_SYNC_MANIFEST_URL=https://<trusted-domain>/platform-rules/v1/manifest.json
   PLATFORM_RULE_SYNC_SIGNING_SECRET=<secret-manager>
   PLATFORM_RULE_SYNC_INTERVAL_HOURS=24
   ```

6. 使用 `rules_admin` 运行 `rule.sync.now`，随后检查 `rule.sync.status` 六个平台均为 `ready`。
7. 验证 `rule.list`、内容生成前预检、规则审计、版本冲突和过期阻断；任一平台缺失时，相关生成/发布能力必须保持阻断或人工复核。

## 不允许的替代方案

- 不把网页标题、搜索摘要或人工复制文本直接写入生产规则表。
- 不把未审批的 `manual://` 草稿、fixture 或工作区规则当成已生效的平台规则。
- 不因为规则为空就返回“规则已同步”。
- 不在没有版本、来源、签名和审计证据时放开生成或发布。
