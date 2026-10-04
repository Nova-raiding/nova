# Ops 只读登录验收（2026-10-04）

- 入口：`https://ops.yxsona.com/ops/overview`
- 页面初始重定向：`https://ops.yxsona.com/` → `/ops/overview`，HTTP 302。
- 静态资源均返回 200；线上主 bundle：`/ops/assets/index-BNQl0CuS.js`。
- 使用用户明确提供的测试凭据 `demo@ys.com`（密码不写入证据）提交平台运营后台登录。
- 服务端返回：`POST /api/v1/auth/login` → HTTP 403 Forbidden。
- 页面恢复可交互登录表单，没有泄漏服务端堆栈或控制台异常；该账号未获得 Ops 平台运营权限，无法继续访问总览、用户中心或客户交付。
- 未执行任何业务写入、上传、导出、确认或删除。

证据截图：`login-403.png`。密码未保存到报告、截图路径或日志。
