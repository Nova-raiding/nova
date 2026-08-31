import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { loadMigrations, MigrationRunner } from './migration.js'
import { ModelCostBudgetExceededError, PostgresModelUsageRepository } from './model-usage-repository.js'

const postgresIt = process.env.MODEL_BUDGET_DATABASE_URL ? it : it.skip

describe('PostgreSQL daily model-cost budget', () => {
  postgresIt('serializes competing reservations across independent connections', async () => {
    const pool = new Pool({ connectionString: process.env.MODEL_BUDGET_DATABASE_URL, max: 4 })
    try {
      await new MigrationRunner(pool, await loadMigrations()).run()
      await pool.query("INSERT INTO workspaces (id, status) VALUES ('ws_budget_pg', 'active')")
      const repository = new PostgresModelUsageRepository(pool)
      const common = { workspaceId: 'ws_budget_pg', modality: 'image' as const, model: 'image-v1', estimateCny: 0.6, estimateVersion: 'pricing-v1', dailyLimitCny: 1, at: '2026-08-29T01:00:00.000Z' }

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
})
