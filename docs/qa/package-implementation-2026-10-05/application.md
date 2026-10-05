# 套餐应用层实施与评审证据

日期：2026-10-05。角色：应用层后端。范围：共享功能定义、购买意图透传、升级计算、套餐准入及对应单元行为；数据库交易、真实现金、HTTP/Worker接线、桌面及101验收由 owner 整合，本文不将单元结果当生产完成。

## 已实现

- `commercial-purchase-service.ts` 在目录查询前拒绝没有 `upgrade_quote_id` 的旧升级请求，不能回退为目标全价月套餐。报价引用只能用于 upgrade。透传 `upgrade_quote_id`、`checkout_id`、`onboarding_order_id` 给真实事务仓储，客户不提交金额/权益。
- `commercial-upgrade-policy.ts` 对同 family、更高固定 rank、同 cycle 的真实全周期成交价做剩余期计算；BigInt 有理数最终 half-up 到整数分。绝对上限直接切换、布尔权限按目标值切换、响应时限仅允许不恶化；点数/服务量取额度差剩余份额，向下取整，保存累积精确分数及已授整数。后续事件累积余数后扣已授单位，原账期不重启；未知消费者、丢失额度、无效价格/周期/期间/余数阻断。
- 共享唯一 `packages/contracts/src/commercial-feature-definitions.ts` 注册真实 enabled 操作：内容、图片、视频、知识库、自动化、发布。HTTP 沿用 exact MCP authorization reference；Worker generation/image/publish 共用映射。无 prefix、无 Ops 能力赠送。应用层旧导入路径只 re-export。
- `ContinuousFeatureEntitlementService` 拒绝重复权益 code、无效品牌/店铺整数及伪造功能码；只有当前唯一有效权益快照的相应 `feature.*` 数量严格等于1才授权。未来及到期快照不授权。
- `CommercialAccessService` 在已有点数/费率门禁后校验功能及真实开通资格；缺失/未知资格阻断。仅接受同企业、有效期内、带批准政策及订单来源的私测例外投影，明确已有 demo evaluation 例外保留；不靠余额/5000元/套餐名称猜开通。
- `CommercialAccessService.recheckEntitlement` 给已获授权异步执行复核当前功能和开通资格，不重查可用点数（已预留后可用余额为0仍合法），既有预留/鉴权/模型 readiness 必须继续由 caller 保留。拒绝 disabled、未注册、Ops及 recovery 身份用于执行复核。
- `OnboardingOffer`/`CreativePointPack` 数值类型不再锁死初始价格；初始化开通5000元、每月500点共6期保留。legacy custom未改为尊享版，尊享实际配置由目录批准版本提供。

## 冻结接线

```ts
service.recheckEntitlement({
  workspace_id,
  surface: 'WORKER',
  operation: 'generation.execute',
  validated_modality: 'text', // 只能来自服务端已验证输入/冻结job
})
```

成功返回 `allowed:true/code:OK/snapshot_id/subscription_period_id/catalog_version_id/checksum`；失败 `allowed:false/code:COMMERCIAL_ENTITLEMENT_REQUIRED|UNAVAILABLE|AMBIGUOUS` 且证据id为空。共享生成器若无可信模态分类，保守要求三模态权限，不擅自当文本。

资格port：`qualification_projection.projectCommercialQualification({workspace_id})` 返回 `{state:'known',qualified,approved_private_trial_exception?:{workspace_id,starts_at,expires_at,policy_id,order_id}}` 或 `{state:'unknown'}`。eng仓储 `getOnboardingStatus` 提供实际 qualification及已批准私测例外，由 owner 接线。

## 测试

2026-10-05 11:31:31 本地 safe runner：8文件、89项通过，0 skipped，exit 0，耗时36.58s。

```sh
node --import tsx scripts/run-safe-tests.ts --no-file-parallelism \
  packages/application/src/commercial-upgrade-policy.test.ts \
  packages/application/src/commercial-purchase-service.test.ts \
  packages/application/src/commercial-plan-catalog.test.ts \
  packages/application/src/continuous-feature-entitlement.test.ts \
  packages/application/src/commercial-access-service.test.ts \
  packages/application/src/commercial-side-effect-matrix.test.ts \
  packages/application/src/demo-evaluation-entitlement.test.ts \
  packages/application/src/commercial-feature-definitions.test.ts
```

覆盖半周期1500/2500/4000元、实际成交价变动、闰月时长、half-up整数分、大整数边界、连续升级不同事件时点余数、来源价不能等同上一笔差价、重复/未知消费者、过期和跨周期/家族/同降档阻断；真实注册方法 parity、HTTP/Worker映射、功能关闭、开通未知/未开通/私测跨企业与到期、完全预留后零可用点数执行复核、旧upgrade拒绝及首购依赖透传。现有完整商家操作矩阵在零/未知点数下无副作用回归继续通过。

第一轮共享 registry 移入 contracts 后运行使用旧 dist，出现 undefined symbol；重新构建 contracts 后同一行为集通过，未通过删除功能断言解决。

应用workspace build第一轮发现 `Array.isArray` 控制流将readonly快照数组窄化为any，新增filter回调出现TS7006；已显式标注 `unknown` 修复。`npm run build --workspace @merchant-marketing/application` 修复后重跑exit 0。完整项目最终类型门禁仍由owner整合确认。

## gstack review

按 `gstack-review/SKILL.md`及完整 checklist 对本角色全部修改做两轮检查：SQL/数据安全（应用纯函数无SQL）、并发（引擎不独自授予，保存/锁由仓储）、输出信任边界（整数/有理数/定义/资格严格验证）、enum completeness（6组每个方法实际存在且enabled，HTTP/Woker/布尔升级同义）、时间边界与余数复算。关闭旧全价升级、缺资格仍放行、仅字符串额度授权三项应用层发现。Worker只查余额而未查功能的现有旁路已定位并提供共享复核接口，真实接线仍由owner完成；本角色不把未接线接口视为旁路已关闭。

## 整体验收仍待 owner

必须核验数据库quote/授予幂等与当前period revision唯一、受控销售解析、getOnboardingStatus事实、API和已预留Worker调用及内部自动化/知识embedding旁路、旧SKU功能明确批准迁移、实际合同/资格/点数/模型 readiness合取。本角色不对这些未观察runtime声称已通过。完整类型检查、本地PG/RLS、授权桌面、安装插件、101部署后真实验证另存owner证据。
