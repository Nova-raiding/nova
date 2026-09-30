# 六平台公共规则来源与导入门禁审计

审计时间：2026-09-30（Asia/Shanghai）

## 结论

当前仓库没有六个平台可直接上线的真实规则数据，也没有由受信规则运营方签发的 manifest。现有代码包含签名、摘要、版本冲突、持久化和审计机制，但测试使用的是合成规则内容，只能证明机制契约，不能证明任何平台的真实规则已经采集、复核或可用。

因此，图片、图片编辑、视频和发布流程依赖的平台规则门禁必须继续 fail closed。不得把目录页、搜索摘要、测试 fixture 或 `manual://` 草稿转换成生产 `checks`。

## 已核验的公开入口

| 平台 | 当前代码绑定入口 | 公开可访问情况 | 能否直接形成生产规则 |
| --- | --- | --- | --- |
| 京东 | <https://rule.jd.com/rule/list.action> | 官方规则中心目录依赖 JavaScript | 否；缺具体规则文章、版本和原文快照 |
| 淘宝 | <https://developer.alibaba.com/doc/doc.htm?articleId=120797&docType=1&treeId=23> | 官方开放平台页面；另有商品发布 Schema API 文档 | 否；当前绑定页面不能代表完整、当前的商品内容规则 |
| 天猫 | <https://www.tmall.com/wow/seller/act/guize> | 官方规则入口 | 否；缺具体规则文章、版本和原文快照 |
| 拼多多 | <https://www.yangkeduo.com/home/help/> | 官方帮助中心含“商家规则”入口 | 否；该目录不是版本化规则正文 |
| 小红书 | <https://school.xiaohongshu.com/> | 官方电商学习中心可见规则目录和商品发布帮助入口 | 否；规则会持续更新，且部分内容需要登录或页面接口 |
| 抖音 | <https://school.jinritemai.com/doudian/web/home> | 官方电商学习中心可见规则中心、文章更新时间和公示状态 | 否；必须区分征集、公示和正式生效版本 |

## 现有导入格式

`packages/review/src/platform-rule-manifest.ts` 接受 HMAC-SHA256 签名的 JSON 原始字节。顶层格式为：

```json
{
  "schema_version": "1",
  "generated_at": "2026-09-30T00:00:00.000Z",
  "entries": [
    {
      "platform": "douyin",
      "pack_id": "operator-assigned-stable-id",
      "name": "source-derived-rule-name",
      "version": "source-derived-version",
      "source_reference": "https://school.jinritemai.com/doudian/web/home",
      "source_checked_at": "2026-09-30T00:00:00.000Z",
      "checks": {
        "forbidden_terms": [],
        "required_fields": [],
        "conflict_keys": []
      },
      "severity": "error",
      "action": "block",
      "effective_from": "2026-09-30T00:00:00.000Z",
      "effective_to": "2026-10-30T00:00:00.000Z"
    }
  ]
}
```

签名放在 HTTP 响应头 `x-rule-manifest-signature`。生产密钥必须来自 Secret Manager；manifest 必须使用 HTTPS、不可变地址，并保留采集原文、检查时间、操作者和签发记录。

示例中的空 `checks` 只是格式说明，不能用于导入或激活。

## 审计中发现并修复的契约缺口

1. `source_reference` 原先必须与六个平台的目录 URL完全相等。现已改为校验平台对应的官方 HTTPS 域名和批准路径，允许绑定具体规则文章，同时拒绝跨平台 URL、仿冒子域、账号密码 URL和未批准路径。
2. 文档原先声称人工草稿不能激活，与运行时代码冲突。现在统一为：人工导入使用 `internal` 类型和具体官方文章 URL，创建草稿后由不同审批人持服务端签发凭证激活；`manual://` 不能进入可信规则。
3. 签名 manifest 继续以受信签名方作为审批边界；激活审计新增 manifest URL、manifest 字节摘要、签名摘要、验签结果和具体规则来源 URL，不把调用者填写的来源当作签名证据。
4. 现有测试仍只证明机制和治理契约，不包含真实平台正文、原始快照、生产规则运营签名密钥或正式审批人证据。

## 解除门禁所需证据

每个平台至少需要：

1. 具体官方规则文章 URL、平台显示的版本或生效时间、采集时间和不可变原文快照摘要。
2. 从原文到每个 `checks` 字段的可复核映射；禁止从目录标题或搜索摘要推导禁词和必填字段。
3. 受信规则运营方对 manifest 原始字节的签名和签发审计。
4. 人工链路需要导入者和审批者两名不同主体的服务端身份、审批时间、审批对象摘要和不可篡改审计；签名链路由受信签名方承担审批边界并保留验签证据。
5. 隔离数据库完成导入、审批、激活、商家读取、生成前阻断、过期阻断和审计回放后，才可考虑生产导入。

## 本次测试

运行以下安全测试，内存/API 契约为 26/26 通过。随后使用项目隔离 PostgreSQL 入口单独执行持久化专项测试，1/1 通过，报告位于 `artifacts/isolated-postgres/run-9l7MMX/vitest.json`：

```text
packages/review/src/platform-rule-manifest.test.ts
packages/review/src/platform-rule-sync.test.ts
packages/review/src/platform-rule-markdown.test.ts
apps/api/src/platform-rule-sync.e2e.test.ts
apps/api/src/mcp-public-rule-governance-handlers.test.ts
apps/api/src/mcp-public-rule-governance.acceptance.test.ts
packages/persistence/src/rule-governance-review.postgres.test.ts
```

本次没有写入生产数据库，没有生成真实平台 `checks`，也没有把 fixture 标成上线证据。
