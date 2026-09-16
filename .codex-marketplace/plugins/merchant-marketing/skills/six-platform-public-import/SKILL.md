---
name: six-platform-public-import
description: 从京东、淘宝、天猫、拼多多、小红书或抖音的公开商品链接提取商品资料，并导入 Store Nova 待审核知识库；不读取 Cookie、不绕过登录、不执行店铺同步或发布。
metadata:
  short-description: 六平台公开商品链接导入
---

# 六平台公开商品链接导入

用于商家提供商品公开链接、希望读取商品图、标题、价格、规格或详情并沉淀到 Store Nova 知识库的场景。

## 支持范围

支持平台：京东（jd）、淘宝（taobao）、天猫（tmall）、拼多多（pinduoduo）、小红书（xiaohongshu）、抖音（douyin）。平台识别优先依据 URL 主机名，无法唯一识别时只向用户询问平台，不猜测。

提取结果必须是来源可追溯的待审核草稿，至少保存来源 URL、访问时间、提取状态和字段级证据。推荐字段包括：商品标题、店铺名（若公开）、类目、价格、SKU/规格、商品主图、详情图、公开详情文案、公开卖点和远端商品标识。

## 固定流程

1. 校验 URL：仅允许公开 HTTPS 页面；拒绝内网地址、非 HTTP(S)、带用户名密码、可疑跳转和无法证明为公开来源的链接。
2. 读取页面：只发送不带用户 Cookie、Authorization 或平台私有 token 的公开请求。优先读取 JSON-LD、页面元数据和服务端渲染内容；必要时使用无登录浏览器渲染公开页面。
3. 解析与标准化：保留原始字段的来源定位，金额统一为人民币元并保留两位小数；图片只保存公开 URL/哈希，不把图片字节或竞品原文直接写入知识库。
4. 质量检查：检查标题、价格、图片 URL、SKU 规格和详情是否缺失或互相矛盾。动态未加载、登录墙、验证码、风控或字段无法核验时，返回阻断和缺失字段，不用猜测补齐。
5. 导入草稿：将已提取字段映射到 `catalog.import` 的 `draft_only=true`，写入 `product_facts` 知识资产、文档和分块；状态固定为 `pending`、权益 `unknown`、索引 `queued`、不可发布。
6. 向商家展示摘要：只展示平台、商品标题、价格范围、图片/规格/详情的读取情况、来源和待确认字段；不展示内部 ID、Cookie、原始响应或解析脚本。

## 权限与安全边界

- “用户已在浏览器登录”不等于插件获得权限。不得导入浏览器 Cookie、复用持久化登录态、要求用户粘贴 token，或通过验证码/反爬挑战。
- 页面需要登录、仅对店主可见、返回验证码或明确禁止自动访问时，必须停止并建议上传商品导出表、HTML/PDF 或截图；不得降级为伪造数据。
- 公开页面读取不代表商品事实已确认。正式文案、图片生成、审核和发布仍需事实确认及现有 Store Nova 门禁。
- 该 skill 只负责公开资料导入，不提供库存/订单同步、自动发布、价格监控或批量爬取。

## Store Nova 接口路由

- 公开商品链接进入本 skill 后，先由当前可用的网页读取能力完成提取，再调用 `catalog.import`（`draft_only=true`）沉淀草稿。
- 若是 XLSX/CSV/JSON 资料，改走 `asset.upload` → `asset.parse` → `asset.facts.confirm` → `catalog.import.batch(draft_only=true)`。
- 读取知识库时只使用已批准且权益已确认的内容；本 skill 新产生的 pending/unknown 内容不能直接作为正式生成上下文。

平台差异、允许字段和阻断示例见 [references/platforms.md](references/platforms.md)。
