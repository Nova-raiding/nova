# Store Nova installed stdio read-only regression

- Captured at: 2026-09-29 23:10 CST
- Installed version: `0.1.0+codex.20260929213938`
- Bridge SHA-256: `3c43754291974e34546d5722eb8813c3e89f7b8fddc8c0dba63ca81a826aa9f2`
- Configured API origin: `https://yxsona.com`
- Configured workspace: `ws_guirenniaoniao`
- Safety scope: read-only calls only; no generation, purchase, payment, export request, approval, publish, delete, or other state-changing call was executed.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| MCP initialize | Pass | Server returned `merchant-marketing` version `0.1.0+codex.20260929213938`; no stderr. |
| Tool discovery | Pass | `tools/list` returned exactly 116 tools. |
| Read-only entry invocation | Blocked safely | 35 zero-argument read tools were invoked and all returned `MCP_CREDENTIAL_SOURCE_INVALID`. The bridge said no backend request was sent. |
| Dependent reads | Not applicable | 11 reads require real IDs from safe list calls; none were available because credential validation failed first. |
| Identity/workspace/subscription/balance | Not verified | `onboarding.status`, `workspace.health`, `commercial.access.get`, `subscription.get`, `creative-points.balance.get`, and `catalog.search` all reached the bridge and failed at the same credential gate. |
| Writes/external effects | Intentionally not run | 70 tools were excluded by the safety policy. |

## Finding

The installed bridge is startable and its MCP contract is discoverable, but a newly spawned stdio process cannot currently read the bound credential from the configured Keychain source. This is a live regression/blocker for fresh ChatGPT plugin sessions. It must not be reported as successful account, workspace, subscription, balance, or catalog verification.

The failure is fail closed: all affected calls returned before contacting the backend, so this probe incurred no model usage, creative-point charge, business write, approval, publish, or deletion.

## Root-cause follow-up

The successful lifecycle capture used the QA-only seeded credential broker. At the time of this regression there was no broker process and no `v1.sock`; only the broker runtime file remained. A temporary unseeded broker was started to distinguish a missing socket from an OS credential problem. Its native Keychain read returned only the safe diagnostic `keychain_osstatus=-25293 operation=read`, with zero credential bytes. The temporary broker was then stopped and its socket was removed.

The merchant desktop UI independently reports `尚未验证`; its help dialog says `一键授权暂未开放` for `demo@ys.com` and `ws_guirenniaoniao`. Therefore a fresh QA broker cannot be safely reseeded through the currently deployed merchant workflow. Reusing a token from an old capture, weakening credential checks, enabling production one-click authorization, or changing to environment-token fallback would violate the authentication and release gates and was not attempted.

The minimum safe recovery is a new authorized local-plugin login after the production authorization gate is deliberately opened for this package, or a new package with authenticated native IPC. There is no token-free source-only change that can reconstruct the missing credential.

## Machine-readable evidence

[`stdio-213938-readonly-regression.json`](stdio-213938-readonly-regression.json) contains the complete 116-row inventory, per-tool status, response digests, plugin version, bridge digest, and safety classification. It is mode `0600` because it records runtime response metadata.
