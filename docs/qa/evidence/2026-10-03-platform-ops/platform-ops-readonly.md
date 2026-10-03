# Platform Ops Playwright read-only evidence
generated_at=2026-10-03T07:50:06Z
base=https://ops.yxsona.com

## Browser route matrix
- /ops/overview: document_status=200, final_url=https://ops.yxsona.com/ops/overview, heading=欢迎回来, login_labels=平台运营账号 | 密码, body=欢迎回来 / 请使用平台管理员分配的运营账号登录 / 平台运营账号 / 密码 / 登录平台运营后台
- /ops/users: document_status=200, final_url=https://ops.yxsona.com/ops/users, heading=欢迎回来, login_labels=平台运营账号 | 密码, body=欢迎回来 / 请使用平台管理员分配的运营账号登录 / 平台运营账号 / 密码 / 登录平台运营后台
- /ops/tenants: document_status=200, final_url=https://ops.yxsona.com/ops/overview, heading=欢迎回来, login_labels=平台运营账号 | 密码, body=欢迎回来 / 请使用平台管理员分配的运营账号登录 / 平台运营账号 / 密码 / 登录平台运营后台
- /ops/permissions: document_status=200, final_url=https://ops.yxsona.com/ops/overview, heading=欢迎回来, login_labels=平台运营账号 | 密码, body=欢迎回来 / 请使用平台管理员分配的运营账号登录 / 平台运营账号 / 密码 / 登录平台运营后台
- /ops/billing: document_status=200, final_url=https://ops.yxsona.com/ops/overview, heading=欢迎回来, login_labels=平台运营账号 | 密码, body=欢迎回来 / 请使用平台管理员分配的运营账号登录 / 平台运营账号 / 密码 / 登录平台运营后台
- /ops/rules: document_status=200, final_url=https://ops.yxsona.com/ops/rules, heading=欢迎回来, login_labels=平台运营账号 | 密码, body=欢迎回来 / 请使用平台管理员分配的运营账号登录 / 平台运营账号 / 密码 / 登录平台运营后台
- /ops/models: document_status=200, final_url=https://ops.yxsona.com/ops/models, heading=欢迎回来, login_labels=平台运营账号 | 密码, body=欢迎回来 / 请使用平台管理员分配的运营账号登录 / 平台运营账号 / 密码 / 登录平台运营后台
- /ops/audit: document_status=200, final_url=https://ops.yxsona.com/ops/audit, heading=欢迎回来, login_labels=平台运营账号 | 密码, body=欢迎回来 / 请使用平台管理员分配的运营账号登录 / 平台运营账号 / 密码 / 登录平台运营后台

## Unauthenticated API probes
### GET /api/v1/auth/session
{"request_id":"req_34960448-4274-4f2a-8f8f-8e120d785858","trace_id":"req_34960448-4274-4f2a-8f8f-8e120d785858","workspace_id":"unknown","data":null,"warnings":[],"next_actions":[],"error":{"code":"AUTH_SESSION_INVALID","message":"会话已过期，请重新登录"}}
HTTP_STATUS=401
### GET /api/v1/ops/users
{"request_id":"req_f3fe1b28-bfd7-4258-abea-429679b026eb","trace_id":"req_f3fe1b28-bfd7-4258-abea-429679b026eb","workspace_id":"unknown","data":null,"warnings":[],"next_actions":[],"error":{"code":"UNAUTHENTICATED","message":"生产请求必须携带有效 Bearer token"}}
HTTP_STATUS=401
### GET /api/v1/ops/tenants
{"request_id":"req_f0d8aa98-bd9d-4a21-823a-8c42165ced6f","trace_id":"req_f0d8aa98-bd9d-4a21-823a-8c42165ced6f","workspace_id":"unknown","data":null,"warnings":[],"next_actions":[],"error":{"code":"UNAUTHENTICATED","message":"生产请求必须携带有效 Bearer token"}}
HTTP_STATUS=401
### GET /api/v1/ops/permissions
{"request_id":"req_a35b0dbc-1fde-4a50-ab95-09e62efe7fa9","trace_id":"req_a35b0dbc-1fde-4a50-ab95-09e62efe7fa9","workspace_id":"unknown","data":null,"warnings":[],"next_actions":[],"error":{"code":"UNAUTHENTICATED","message":"生产请求必须携带有效 Bearer token"}}
HTTP_STATUS=401
### GET /api/v1/ops/billing
{"request_id":"req_0965438a-11f6-4042-ae48-1969ea95124d","trace_id":"req_0965438a-11f6-4042-ae48-1969ea95124d","workspace_id":"unknown","data":null,"warnings":[],"next_actions":[],"error":{"code":"UNAUTHENTICATED","message":"生产请求必须携带有效 Bearer token"}}
HTTP_STATUS=401
### POST /api/mcp
{"request_id":"req_f7ad727f-bdc8-4ddd-acb8-b01d4d70f8bb","trace_id":"req_f7ad727f-bdc8-4ddd-acb8-b01d4d70f8bb","workspace_id":"unknown","data":null,"warnings":[],"next_actions":[],"error":{"code":"UNAUTHENTICATED","message":"MCP 请求必须携带本地插件凭据"}}
HTTP_STATUS=401

## Login negative probe
{"request_id":"req_4b036173-76c4-420e-a12a-78dbc7fdfc5f","trace_id":"req_4b036173-76c4-420e-a12a-78dbc7fdfc5f","workspace_id":"unknown","data":null,"warnings":[],"next_actions":[],"error":{"code":"AUTH_INVALID_CREDENTIALS","message":"账号或密码错误"}}
HTTP_STATUS=401
