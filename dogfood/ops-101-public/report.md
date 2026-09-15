# 101 公网桌面 UI QA 报告

| 字段 | 值 |
|---|---|
| 日期 | 2026-09-14（Asia/Shanghai） |
| 分辨率 | 1440 × 1000，桌面 Chromium |
| 商家页面 | `https://yxsona.com/merchant/login/merchant/overview` |
| 运营页面 | `https://ops.yxsona.com/ops/users`、`https://ops.yxsona.com/ops/finance` |
| 范围 | CSS、登录边界、控制台/网络错误、菜单层级、一屏展示、账号信息、生产就绪语义 |
| 数据安全 | 只读；未执行运营写操作；报告与共享截图不包含登录凭据 |

## 结论

**当前 101 公网环境不可判定为可上线。** 页面入口、TLS、重定向和 CSS 正常，但服务端公开 readiness 在 `fixture`、禁止写入、生产门禁失败的情况下仍返回 `status=ok`，商家页面据此显示“系统健康 在线”。此外，现有平台运营测试账号无法建立公网会话，导致 `/ops/users` 与 `/ops/finance` 的权限、真实数据、失败数据集和账号名显示无法完成上线验收。

| 严重度 | 数量 |
|---|---:|
| Critical | 1 |
| High | 2 |
| Medium | 3 |
| Low | 2 |
| **合计** | **8** |

## 已通过项目

- `yxsona.com` 与 `ops.yxsona.com` 可访问，HTTP 到 HTTPS 保留原路径并返回 308。
- 三个目标 URL 均返回 HTML 200；未登录时只展示对应登录页，未泄露后台页面数据。
- 商家 2 个、运营 30 个静态资源均返回 200，CSS MIME 正确，截图确认样式已实际应用。
- 商家测试 harness 账号可通过公网登录，密码输入保持遮罩。
- 商家“知识库”是可展开/收起的二级菜单：`aria-expanded` 从 `false → true → false`，收起后六个子项均不可见。
- 商家顶部账号区只显示一次账号名称；头像首字不是重复账号名，且视觉居中。
- 已登录商家流程未出现 `Failed to fetch`；控制台仅记录登录前 `/api/v1/auth/session` 的预期 401。

## 问题

### ISSUE-001：生产 readiness 在明确未通过生产门禁时仍返回 `ok`

| 字段 | 值 |
|---|---|
| 严重度 | Critical |
| 类别 | 发布门禁 / 数据语义 |
| URL | `https://yxsona.com/readyz`、`https://ops.yxsona.com/readyz` |
| 证据 | [readiness-summary.json](readiness-summary.json)、[商家概览截图](screenshots/merchant-overview-authenticated-1440x1000.png) |

两个公网 origin 的匿名 `/readyz` 均返回 HTTP 200 且 `status=ok`，但同一响应明确显示：

- `setup.mode=fixture`
- `writesEnabled=false`
- `productionGate=false`
- `objectStorage.mode=local`
- `credentialProvider.mode=fixture`
- 六个平台均为 `fixture_ready`，OAuth 和真实 HTTP connector 均未配置
- 生产 capability/capacity 证据未配置

商家 UI 同时显示“系统健康 在线”和“演示数据/淘宝 Fixture 店”。这不是可上线状态，顶层健康绿灯会掩盖真正的生产阻断。

**上线要求：** 公网生产就绪状态必须 fail-closed；只有 `productionGate=true`、无 fixture/local 依赖、真实 OAuth/connector、对象存储、凭据服务和生产证据全部通过时，才允许返回生产健康并显示绿色“在线”。

---

### ISSUE-002：公网运营后台没有可用的测试验收会话

| 字段 | 值 |
|---|---|
| 严重度 | High |
| 类别 | 登录 / 上线验收阻断 |
| URL | `https://ops.yxsona.com/ops/users` |
| 证据 | [已脱敏的登录失败截图](screenshots/ops-users-authenticated-1440x1000.png)、[网络观察](ops-authenticated-observations.json) |

按照仓库现有测试 harness 提供的平台运营 fixture 执行真实 UI 登录，`POST /api/v1/auth/login` 返回 401，页面显示“账号或密码错误”。截图已在提交后清空账号和密码字段。

这不能证明所有真实管理员都无法登录，但证明当前无法建立受控、可审计的生产 QA 会话。因此下面的关键项目全部未验收：

- `/ops/users` 的用户数量、真实来源、分页、详情与权限；
- 超级管理员是否确实获得所有应有平台能力；
- `/ops/finance` 的账务、退款、消耗与对账数据；
- “部分数据集刷新失败”与详情重试；
- 登录后账号名称是否仍重复、头像文字是否居中；
- 页面导航和一屏展示。

**上线要求：** 提供专用、最小必要权限、可撤销且可审计的公网 QA 身份，或通过受控测试 harness 创建短期签名会话；完成上述页面真实验收后才能关闭此阻断。

---

### ISSUE-003：商家公网验收只能证明 fixture 流程，不能证明真实经营数据

| 字段 | 值 |
|---|---|
| 严重度 | High |
| 类别 | 数据正确性 / 上线证据 |
| URL | `https://yxsona.com/merchant/login/merchant/overview` |
| 证据 | [商家概览截图](screenshots/merchant-overview-authenticated-1440x1000.png) |

