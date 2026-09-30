# Merchant 品牌资产页高度差审计

## 结论

有效参考图为微信附件 `outputs/ui-images-2026-09-28/商家后台/05-品牌资产.png`，尺寸 1440×2259。修复后 qa-clean 实际页面截图 `artifacts/ui-live-restored/2026-09-29/merchant-brands-after-fix.png` 为 1440×2259，与参考图同尺寸。

修复前差异来自“03 系列配置”与“04 单图配置”之间额外渲染的 `.material-brand-actions-row`，不是全局容器、侧栏或缩放问题。该行包括“保存品牌配置”及服务端版本状态，以及“上传品牌资料”入口，曾造成约 50px 的高度差。参考图在系列配置面板后直接显示 04 横幅，没有此操作行。

## 证据

- 目标图：`/Users/lixiaomei/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_zryx3yve75ee21_b3aa/msg/file/2026-09/outputs/ui-images-2026-09-28/商家后台/05-品牌资产.png`，1440×2259。
- 修复前实际图：`artifacts/ui-live-restored/2026-09-29/local-container-matrix/merchant/brands.png`，1440×2309；修复后图见上方，1440×2259。
- 修复前渲染位置：`demo/merchant-studio/src/App.tsx` 的 `view === 'brands'` 页面中，`.material-brand-actions-row` 紧邻 `material-brand-single-row` 之前；该行现已删除。
- 修复前尺寸规则：`demo/merchant-studio/src/styles.css` 中 `.material-brand-stack { gap:14px }`、`.material-brand-actions-row .material-upload-button { min-height:36px }`；操作行专属规则现已删除。
- `git blame` 显示该行在 commit `252835edc`（2026-09-29）加入；它不是因空白占位或后端返回内容改变而产生。

## 修复

已移除 03 与 04 之间的独立操作行和重复的“上传品牌资料”入口；各配置范围内已有品牌 Logo/文档上传控件。服务端 `saveMaterialBrandScopes` 保存能力保留，保存按钮只在表单有未保存改动或存在错误/保存反馈时出现，初始状态与目标图相符。用户改动后仍通过 `PUT /v1/brand-scopes` 保存，不会把本地状态伪装成已保存。

## 验证

qa-clean 当前实际 UI 在 Chromium 1440×1050 视口截图为 `artifacts/ui-live-restored/2026-09-29/merchant-brands-after-fix.png`，全页高度 2259px；DOM 测得 `.material-brand-actions-row` 数量 0，03→04 间距 14px，首次加载不显示保存按钮。`dogfood/chatgpt-all-functions/merchant-brand-scopes.spec.js` 实际 PUT、reload 读回并恢复原始画像，1/1 通过。测试结束后没有留下品牌画像改动；参考图和数据库租户数据均未被硬编码或清除。
