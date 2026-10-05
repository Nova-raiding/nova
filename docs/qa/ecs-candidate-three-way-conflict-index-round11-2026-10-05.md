# Three-way conflict index — round 11 (2026-10-05)

The isolated merge produced 74 paths with unresolved conflict markers. They
are distributed across `apps` (54), `packages` (12), `demo` (5), and `scripts`
(3). The largest conflict sets are:

- `apps/api/src/server.ts`: 107 conflict regions;
- `demo/merchant-studio/src/App.tsx`: 28;
- `apps/ops-console/src/components/delivery/CustomerDeliverySection.tsx`: 19;
- `apps/worker/src/main.ts`: 14;
- `scripts/model-relay-canary.ts`: 13;
- `apps/ops-console/src/pages/CustomerDeliveryPage.tsx`: 10.

The complete per-path output remains in the isolated merge report at
`/tmp/ecs-three-way-merge.ITL5NA/three-way-merge-report.json`. No conflict was
resolved automatically; each path still needs a semantic owner decision.