登录成功后，页面明确显示“本地演示工作区”“演示数据”“淘宝 Fixture 店”“0 家可读取真实店铺”。这对测试账号本身是自洽的，但只能证明演示链路可用，不能证明真实租户、真实店铺、真实商品及权限隔离可用。

**上线要求：** 使用单独的受控真实试点工作区完成至少一条真实平台只读同步链路，并验证页面无 fixture 标签、租户数据计数与 API/数据库一致；不得把当前演示账号结果当作生产成功证据。

---

### ISSUE-004：商家概览仍未完全满足“一屏展示”目标

| 字段 | 值 |
|---|---|
| 严重度 | Medium |
| 类别 | UI / 信息架构 |
| URL | `https://yxsona.com/merchant/login/merchant/overview` |
| 证据 | [1440×1000 首屏](screenshots/merchant-overview-authenticated-1440x1000.png)、[完整页面](screenshots/merchant-overview-authenticated-full.png) |

在指定的 1440×1000 桌面视口下，文档高度为 1071px，六平台列表底部超出首屏约 71px。同时“平台连接”只占内容区约一半宽度，右侧保留大量空白；可以在不牺牲信息的情况下采用双列或更紧凑的异常优先摘要。

**期望：** 首屏优先展示真实店铺、待处理问题和下一步动作；六个平台的无店铺占位应压缩，不应逐行消耗主要高度。

---

### ISSUE-005：商家首屏静态资源缺少压缩和 hashed 长缓存

| 字段 | 值 |
|---|---|
| 严重度 | Medium |
| 类别 | 性能 |
| URL | `https://yxsona.com/merchant/login/merchant/overview` |
| 证据 | [JS 响应头](network/yxsona.com_assets_index-CBjJjGKT.js.txt)、[CSS 响应头](network/yxsona.com_assets_index-DdEUx7Wy.css.txt) |

商家入口 JS/CSS 合计约 1.40MB，其中主 JS 为 1,283,210B。响应没有 `Content-Encoding`，也没有对带 hash 文件设置 `Cache-Control: public, max-age=31536000, immutable`。本次冷浏览器经代理加载主 JS 曾耗时约 28 秒并触发 15 秒导航超时；公网直连虽然更快，弱网用户仍会承担完整下载成本。

**期望：** 对 JS/CSS 开启 Brotli 或 gzip；hashed 静态文件启用 immutable 长缓存；HTML 继续 `no-store`。

---

### ISSUE-006：运营入口资源未压缩且仅协商 HTTP/1.1

| 字段 | 值 |
|---|---|
| 严重度 | Medium |
| 类别 | 性能 |
| URL | `https://ops.yxsona.com/ops/users`、`/ops/finance` |
| 证据 | [入口 JS 响应头](network/ops.yxsona.com_ops_assets_index-DL4H8bsV.js.txt)、[入口 CSS 响应头](network/ops.yxsona.com_ops_assets_index-B-Rpq80q.css.txt) |

运营入口共加载约 1.35MB、30 个模块资源。hashed 长缓存已正确开启，但没有 gzip/Brotli，TLS 请求只协商到 HTTP/1.1；首次加载会承受多资源 RTT 与未压缩传输成本。

**期望：** 启用 Brotli/gzip，并优先提供 HTTP/2；保留现有 immutable 缓存。

---

### ISSUE-007：公开登录页面缺少 Content-Security-Policy

| 字段 | 值 |
|---|---|
| 严重度 | Low |
| 类别 | 安全响应头 |
| URL | 两个公网登录入口 |
| 证据 | [商家响应头](network/yxsona.com-headers.txt)、[运营响应头](network/ops-users-headers.txt) |

两个公开登录面均未返回 `Content-Security-Policy`。当前未观察到可利用的 XSS，但登录页属于公开认证边界，应在上线门禁中配置并验证 CSP。

---

### ISSUE-008：运营深链返回重复且冲突的安全头

| 字段 | 值 |
|---|---|
| 严重度 | Low |
| 类别 | 网关配置 |
| URL | `https://ops.yxsona.com/ops/users`、`/ops/finance` |
| 证据 | [运营响应头](network/ops-users-headers.txt) |

同一响应重复返回两组 `X-Content-Type-Options` 和 `X-Frame-Options`，并同时返回 `Referrer-Policy: no-referrer` 与 `strict-origin-when-cross-origin`。功能目前可用，但浏览器最终策略依赖多值解释，网关和上游配置应合并为单一、明确的值。

## 未观察到的问题

- 未观察到 CSS 404 或页面无样式。
- 未观察到页面级 `Failed to fetch`。
- 商家账号名未重复，头像首字居中。
- 商家知识库二级菜单可以展开与收起。

## 下一轮准入条件

1. 修正 production readiness 的 fail-closed 语义，重新验证两个 origin。
2. 提供可用的受控平台运营 QA 会话。
3. 对 `/ops/users`、`/ops/finance` 完成登录后多轮测试，并与 API/数据库计数交叉校验。
4. 使用真实试点商家工作区完成非 fixture 的只读同步验收。
5. 修复后重新执行 1440×1000 截图、控制台、失败请求与响应头回归。
