import type { InvariantMutation } from './registry.js'

/**
 * One wallet action must cost the workspace exactly what the provider charged
 * for it, however late or interleaved the settlement and the reversal arrive.
 *
 * Since the third audit round the amount is defined in exactly one module,
 * `packages/persistence/src/debit-key.ts`: the key's row set
 * (`debitKeyOrderIds`) and the arithmetic over it (`effectiveDebitFenOf` /
 * `effectiveDebitFensOf`). Every consumer reads that definition — the durable
 * SQL aggregate in `billing-repository.ts`, the memory wallet's settlement and
 * reversal in `apps/api/src/server.ts`, and the reconciliation report that
 * compares the wallet against the provider's charge. Before that, four
 * implementations existed and two of them disagreed: the endpoint aggregated
 * `actionId + settlement:* - settlement-refund:*` for itself, without the
 * `refund:<key>` row, so the correct reversal-first ledger this branch shipped
 * was reported `needs_review` while a ledger that over-credited the workspace
 * reconciled clean.
 *
 * The four rows below break that single point in the four ways this branch
 * actually broke it: an aggregate that forgets the reversal row, a lock taken
 * after the read it is supposed to serialize, a sibling consumer left on the
 * old arithmetic, and a hand-copied arithmetic in the memory fixture.
 */
