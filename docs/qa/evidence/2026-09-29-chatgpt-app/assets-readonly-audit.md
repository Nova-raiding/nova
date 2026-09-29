# Store Nova production asset/image MCP read-only check

- Time: 2026-09-29 08:20 CST.
- Surface: installed local stdio plugin cache `merchant-marketing` version `0.1.0+codex.20260929074100`, production API origin `https://yxsona.com`, workspace `ws_guirenniaoniao`.
- Auth: merchant `demo@ys.com` password session exchanged through `/v1/auth/mcp-token` for a short-lived workspace-scoped bearer, kept only in process memory. No bearer, cookie, password, asset content, or response body retained in this report.
- Login HTTP 200 and token exchange HTTP 200. Installed bridge exited 0 without stderr.

| Tool | Actual production result | Interpretation |
| --- | --- | --- |
| `asset.list({})` | MCP `isError=false`; structured response included 11 assets. | Authenticated, workspace-scoped material list works. Asset identity/content not captured. |
| `catalog.image.get({job_id:"qa-nonexistent-20260929"})` | MCP `isError=true`, `code=IMAGE_GENERATION_JOB_NOT_FOUND`. | Authenticated read reached image-job lookup and safely rejected a missing job; successful retrieval of a real image job remains untested. |

No production writes, provider calls, creative-point charge, or DB migrations were requested by this check. This does not establish that image generation, candidate selection, asset parsing, upload, rights review, or video rendering works in ChatGPT App.
