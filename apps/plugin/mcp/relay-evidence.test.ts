import { describe, expect, it } from 'vitest'
import { assertRelayEvidence } from './relay-evidence.mjs'

describe('relay evidence lifecycle', () => {
  it('treats queued execution envelopes as pending before provider evidence exists', () => {
    const result = {
      job_id: 'image-job-1',
      execution: { state: 'queued', provider: 'configured relay' },
    }

    expect(() => assertRelayEvidence('catalog.image.generate', result, { environment: 'production', fixtureFallback: false })).not.toThrow()
  })

  it('still blocks a terminal result that omits provider evidence', () => {
    const result = { execution: { state: 'completed', providerExecuted: false } }

    expect(() => assertRelayEvidence('catalog.image.generate', result, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
  })

  const terminalMethods = ['catalog.image.get', 'multimodal.video.get']
  const evidence = {
    execution: {
      state: 'completed',
      providerExecuted: true,
      providerRequestId: 'provider-request-1',
      usage: { output_tokens: 12 },
      costCny: 0.25,
      settlementStatus: 'settled',
    },
  }

  it.each(terminalMethods)('%s requires complete settled provider evidence on terminal results', method => {
    expect(() => assertRelayEvidence(method, evidence, { environment: 'production', fixtureFallback: false })).not.toThrow()
    expect(() => assertRelayEvidence(method, { ...evidence, execution: { ...evidence.execution, providerExecuted: false } }, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
    expect(() => assertRelayEvidence(method, { ...evidence, execution: { ...evidence.execution, providerRequestId: '' } }, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
    expect(() => assertRelayEvidence(method, { ...evidence, execution: { ...evidence.execution, usage: {} } }, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
    expect(() => assertRelayEvidence(method, { ...evidence, execution: { ...evidence.execution, costCny: undefined } }, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
    expect(() => assertRelayEvidence(method, { ...evidence, execution: { ...evidence.execution, settlementStatus: 'unknown' } }, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
  })

  it.each(['catalog.image.get', 'multimodal.video.get'])('%s accepts top-level snake_case settled evidence', method => {
    const result = {
      state: 'completed',
      provider_executed: true,
      provider_request_id: 'provider-request-1',
      usage: { output_tokens: 12 },
      cost_cny: 0.25,
      settlement_status: 'settled',
    }
    expect(() => assertRelayEvidence(method, result, { environment: 'staging', fixtureFallback: false })).not.toThrow()
  })

  it.each(['catalog.image.get', 'multimodal.video.get'])('%s accepts execution snake_case and top-level camelCase evidence', method => {
    const result = {
      providerExecuted: true,
      providerRequestId: 'provider-request-1',
      usage: { output_tokens: 12 },
      costCny: 0.25,
      settlementStatus: 'settled',
      execution: { state: 'completed', provider_executed: true, provider_request_id: 'provider-request-1', cost_cny: 0.25, settlement_status: 'settled', usage: { output_tokens: 12 } },
    }
    expect(() => assertRelayEvidence(method, result, { environment: 'preview', fixtureFallback: false })).not.toThrow()
  })

  const synchronousImageVideoMethods = ['catalog.image.generate', 'multimodal.video.request']

  it.each(synchronousImageVideoMethods)('%s blocks completed provider output without settled accounting', method => {
    const terminal = {
      execution: {
        state: 'completed',
        providerExecuted: true,
        providerRequestId: 'provider-request-2',
        usage: { output_tokens: 18 },
        costCny: 0.4,
      },
    }
    expect(() => assertRelayEvidence(method, terminal, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
    expect(() => assertRelayEvidence(method, { execution: { ...terminal.execution, settlementStatus: 'unknown' } }, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
    expect(() => assertRelayEvidence(method, { execution: { ...terminal.execution, settlementStatus: 'settled' } }, { environment: 'production', fixtureFallback: false })).not.toThrow()
  })

  it.each(synchronousImageVideoMethods)('%s continues to allow queued results before evidence settles', method => {
    expect(() => assertRelayEvidence(method, { execution: { state: 'queued' } }, { environment: 'production', fixtureFallback: false })).not.toThrow()
  })

  it.each(['content.generate', 'content.draft.generate', 'multimodal.generate', 'multimodal.image.edit'])('%s also requires settlement evidence before terminal relay delivery', method => {
    expect(() => assertRelayEvidence(method, evidence, { environment: 'production', fixtureFallback: false })).not.toThrow()
    expect(() => assertRelayEvidence(method, { ...evidence, execution: { ...evidence.execution, settlementStatus: 'pending' } }, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
  })

  it.each(['production', 'staging', 'preview'])('keeps pending async get results exempt in %s', environment => {
    expect(() => assertRelayEvidence('catalog.image.get', { state: 'pending' }, { environment, fixtureFallback: false })).not.toThrow()
    expect(() => assertRelayEvidence('multimodal.video.get', { execution_state: 'running' }, { environment, fixtureFallback: false })).not.toThrow()
  })

  it('does not let a pending label hide a completed output envelope', () => {
    const mixed = { ...evidence, status: 'pending', execution: { ...evidence.execution, state: 'completed', settlementStatus: undefined } }
    expect(() => assertRelayEvidence('catalog.image.get', mixed, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
  })

  it('keeps a queued nested video rendering result pending', () => {
    expect(() => assertRelayEvidence('multimodal.video.get', { rendering: { status: 'queued' } }, { environment: 'production', fixtureFallback: false })).not.toThrow()
  })

  it.each(['catalog.image.get', 'multimodal.video.get'])('%s keeps failed terminal outcomes behind the evidence gate', method => {
    expect(() => assertRelayEvidence(method, { status: 'failed' }, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
    const settledFailure = { ...evidence, status: 'failed' }
    expect(() => assertRelayEvidence(method, settledFailure, { environment: 'production', fixtureFallback: false })).not.toThrow()
  })
})
