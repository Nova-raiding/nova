# Release-gate subset verification (2026-10-05)

The current worktree passed the release-gate layers that can run safely without a production cutover:

- `npm run test:release-gates:node`: **165/165** tests passed.
- `npm run test:release-gates:runtime`: **23/23** tests passed, including isolated API/worker bridge and model-usage settlement.
- `npm run test:ecs-bridge-255-store`: protected store acceptance passed.
- `npm run test:pg16-migration-compatibility`: **1/1** test passed.
- `npm run test:capacity:no-load`: **4/4** tests passed.
- `npm run test:screenshot-matrix-evidence`: **3/3** tests passed.

These results validate code and isolated runtime contracts. They do not provide candidate-bound production capability/capacity evidence, Keychain credentials, relay provider receipts, owner semantic attestations, or online candidate/image identity.
