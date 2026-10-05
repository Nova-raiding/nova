# Implementation Tasks（owner聚合）

这些是下一步实施任务，尚未执行。CEO初审中的文档修订任务已经闭合，owner将其转成对应实现任务C1–6；原始任务保留在round-1-ceo-tasks.jsonl。按component、排序files、title精确去重并保留最高优先级，跨角色近似任务保持来源，实施时可按实际依赖合并，不作为未决业务规则。估算为粗略规模/初审参考，不承诺工期。

- [ ] **C1（P1）— 实现首购依赖明细、唯一开通资格与六笔赠点计划**
  - 来源：ceo-review / CEO-01；human L，实施前拆分估算 / AI L，实施前拆分估算。
  - 文件：packages/application/src/commercial-purchase-service.ts、packages/persistence/src/commercial-contract-repository.ts。

- [ ] **C2（P1）— 实现剩余期报价、连续升级基价、迟核验及源变化资金处置**
  - 来源：ceo-review / CEO-02/03；human L，实施前拆分估算 / AI L，实施前拆分估算。
  - 文件：packages/application/src/commercial-purchase-service.ts、packages/persistence/src/commercial-contract-repository.ts、packages/contracts/src/mcp.ts。

- [ ] **C3（P1）— 实现三档身份、权益包版本、周期配置及可靠增改上下架归档**
  - 来源：ceo-review / CEO-04/06/08 + 用户目录管理；human L，实施前拆分估算 / AI L，实施前拆分估算。
  - 文件：packages/persistence/src/commercial-catalog-repository.ts、apps/api/src/mcp-commercial-ops-catalog.ts、packages/application/src/commercial-plan-catalog.ts。

- [ ] **C4（P1）— 实现分型增量权益、精确余数、单一账期和功能消费器准入**
  - 来源：ceo-review / CEO-05；human L，实施前拆分估算 / AI L，实施前拆分估算。
  - 文件：packages/application/src/continuous-feature-entitlement.ts、packages/persistence/src/commercial-contract-repository.ts、packages/application/src/commercial-access-service.ts。

- [ ] **C5（P1）— 实现指定客户代购、真实收款拆分分配及未分配款受控退回**
  - 来源：ceo-review / CEO CLI-3 + 用户运营代购；human L，实施前拆分估算 / AI L，实施前拆分估算。
  - 文件：apps/api/src/server.ts、packages/persistence/src/commercial-contract-repository.ts、packages/persistence/src/commercial-refund-repository.ts。

- [ ] **C6（P1）— 实现对账关联、普通价格去硬编码、销售迁移和兼容回滚门禁**
  - 来源：ceo-review / CEO-09 + 可调价要求；human L，实施前拆分估算 / AI L，实施前拆分估算。
  - 文件：apps/api/src/server.ts、packages/persistence/src/commercial-catalog-repository.ts、apps/worker/src/main.ts。

- [ ] **D1（P1）— 分离销售与草稿显示并拆分下架与归档**
  - 来源：design-review / Pass 1：草稿不能遮蔽当前在售合同；human 4h / AI 30min。
  - 文件：apps/ops-console/src/pages/FinancePage.tsx、apps/ops-console/src/api/commercialOperationsClient.ts。

- [ ] **D2（P1）— 落地加载空失败部分与响应未知恢复**
  - 来源：design-review / Pass 2：读失败不能视为空，部分合款不可全成功；human 5h / AI 40min。
  - 文件：apps/ops-console/src/components/commercial/CommercialOperationsWorkspace.tsx、demo/merchant-studio/src/App.tsx。

- [ ] **D3（P1）— 提供首购升级明细双截止与当前未来合同分区**
  - 来源：design-review / Pass 3：点击支付不能视为到账，未来合同不能改变；human 5h / AI 40min。
  - 文件：demo/merchant-studio/src/App.tsx、demo/merchant-studio/src/api.ts、packages/contracts/src/mcp.ts。

- [ ] **D6（P1）— 提供行标签焦点状态语义与桌面缩放契约**
  - 来源：design-review / Pass 6：仅桌面验收尚未定义键盘读屏；human 3h / AI 25min。
  - 文件：apps/ops-console/src/pages/FinancePage.tsx、demo/merchant-studio/src/App.tsx、apps/ops-console/src/styles.css、demo/merchant-studio/src/styles.css。

- [ ] **ENG1（P1）— 受控同事务销售解析与投影锁**
  - 来源：eng-review / E1: 事务外解析与bootstrap最小权限；human 1d / AI 1h。
  - 文件：packages/application/src/commercial-purchase-service.ts、packages/persistence/src/commercial-contract-repository.ts、packages/persistence/src/migrations。

