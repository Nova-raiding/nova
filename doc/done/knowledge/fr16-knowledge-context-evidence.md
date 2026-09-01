# FR-16 知识库上下文实现证据

日期：2026-08-25

## 已落地

- API 按当前工作区、平台、品类、品牌和店铺筛选有效知识规则。
- 品牌资产、客户资产和已确认学习建议通过受控 provider 进入任务输入。
- 方案确认时将知识上下文冻结到 `TaskInputSnapshot`，历史任务不会读取后续更新。
- 模型生成和 `content.codex.prepare` 使用同一冻结上下文。
- 知识资产标记 `confirmed=false`，只能作为待确认参考，不能覆盖商品事实。
- 内容版本向量新增 `knowledgeVersionIds`，记录规则版本、资产 revision 和学习建议 ID。
- 生产环境缺少非 `fixture`/`local` 的 release、Skill、MCP、连接器或 prompt 元数据时，生成和 Codex 提交 fail-closed；运营台显示具体阻断项。

## 当前仍未完成的外部门禁与运营接入

- 知识模块当前仍需生产持久化仓储和跨进程恢复演练。
- 官方平台规则、真实模型、OAuth、支付、云容量和托管告警仍需外部 canary 证据。
- `apps/ops-console` 当前已覆盖商业化、平台运维，以及知识资产、学习建议、竞品权利审核和多模态任务队列的安全投影与人工操作入口；真实生产知识库、模型/图像供应商、对象存储与宿主应用证据仍需补齐，fixture 或浏览器替身不计为生产完成。

## 自动化证据

- 全量测试：77 个测试文件、494 个测试通过。
- TypeScript build：通过。
- CodeGraph：当前索引统计以 `doc/codex-app-e2e-report.md` 的 3,180 个节点、13,077 条边和 15,503 个 unresolved references 为准。
