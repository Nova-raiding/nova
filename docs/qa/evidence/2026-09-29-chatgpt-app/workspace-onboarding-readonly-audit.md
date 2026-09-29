# Authenticated production workspace/onboarding read-only QA

Date: 2026-09-29T00:21:00.391Z
Account: merchant demo@ys.com; workspace id withheld from output.
Transport: HTTPS /mcp with a short-lived local stdio MCP bearer issued from authenticated merchant session. No business write methods were called.

| Method | HTTP | Outcome | Safe evidence |
| --- | ---: | --- | --- |
| onboarding.status | 200 | ok | default; response keys: schema_version,status,current_step,steps,binding,next_action,summary,initialization,guidance |
| workspace.health | 200 | ok | default; response keys: status,schemaVersion,connectors,writesEnabled,capacity,setup,persistence,plugin,mcp,workspace,rules,ruleSync,connectorReadiness,platforms,commercial,storeDirectory,onboarding_v2,storeSelection,capabilityCards |
| workspace.metrics | 200 | ok | default; response keys: generatedAt,source,dataCompleteness,hydration,selection,period,comparisonAvailable,comparisonReason,dataCoverage,stores,unboundLocalData,riskItems,riskSummary,snapshotHash,productSummary,recommendations,platformMetrics,taskFunnel,quality,jobs |
| workspace.metrics | 200 | ok | scope=jd:42169; response keys: generatedAt,source,dataCompleteness,hydration,selection,period,comparisonAvailable,comparisonReason,dataCoverage,stores,unboundLocalData,riskItems,riskSummary,snapshotHash,productSummary,recommendations,platformMetrics,taskFunnel,quality,jobs |
| workspace.metrics | 404 | PLATFORM_ACCOUNT_NOT_FOUND | scope=taobao:42169; response keys: none |
| workspace.invitations.list | 403 | FORBIDDEN | default; response keys: none |
| workspace.data.export.get | 500 | INTERNAL_ERROR | synthetic missing request id; response keys: none |
| merchant.first_value | 200 | ok | static example=true; response keys: readOnly,previewOnly,example,product,contentPreview,visualPreviewRefs,execution,nextActions,next_actions |

Notes: This report stores only status/code and response key names. No access token, cookie, password, product, store name, financial amount, or returned business payload is retained. Missing export ID is a negative-path probe, not a completed export. `merchant.first_value` was invoked with static `example=true`; the charged `draft=true` path was excluded.
## Follow-up code finding

Production's PostgreSQL export request ID column is UUID. The MCP get handler passed arbitrary strings to that query, making a malformed ID return HTTP 500. The local MemoryRepository had generated prefixed IDs, masking this mismatch. Candidate code now validates a canonical UUID and aligns the memory ID format; targeted API/persistence tests cover malformed 400, valid missing 404, existing read, and tenant isolation. This candidate has not been deployed, so the production 500 remains until release.

`workspace.invitations.list` returned 403 for demo@ys.com. The API policy may intentionally require an invitation or a specific role; the separate local bridge defect incorrectly labels it as a write and blocks it before the API in a fresh interactive session. No production invitation mutation was attempted.
