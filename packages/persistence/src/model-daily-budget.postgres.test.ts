import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { loadMigrations, MigrationRunner } from './migration.js'
import { ModelCostBudgetExceededError, ModelRunCostBudgetActualExceededError, ModelRunCostBudgetExceededError, PostgresModelUsageRepository } from './model-usage-repository.js'

const postgresIt = process.env.MODEL_BUDGET_DATABASE_URL ? it : it.skip

describe('PostgreSQL daily model-cost budget', () => {
  postgresIt('serializes competing reservations across independent connections', async () => {
    const pool = new Pool({ connectionString: process.env.MODEL_BUDGET_DATABASE_URL, max: 4 })
    const workspaceId = `ws_budget_pg_${Date.now()}_${Math.random().toString(16).slice(2)}`
    try {
      await new MigrationRunner(pool, await loadMigrations()).run()
      await pool.query('INSERT INTO workspaces (id, status) VALUES ($1, $2)', [workspaceId, 'active'])
      const repository = new PostgresModelUsageRepository(pool)
      const common = { workspaceId, modality: 'image' as const, model: 'image-v1', estimateCny: 0.6, estimateVersion: 'pricing-v1', dailyLimitCny: 1, at: '2026-08-29T01:00:00.000Z' }

      const outcomes = await Promise.allSettled([
        repository.reserveDailyBudget({ ...common, reservationKey: 'request-a' }),
        repository.reserveDailyBudget({ ...common, reservationKey: 'request-b' }),
      ])
      expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = outcomes.find(result => result.status === 'rejected')
      expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(ModelCostBudgetExceededError) })

      const winner = outcomes.find(result => result.status === 'fulfilled')
      if (!winner || winner.status !== 'fulfilled') throw new Error('expected one winning budget reservation')
      expect(winner.value.reservation).toMatchObject({ budgetDate: '2026-08-29', modality: common.modality, model: common.model, estimateCny: common.estimateCny, estimateVersion: common.estimateVersion, dailyLimitCny: common.dailyLimitCny })
      const replay = await repository.reserveDailyBudget({ ...common, reservationKey: winner.value.reservation.reservationKey })
      expect(replay).toMatchObject({ reused: true, reservation: { status: 'active' } })
      await expect(repository.settleDailyBudget({ workspaceId: common.workspaceId, reservationKey: winner.value.reservation.reservationKey, actualCostCny: 0.55, providerRequestId: 'provider-budget-pg', at: common.at }))
        .resolves.toMatchObject({ reservation: { status: 'settled', actualCostCny: 0.55 } })
    } finally {
      await pool.end()
    }
  }, 60_000)

  postgresIt('serializes a shared run cap and persists explicit usage linkage', async () => {
    const pool = new Pool({ connectionString: process.env.MODEL_BUDGET_DATABASE_URL, max: 4 })
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const workspaceId = `ws_run_budget_pg_${suffix}`
    try {
      await new MigrationRunner(pool, await loadMigrations()).run()
      await pool.query('INSERT INTO workspaces (id, status) VALUES ($1, $2)', [workspaceId, 'active'])
      const repository = new PostgresModelUsageRepository(pool)
      const common = { workspaceId, runKey: 'generation_run_1', modality: 'image' as const, model: 'image-v1', estimateCny: 0.6, estimateVersion: 'pricing-v2', dailyLimitCny: 10, runLimitCny: 1, at: '2026-08-29T01:00:00.000Z' }

      const outcomes = await Promise.allSettled([
        repository.reserveDailyBudget({ ...common, reservationKey: 'request-a' }),
        repository.reserveDailyBudget({ ...common, reservationKey: 'request-b' }),
      ])
      expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: expect.any(ModelRunCostBudgetExceededError) })

      const winner = outcomes.find(result => result.status === 'fulfilled')
      if (!winner || winner.status !== 'fulfilled') throw new Error('expected one winning run reservation')
      const reservationKey = winner.value.reservation.reservationKey
      await expect(repository.record({ workspaceId, budgetReservationKey: reservationKey, budgetRunKey: 'generation_run_1', modality: 'image', model: 'image-v1', providerRequestId: `provider_${suffix}`, costCny: 0.55 }))
        .resolves.toMatchObject({ budgetReservationKey: reservationKey, budgetRunKey: 'generation_run_1' })
      await expect(repository.record({ workspaceId, budgetReservationKey: reservationKey, budgetRunKey: 'wrong-run', modality: 'image', model: 'image-v1', providerRequestId: `provider_wrong_${suffix}`, costCny: 0.01 }))
        .rejects.toThrow('MODEL_USAGE_BUDGET_LINK_CONFLICT')
      await expect(pool.query('UPDATE model_cost_budget_reservations SET run_key=$3 WHERE workspace_id=$1 AND reservation_key=$2', [workspaceId, reservationKey, 'direct-sql-wrong-run']))
        .rejects.toThrow(/model_usage_budget_reservation_run_fk/u)
      await expect(pool.query('SELECT run_key FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2', [workspaceId, reservationKey]))
        .resolves.toMatchObject({ rows: [{ run_key: 'generation_run_1' }] })
    } finally {
      await pool.end()
    }
  }, 60_000)

  postgresIt('atomically records exact receipts, rejects drift, and accumulates multiple receipts', async () => {
    const pool = new Pool({ connectionString: process.env.MODEL_BUDGET_DATABASE_URL, max: 4 })
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const workspaceId = `ws_atomic_pg_${suffix}`
    try {
      await new MigrationRunner(pool, await loadMigrations()).run()
      await pool.query('INSERT INTO workspaces (id, status) VALUES ($1, $2)', [workspaceId, 'active'])
      const repository = new PostgresModelUsageRepository(pool)
      const budget = { workspaceId, runKey: `run_${suffix}`, modality: 'text' as const, model: 'relay-text', estimateCny: 0.8, estimateVersion: 'pricing-v4', dailyLimitCny: 5, runLimitCny: 2, at: '2026-08-29T01:00:00.000Z' }
      await repository.reserveDailyBudget({ ...budget, reservationKey: 'reservation_1' })
      await repository.reserveDailyBudget({ ...budget, reservationKey: 'reservation_2' })
      const receipt = { workspaceId, budgetReservationKey: 'reservation_1', budgetRunKey: budget.runKey, modality: budget.modality, model: budget.model, providerRequestId: `provider_exact_${suffix}`, totalTokens: 10, costCny: 0.25, settlementStatus: 'pending_wallet' as const, observedAt: '2026-08-29T01:01:00.000Z' }

      const first = await repository.recordUsageAndSettleBudget(receipt)
      const replay = await repository.recordUsageAndSettleBudget(receipt)
      expect(replay.usage.id).toBe(first.usage.id)
      expect(replay.usage.revision).toBe(first.usage.revision)
      expect(replay.reservation.revision).toBe(first.reservation.revision)
      await expect(repository.recordUsageAndSettleBudget({ ...receipt, costCny: 0.26 })).rejects.toThrow('MODEL_USAGE_COST_CONFLICT')
      await expect(repository.recordUsageAndSettleBudget({ ...receipt, budgetReservationKey: 'reservation_2' })).rejects.toThrow('MODEL_USAGE_BUDGET_LINK_CONFLICT')

      const second = await repository.recordUsageAndSettleBudget({ ...receipt, providerRequestId: `provider_second_${suffix}`, costCny: 0.35, observedAt: '2026-08-29T01:02:00.000Z' })
      expect(second.reservation).toMatchObject({ status: 'settled', actualCostCny: 0.6 })
      expect(await repository.list(workspaceId)).toHaveLength(2)
    } finally {
      await pool.end()
    }
  }, 60_000)

  postgresIt('keeps actual overrun durable and refuses release after a linked receipt', async () => {
    const pool = new Pool({ connectionString: process.env.MODEL_BUDGET_DATABASE_URL, max: 4 })
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const workspaceId = `ws_atomic_overrun_pg_${suffix}`
    try {
      await new MigrationRunner(pool, await loadMigrations()).run()
      await pool.query('INSERT INTO workspaces (id, status) VALUES ($1, $2)', [workspaceId, 'active'])
      const repository = new PostgresModelUsageRepository(pool)
      const budget = { workspaceId, reservationKey: 'reservation_overrun', runKey: `run_${suffix}`, modality: 'video' as const, model: 'relay-video', estimateCny: 0.5, estimateVersion: 'pricing-v4', dailyLimitCny: 10, runLimitCny: 1, at: '2026-08-29T01:00:00.000Z' }
      await repository.reserveDailyBudget(budget)
      await expect(repository.recordUsageAndSettleBudget({ workspaceId, budgetReservationKey: budget.reservationKey, budgetRunKey: budget.runKey, modality: budget.modality, model: budget.model, providerRequestId: `provider_overrun_${suffix}`, costCny: 1.2, settlementStatus: 'pending_wallet', observedAt: '2026-08-29T01:01:00.000Z' })).rejects.toBeInstanceOf(ModelRunCostBudgetActualExceededError)
      expect(await repository.list(workspaceId)).toEqual([expect.objectContaining({ costCny: 1.2, budgetReservationKey: budget.reservationKey })])
      await expect(repository.reserveDailyBudget(budget)).resolves.toMatchObject({ reused: true, reservation: { status: 'over_budget', overBudgetReason: 'run', actualCostCny: 1.2 } })

      const releaseBudget = { ...budget, reservationKey: 'reservation_release', runKey: `run_release_${suffix}`, estimateCny: 0.2 }
      await repository.reserveDailyBudget(releaseBudget)
      await repository.record({ workspaceId, budgetReservationKey: releaseBudget.reservationKey, budgetRunKey: releaseBudget.runKey, modality: releaseBudget.modality, model: releaseBudget.model, providerRequestId: `provider_release_${suffix}`, costCny: 0.1, settlementStatus: 'pending_wallet' })
      await expect(repository.releaseDailyBudget({ workspaceId, reservationKey: releaseBudget.reservationKey })).resolves.toMatchObject({ status: 'active' })
    } finally {
      await pool.end()
    }
  }, 60_000)

  postgresIt('enforces a shared run across UTC days when daily and run limits are equal', async () => {
    const pool = new Pool({ connectionString: process.env.MODEL_BUDGET_DATABASE_URL, max: 4 })
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const workspaceId = `ws_atomic_cross_day_pg_${suffix}`
    try {
      await new MigrationRunner(pool, await loadMigrations()).run()
      await pool.query('INSERT INTO workspaces (id, status) VALUES ($1, $2)', [workspaceId, 'active'])
      const repository = new PostgresModelUsageRepository(pool)
      const base = { workspaceId, runKey: `run_${suffix}`, modality: 'video' as const, model: 'relay-video', estimateVersion: 'pricing-v4', dailyLimitCny: 1, runLimitCny: 1 }
      await repository.reserveDailyBudget({ ...base, reservationKey: 'day_one', estimateCny: 0.4, at: '2026-08-29T23:59:00.000Z' })
      await repository.recordUsageAndSettleBudget({ workspaceId, budgetReservationKey: 'day_one', budgetRunKey: base.runKey, modality: base.modality, model: base.model, providerRequestId: `provider_day_one_${suffix}`, costCny: 0.4, settlementStatus: 'pending_wallet', observedAt: '2026-08-29T23:59:30.000Z' })
      await repository.reserveDailyBudget({ ...base, reservationKey: 'day_two', estimateCny: 0.5, at: '2026-08-30T00:01:00.000Z' })
      await repository.recordUsageAndSettleBudget({ workspaceId, budgetReservationKey: 'day_two', budgetRunKey: base.runKey, modality: base.modality, model: base.model, providerRequestId: `provider_day_two_${suffix}`, costCny: 0.5, settlementStatus: 'pending_wallet', observedAt: '2026-08-30T00:01:30.000Z' })

      await expect(repository.reserveDailyBudget({ ...base, reservationKey: 'day_two_blocked', estimateCny: 0.2, at: '2026-08-30T00:02:00.000Z' })).rejects.toBeInstanceOf(ModelRunCostBudgetExceededError)
    } finally {
      await pool.end()
    }
  }, 60_000)
})
