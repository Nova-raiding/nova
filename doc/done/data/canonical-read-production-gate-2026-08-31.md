# Canonical 切读生产开关门禁

日期：2026-08-31

## 结论

已补齐 canonical 商品链生产切读的控制面保护。生产环境通过 `ops.feature-flag.upsert` 写入 `canonical.product.read_mode=canonical_read`（默认值或 workspace 覆盖）时，API 直接返回 `CANONICAL_CUTOVER_EVIDENCE_REQUIRED`，不会保存危险开关；`legacy_shadow` 与 `dual_verify` 仍可用于灰度观察，测试环境原有验证语义不变。

## 验证证据

- API、feature-flag 与质量门禁定向回归：55/55 通过。
- `server.test.ts`：28/28 通过；覆盖恶意/非数组 `targets` 输入不会触发检测函数异常。
- `npm run typecheck -- --pretty false`：通过。
- `npm run test:release-gates`：57 个测试文件通过、1 个跳过；323 项通过、6 项跳过。
- `npm test`：332 个测试文件通过、15 个跳过；2,185 项通过、28 项跳过。
- `git diff --check`：通过。
- CodeGraph：781 files / 10,910 nodes / 40,638 edges；代码变更已同步。

该项只闭合仓库内的 fail-closed 控制面逻辑；真实 PostgreSQL/RLS、多副本 shadow 周期、生产签名 cutover evidence、回滚演练和正式 ChatGPT 宿主验收仍是独立上线门禁。
