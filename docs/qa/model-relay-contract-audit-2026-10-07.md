# Model relay contract coverage audit — 2026-10-07

## Scope and safety

Audited the model-relay text, image, image-edit, OCR, and video call boundaries. CodeGraph was used to locate the platform gate, provider adapters, dispatch-admission hooks, and usage/cost recorder. Baseline was `main` at `a515d313f8eefe9027ef8a26f861272101f31664`; CodeGraph reported 2,729 indexed files, 38,642 nodes, and an up-to-date index.

All new network behavior is intercepted by injected `fetch` mocks. The only response used for the new auth contract is a synthetic HTTP 401. No provider endpoint was contacted, no generation was submitted, and no real secret or credential was read or included in this report. No production source file was changed.

## Coverage found before this patch

| Concern | Existing evidence inspected (not rerun in this targeted pass) |
|---|---|
| Relay configuration readiness | `packages/ai/src/platform-model-gate.test.ts` covers platform-owned gate and quota behavior; `tests/model-relay-local-contract.test.ts` already covered missing endpoint across the five primary modalities. |
| Fail-closed provider outcomes | `packages/ai/src/relay-contract-audit.test.ts` covers explicit 4xx failures, ambiguous 408/5xx outcomes, request correlation, and missing cost evidence across six modalities. `packages/ai/src/provider-request.test.ts` covers bounded retry and no retry for unknown outcomes. |
| Dispatch authorization | `packages/ai/src/provider-dispatch-admission.test.ts` covers denial before I/O, recheck after delayed preflight, retry-time revocation, and factory hook forwarding for text/image/image-edit/OCR/video. |
| Usage and cost recording | `packages/ai/src/relay-usage.test.ts` covers successful receipt/sink recording for text/image/image-edit/OCR/video/embedding and the production missing-sink guard. `tests/model-relay-local-contract.test.ts` also covers missing usage, cost, sink, and identity for the five primary modalities. |
| Modality-specific adapters | `packages/ai/src/generator.test.ts`, `image-generator.test.ts`, `image-facts.test.ts`, and `video-generator.test.ts` contain additional mock relay request, parsing, usage, timeout, and settlement cases. |

## Gaps filled

1. Missing relay API credentials now explicitly fail the platform gate for each of text, image, image-edit, OCR, and video; the video-specific key and common fallback are both removed in the fixture.
2. Each text/image/image-edit/OCR/video adapter now has direct mock evidence that its request goes to the configured test relay, carries the configured Bearer credential, treats a 401 as a failed provider request, does not call the usage sink on that rejected response, and does not place the fixture key in error text, serialized error evidence, or captured `console.log`/`warn`/`error` calls.
3. Each of the same five adapters now proves that production-mode dispatch without a usage settlement sink fails with `MODEL_USAGE_EVIDENCE_MISSING` before the injected fetch can run.

Only relay test files changed: `packages/ai/src/provider-dispatch-admission.test.ts` and `tests/model-relay-local-contract.test.ts`. No production source file changed (within the requested maximum of one).

## Verification evidence

Command:

```text
npx vitest run packages/ai/src/provider-dispatch-admission.test.ts tests/model-relay-local-contract.test.ts -t 'sends configured relay authentication|fails .* closed when relay credentials are absent|fails closed before fetch when production usage settlement is not configured' --reporter=dot
```

Result:

```text
Test Files  2 passed (2)
Tests       15 passed | 43 skipped (58)
Duration    5.99s
```

The 43 skipped cases were excluded by the test-name filter; previously covered scenarios were not rerun. The five auth cases use a fetch stub and synthetic 401; the five production-sink cases assert fetch is never called; the five credential cases are pure local gate evaluations.

## Limits

This is local contract evidence, not proof of live relay credentials, provider billing, external usage receipts, or production configuration. Those require a separately authorized real-environment verification and are intentionally not claimed here.