export const mutations: InvariantMutation[] = [
  {
    id: 'billing-effective-amount-refund-term',
    chokepointSymbol: 'effectiveDebitFen',
    invariant:
      'The effective amount for a debit key counts a reversal already on the ledger, so a settlement that arrives after the reversal charges the provider-reported amount instead of crediting the pre-authorization again.',
    chokepoint: 'packages/persistence/src/billing-repository.ts',
    file: 'packages/persistence/src/billing-repository.ts',
    // Restores the arithmetic the branch shipped first: `settleDebit` recognised
    // `settlement:*` only, so the reversal was invisible to it.
    find: `"SELECT COALESCE(SUM(CASE WHEN type='debit' THEN amount_fen ELSE -amount_fen END),0)::bigint AS effective_fen FROM billing_transactions WHERE workspace_id=$1 AND order_id = ANY($2::text[]) AND type IN ('debit','refund')", [workspaceId, debitKeyOrderIds(debitKey)]`,
    replace: `"SELECT COALESCE(SUM(CASE WHEN type='debit' THEN amount_fen ELSE -amount_fen END),0)::bigint AS effective_fen FROM billing_transactions WHERE workspace_id=$1 AND order_id = ANY($2::text[]) AND type IN ('debit','refund') AND order_id NOT LIKE 'refund:%'", [workspaceId, debitKeyOrderIds(debitKey)]`,
    evidence: 'packages/persistence/src/billing-effective-amount.postgres.test.ts',
    overRejection: {
      // The mirror of a definition that counts too few of the key's rows is one
      // that counts them with the wrong sign: a reversal that is added to the
      // amount instead of subtracted from it refunds the workspace twice over.
      find: "SUM(CASE WHEN type='debit' THEN amount_fen ELSE -amount_fen END)",
      replace: "SUM(CASE WHEN type='debit' THEN amount_fen ELSE amount_fen END)",
      why: 'a settlement that reads the reversal as another debit is the opposite failure of one that does not read it at all: the amount is wrong in both directions, so the same ledger assertion has to catch it',
    },
    evidenceFailsWith: 'the settlement delta the ledger records for a reversal-first debit key',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: '(?:settlement-refund|settlement|refund):\\$\\{(?:debitKey|key)\\}',
          sample: 'return `refund:${debitKey}`',
          allow: ['packages/persistence/src/debit-key.ts', 'tests/invariants'],
          why: 'the set of ledger rows one debit key owns is defined once, by `debitKeyOrderIds`; assembling it again from the same key prefixes anywhere else is the second implementation this row cannot see, and is exactly what the API reconciliation path did',
        },
        {
          pattern: 'NOT LIKE \'refund:%\'|NOT LIKE "refund:%"',
          sample: "AND order_id NOT LIKE 'refund:%'",
          allow: ['tests/invariants'],
          why: 'a query that filters the reversal row out of the amount is the second, divergent arithmetic this branch shipped; the definition lives in `debit-key.ts` and no consumer may narrow it by hand',
        },
      ],
    },
    requires: 'PERSISTENCE_RELEASE_DATABASE_URL',
    rationale:
      'This is the half of the aggregate the branch shipped broken: `settleDebit` recognised `settlement:*` only, so with the reversal already written the effective amount came out as the untouched reservation, the delta went negative, and the whole pre-authorization was handed back on top of the refund (1060 instead of 960 on a 1000 top-up). The chokepoint now reads every row the key owns; dropping the `refund:<key>` term restores exactly the old arithmetic. The reversal row itself is written under `reversalOrderId`, so the same mutation makes the reversal-first ledger report a settlement-refund instead of the provider-reported charge.',
  },
  {
    id: 'billing-effective-amount-lock-order',
    chokepointSymbol: 'PostgresBillingRepository',
    invariant:
      'Every path that reads the effective amount for a debit key before writing it takes the workspaces row lock as its first statement, so a concurrent replay of one idempotency key replays its existing row instead of racing it into the unique constraint.',
    chokepoint: 'packages/persistence/src/billing-repository.ts',
    file: 'packages/persistence/src/billing-repository.ts',
    find: `      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId])
      const existing = await client.query<TransactionRow>('SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type=\\'debit\\'', [input.workspaceId, input.idempotencyKey])`,
    replace: `      const existing = await client.query<TransactionRow>('SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type=\\'debit\\'', [input.workspaceId, input.idempotencyKey])
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId])`,
    evidence: 'packages/persistence/src/billing-effective-amount.postgres.test.ts',
    overRejection: {
      find: `      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId])
      const existing = await client.query<TransactionRow>('SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type=\\'debit\\'', [input.workspaceId, input.idempotencyKey])`,
      replace: `      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT', [input.workspaceId])
      const existing = await client.query<TransactionRow>('SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type=\\'debit\\'', [input.workspaceId, input.idempotencyKey])`,
      why: 'refusing the second concurrent call instead of replaying it is the mirror of racing it: `NOWAIT` makes a legitimate replay fail on the lock before it can return the row it already owns',
    },
    evidenceFailsWith: 'the replay of one idempotency key is serialized by the workspace row lock and answered from the ledger',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: 'workspaces WHERE id=\\$1 FOR UPDATE',
          sample: "await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId])",
          allow: ['packages/persistence/src/billing-repository.ts', 'tests/invariants'],
          why: 'the debit-key lock is one statement family; a query that takes the same row lock from somewhere else is a second serialization point for the same idempotency key, and the two will not agree about what is locked first',
        },
      ],
    },
    requires: 'PERSISTENCE_RELEASE_DATABASE_URL',
    rationale:
      'Read the key before the lock and two concurrent debits on one idempotency key both see an empty ledger — the winner is still uncommitted — so both reach the INSERT and PostgreSQL rejects the loser with `duplicate key value violates unique constraint "billing_transactions_workspace_id_order_id_type_key"`. The endpoint reads that as a 500 and never gets the `created:false` flag it uses to decide whether a compensating refund is owed. The unique constraint stays as the backstop; the mutation restores the race.',
  },
  {
    id: 'billing-effective-amount-single-reader',
    chokepointSymbol: 'effectiveDebitFen',
    invariant:
      'The reversal and the settlement derive their amounts from the same effective-amount read, so one cannot be fixed while its sibling keeps the old arithmetic.',
    chokepoint: 'packages/persistence/src/billing-repository.ts',
    file: 'packages/persistence/src/billing-repository.ts',
    find: '      const refundFen = await PostgresBillingRepository.effectiveDebitFen(client, input.workspaceId, input.debitIdempotencyKey)',
    replace: '      const refundFen = billingAmountFen(debit.rows[0].amount_fen)',
    evidence: 'packages/persistence/src/billing-effective-amount.postgres.test.ts',
    overRejection: {
      // The mirror: a settlement that refuses the effective amount altogether and
      // takes the provider's figure as the whole charge, so the reversal that
      // follows hands the settled difference back on top of it.
      find: '      const delta = input.finalAmountFen - effectiveFen',
      replace: '      const delta = input.finalAmountFen',
      why: 'ignoring what the key already cost credits the workspace for a settlement it never got, which is the opposite of charging it for one it never got; the same reversal assertion has to catch it',
    },
    evidenceFailsWith: 'the reversal hands back what the key cost, not the original reservation',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: "SUM\\(CASE WHEN type='debit' THEN amount_fen ELSE -amount_fen END\\)",
          sample: "SELECT COALESCE(SUM(CASE WHEN type='debit' THEN amount_fen ELSE -amount_fen END),0)::bigint AS effective_fen",
          allow: ['packages/persistence/src/billing-repository.ts', 'tests/invariants'],
          why: 'one aggregate decides what a debit key costs; a second SQL sum over the same table is a second definition of the amount, which is exactly how `settleDebit` and `refundDebit` drifted apart',
        },
      ],
    },
    requires: 'PERSISTENCE_RELEASE_DATABASE_URL',
    rationale:
      'This is the exact shape the registry exists for: two call sites each holding their own copy of one invariant, one of them fixed and the other left behind. Reversing only the reservation leaves the settled difference charged on an action that produced no result, so a failed action stops netting to zero against what the provider charged. The mutation re-inlines that second, divergent aggregate.',
  },
  {
    id: 'billing-effective-amount-memory-wallet',
    chokepointSymbol: 'effectiveDebitFenOf',
    invariant:
      'The memory wallet derives its settlement delta and its reversal from the same effective amount as the durable ledger, so the fixture the browser and dogfood flows run against cannot bill a different total than production.',
    chokepoint: 'packages/persistence/src/debit-key.ts',
    file: 'packages/persistence/src/debit-key.ts',
    // The mutation restores the hand-copied arithmetic the memory fixture used:
    // the raw pre-authorization, as if no settlement or reversal had been written.
    find: '  return effectiveDebitFensOf(rows, [debitKey]).get(debitKey)',
    replace: '  return rows.find(row => row.orderId === debitKey)?.amountFen',
    evidence: 'packages/persistence/src/debit-key.test.ts',
    overRejection: {
      find: "    if (row.type !== 'debit' && row.type !== 'refund') continue",
      replace: "    if (row.type !== 'debit') continue",
      why: 'refusing the reversal row is the mirror of reading only it: the amount comes out at the un-reversed reservation, which is the same defect the mutation restores from the other side',
    },
    evidenceFailsWith: 'the effective amount of a reversal-first debit key',
    uniqueness: {
      callers: ['apps/api/src/server.ts', 'apps/api/src/wallet-amount-helpers.ts'],
      noSecondImplementation: [
        {
          pattern: 'finalAmountFen - [A-Za-z_$][\\w.$]*amountFen',
          sample: 'const delta = input.finalAmountFen - original.amountFen',
          allow: ['tests/invariants'],
          why: 'the memory settlement used to subtract the reservation from the provider figure by hand; every settlement delta now comes from the shared effective amount, and a subtraction of a raw `.amountFen` field is that second arithmetic returning',
        },
        {
          pattern: 'amountFen: debit\\.amountFen',
          sample: 'type: \'refund\' as const, amountFen: debit.amountFen, orderId: refundOrderId',
          allow: ['tests/invariants'],
          why: 'the memory reversal wrote the reservation instead of the effective amount, which left the settled difference charged on an action that produced no result; the shared read is the only reversal amount the fixture may use',
        },
      ],
    },
    rationale:
      'The memory fixture is the backend the browser-QA and dogfood flows run on (`CONNECTOR_FIXTURE_MODE`, no `PERSISTENCE_MODE=postgres`). It hand-copied the debit-key arithmetic: `refundPluginWalletDebit` wrote `amountFen: debit.amountFen` — the raw reservation, the exact arithmetic the durable mutation restores — and `settlePluginWalletDebit` computed `finalAmountFen - original.amountFen`, ignoring every settlement row already appended, so a settle-then-correct sequence was silently dropped by the existing-row guard. Both now read `debit-key.ts`; the mutation puts the hand-copied subtraction back and the assertion on a reversal-first key catches it.',
  },
]