- [ ] **ENG2（P1）— 统一锁序、真实流水唯一与返款冻结**
  - 来源：eng-review / E2: 分配/返款/权益共享资源并发；human 2d / AI 2h。
  - 文件：packages/persistence/src/commercial-contract-repository.ts、packages/persistence/src/commercial-refund-repository.ts、packages/persistence/src/migrations。

- [ ] **ENG4（P1）— 补齐14组新行为测试及关键旧流回归**
  - 来源：eng-review / Test review: 当前6组局部证据不足新契约；human 2d / AI 2h。
  - 文件：packages/persistence/src、packages/application/src、tests、dogfood/chatgpt-all-functions。

- [ ] **ENG5（P1）— 实现普通到账截止、浮动顺延与未来额度计划门禁**
  - 来源：eng-review / Eng CLI P1-01/02/03；human 需实现前拆分估算 / AI 需实现前拆分估算。
  - 文件：packages/contracts/src/commercial-order.ts、packages/persistence/src/commercial-contract-repository.ts、packages/application/src/commercial-payment-service.ts、apps/worker/src/main.ts。

- [ ] **ENG6（P1）— 新增来源限定的回收预检、冻结与退款恢复执行器**
  - 来源：eng-review / Eng CLI P1-04；human 需实现前拆分估算 / AI 需实现前拆分估算。
  - 文件：packages/persistence/src/commercial-refund-repository.ts、packages/persistence/src/creative-point-lifecycle-repository.ts、packages/application/src/commercial-payment-service.ts。

- [ ] **DX-T1（P1）— 同步商业契约与安装插件兼容矩阵，拒绝无报价旧升级请求**
  - 来源：devex-review / DX-1：共享MCP和Bridge schema及恢复集合独立，旧upgrade仅传SKU可能全价下单；human 1–2d / AI 2–4h。
  - 文件：packages/contracts/src/mcp.ts、packages/contracts/src/commercial-access.ts、apps/api/src/server.ts、apps/plugin/mcp/bridge.mjs、apps/plugin/scripts/verify-installed-bridge.mjs。

- [ ] **DX-T2（P1）— 明确批准manual_transfer模式与线上支付的独立readiness**
  - 来源：devex-review / DX-2：手工转账不能因未启用线上provider误拒绝，也不能任意provider通过生产；human 4–8h / AI 1–2h。
  - 文件：apps/api/src/server.ts、apps/ops-console/src/components/commercial/CommercialOperationsWorkspace.tsx、apps/ops-console/src/api/commercialOperationsClient.ts。

- [ ] **DX-T3（P1）— 增加商业错误机器契约及安全授权恢复测试**
  - 来源：devex-review / DX-3：错误中文与HTTP状态不足以确定可安全恢复，Bridge安全投影须同步；human 1d / AI 2h。
  - 文件：packages/contracts/src/mcp.ts、apps/api/src/mcp-commercial-ops-catalog.ts、apps/api/src/server.ts、apps/plugin/mcp/bridge.mjs。

- [ ] **D4（P2）— 以业务分配向导替代技术字段输入**
  - 来源：design-review / Pass 7：运营不应手填nonce及hash；human 3h / AI 25min。
  - 文件：apps/ops-console/src/components/commercial/CommercialOperationsWorkspace.tsx、apps/ops-console/src/api/commercialOperationsClient.ts。

- [ ] **D5（P2）— 复用主题表格并使本功能文字至少16px**
  - 来源：design-review / Pass 4/5：本功能不继承不可读小字或装饰卡片；human 2h / AI 20min。
  - 文件：apps/ops-console/src/styles.css、demo/merchant-studio/src/styles.css。

- [ ] **ENG3（P2）— 实现有界fan-out、游标分页和监控**
  - 来源：eng-review / E3: 发布outbox不能同步遍历全体收件人；human 0.5d / AI 30m。
  - 文件：packages/workers/src、apps/api/src、apps/ops-console/src、demo/merchant-studio/src。

- [ ] **DX-T4（P2）— 更新既有交付文档并定义测量首次成功和排障**
  - 来源：devex-review / DX-4：现有手册仍以basic/growth及初始价描述，新流程缺文档验真和TTHW起止；human 4–8h / AI 1h。
  - 文件：README.md、docs/product-usage-guide.md、docs/store-nova-chatgpt-plugin-install-manual.md、docs/commercial-executable-spec.md。

- [ ] **DX-T5（P2）— 实现首单前无业务标识的支持交接及工单回执**
  - 来源：devex-review / DX CLI P2-01；human M，实施前拆分估算 / AI M，实施前拆分估算。
  - 文件：demo/merchant-studio/src/App.tsx、packages/contracts/src/mcp.ts、docs/store-nova-chatgpt-plugin-install-manual.md。

