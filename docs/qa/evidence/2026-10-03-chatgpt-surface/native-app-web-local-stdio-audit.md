# ChatGPT surface and local stdio audit (2026-10-03)

## Native ChatGPT App

`cua.getApp('com.openai.codex').getAXState()` was attempted against the running ChatGPT app. The computer-use surface returned the platform error:

```
Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.
```

This is a host safety boundary. No Accessibility, AppleScript, injection, or other bypass was attempted.

## ChatGPT web session

Existing Chrome tab:

`https://chatgpt.com/c/6ac10f47-2774-83ee-9a71-91316788c4be`

The visible assistant response to a request to use Merchant Marketing stated:

> 当前没有找到名为 Merchant Marketing 的已安装/可直接调用插件，因此不能冒充使用它生成结果。

The sidebar exposes the generic Plugins page, but this web session has no local stdio Merchant Marketing tool surface.

## Local package and binding

Installed QA package:

`~/.codex/plugins/cache/merchant-local/merchant-marketing/0.1.0+codex.20261003143130`

`bundle-profile.json` identifies it as `qa-broker`, `qa_only: true`, and `release_eligible: false`.

`diagnose-workspace-binding.mjs --target-origin https://yxsona.com --workspace ws_57fd2361ed5b44c7891f3d37` reported:

```json
{
  "binding_present": true,
  "stale": true,
  "reusable": false,
  "reasons": ["loopback_to_production_origin", "identity_fingerprint_missing", "workspace_changed"],
  "stored": {
    "workspace_id": "ws_be87dca95d714bc1bbdb6c21",
    "api_origin": "http://127.0.0.1:8787",
    "has_actor_fingerprint": false,
    "has_token_fingerprint": true
  },
  "target": {
    "workspace_id": "ws_57fd2361ed5b44c7891f3d37",
    "api_origin": "https://yxsona.com"
  }
}
```

No credential broker process or socket is currently running. The package's direct Keychain helper returned `keychain operation failed` with exit code 1. A new authenticated Store Nova merchant login and local binding is required before native ChatGPT host acceptance can be rechecked.
