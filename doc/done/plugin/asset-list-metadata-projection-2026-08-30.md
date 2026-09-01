# 素材列表元数据投影

## 结论

已完成：`asset.list` 为每个素材返回文件大小、创建时间和来源，bridge 继续将它们投影为商家可读字段。

- `sizeBytes` / `size_bytes`
- `createdAt` / `created_at`
- `source`: `merchant_upload` 或 `generated`

来源只表达系统已知的入口，不把演示数据或真实平台事实混为一谈。

## 代码落点

- `apps/api/src/server.ts`
- `apps/plugin/mcp/bridge.mjs`
- `.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs`
- `apps/api/src/asset-parse.e2e.test.ts`

## 验证证据

- 素材解析/列表回归：3 个测试文件、95 项通过
- 类型检查、release metadata gate、release gates 均通过

## 边界

当前仍未虚构绑定商品摘要、外部扫描证据或真实宿主附件句柄；这些信息只有在对应后端/宿主契约真实存在并验证后才会进入完成文档。
