import { describe, expect, it } from 'vitest'
import { CAPACITY_WORKLOAD_READ_PATH, isExpectedCapacityStatus, readCapacityWorkloadConfig, selectCapacityAccount } from './capacity-workload.js'

describe('capacity workload contract', () => {
  it('uses an onboarding-exempt workspace-scoped read path for baseline traffic', () => {
    expect(CAPACITY_WORKLOAD_READ_PATH).toBe('/v1/platform-accounts')
  })

  it('counts deliberate quota responses separately from service failures', () => {
    expect(isExpectedCapacityStatus(429)).toBe(true)
    expect(isExpectedCapacityStatus(401)).toBe(false)
    expect(isExpectedCapacityStatus(500)).toBe(false)
  })

  it('fails setup instead of reporting a job workload with no bound account', () => {
    expect(selectCapacityAccount([{ platform: 'taobao', accountId: 'acct_1' }])).toBe('acct_1')
    expect(() => selectCapacityAccount([{ platform: 'taobao' }])).toThrow('bound Taobao account')
  })
  it('binds pilot and target profiles to their fixed load semantics', () => {
    expect(readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_PROFILE: 'pilot_50' })).toMatchObject({ workspaces: 50, clientConnections: 150, sustainedRps: 30, burstRps: 60, asyncJobsPerMinute: 50 })
    expect(readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_PROFILE: 'target_500', CAPACITY_WORKLOAD_CONCURRENCY: '500' })).toMatchObject({ workspaces: 500, clientConnections: 750, sustainedRps: 150, burstRps: 300, asyncJobsPerMinute: 500 })
  })

  it('fails closed when real cloud evidence is not explicitly confirmed', () => {
    expect(() => readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_MODE: 'real_cloud' })).toThrow('CONFIRM_REAL_CLOUD')
    expect(() => readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'https://capacity.example.com', CAPACITY_WORKLOAD_MODE: 'real_cloud', CAPACITY_WORKLOAD_CONFIRM_REAL_CLOUD: 'true', CAPACITY_WORKLOAD_SUSTAINED_MINUTES: '1' })).toThrow('30 sustained minutes')
  })
  it('supports intermediate rollout workload profiles', () => {
    expect(readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_PROFILE: 'wave_100' })).toMatchObject({ workspaces: 100, clientConnections: 300, sustainedRps: 60, burstRps: 120, asyncJobsPerMinute: 100 })
    expect(readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_PROFILE: 'wave_250' })).toMatchObject({ workspaces: 250, clientConnections: 375, sustainedRps: 75, burstRps: 150, asyncJobsPerMinute: 250 })
  })
})
