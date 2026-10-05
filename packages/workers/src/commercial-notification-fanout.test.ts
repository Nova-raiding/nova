import { describe, expect, it } from 'vitest'
import { runCommercialNotificationTick, runCommercialPurchaseResultNotificationTick } from './commercial-notification-fanout.js'
describe('commercial notification worker tick', () => {
  it('is idle when no live lease exists', async () => {
    const result = await runCommercialNotificationTick({ claim: async () => undefined, fanout: async () => { throw new Error('unexpected fanout') } })
    expect(result).toEqual({ scanned: 0, delivered: 0, complete: true })
  })
  it('passes the durable claim and fixed batch cap, preserving partial status', async () => {
    const result = await runCommercialNotificationTick({ claim: async seconds => { expect(seconds).toBe(60); return { eventId: 'event', token: 'lease' } }, fanout: async (lease, limit) => { expect(lease).toEqual({ eventId: 'event', token: 'lease' }); expect(limit).toBe(200); return { scanned: 200, delivered: 199, complete: false } } })
    expect(result).toEqual({ eventId: 'event', scanned: 200, delivered: 199, complete: false })
  })
  it('propagates uncertainty without claiming notification success', async () => {
    await expect(runCommercialNotificationTick({ claim: async () => ({ eventId: 'event', token: 'lease' }), fanout: async () => { throw new Error('commit unknown') } })).rejects.toThrow('commit unknown')
  })
})

describe('purchase-result notification worker source boundary', () => {
 it('requires the actual source projection before any delivery and keeps the workspace bound',async()=>{
  const {runCommercialPurchaseResultNotificationTick}=await import('./commercial-notification-fanout.js')
  const calls:string[]=[]
  expect(await runCommercialPurchaseResultNotificationTick({seedPurchaseResults:async(ws,limit)=>{expect(ws).toBe('ws');expect(limit).toBe(200);calls.push('seed');return 1},claimPurchaseResult:async(ws,seconds)=>{expect(ws).toBe('ws');expect(seconds).toBe(60);calls.push('claim');return {eventId:'evt-real',token:'lease'}},fanoutPurchaseResult:async(ws,lease,limit)=>{expect(ws).toBe('ws');expect(lease.eventId).toBe('evt-real');expect(limit).toBe(200);calls.push('fanout');return {scanned:2,delivered:2,complete:true}}},'ws')).toEqual({eventId:'evt-real',scanned:2,delivered:2,complete:true})
  expect(calls).toEqual(['seed','claim','fanout'])
 })
})

describe('purchase result uncertain delivery stays pending', () => {
  it('does not claim or fanout when source projection fails', async () => {
    let downstream = 0
    await expect(runCommercialPurchaseResultNotificationTick({ seedPurchaseResults: async () => { throw new Error('source unavailable') }, claimPurchaseResult: async () => { downstream++; return undefined }, fanoutPurchaseResult: async () => { downstream++; return { scanned: 0, delivered: 0, complete: true } } }, 'ws')).rejects.toThrow('source unavailable')
    expect(downstream).toBe(0)
  })
  it('propagates commit uncertainty without returning a completed batch', async () => {
    const repository = { seedPurchaseResults: async () => 1, claimPurchaseResult: async () => ({ eventId: 'event', token: 'lease' }), fanoutPurchaseResult: async () => { throw new Error('commit unknown') } }
    await expect(runCommercialPurchaseResultNotificationTick(repository, 'ws')).rejects.toThrow('commit unknown')
  })
})
