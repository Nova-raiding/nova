import { describe, expect, it } from 'vitest'
import { MemoryPublishMediaOrphanRepository } from './publish-media-orphan-repository.js'

const binding={workspaceId:'ws_a',publishJobId:'job_a',eventId:'event_a',mediaIdempotencyKey:'job_a:media:visual_a',platform:'taobao',accountId:'account_a',visualRef:'visual_a',role:'main' as const,sha256:'a'.repeat(64)}
const receipt=(mediaId='remote_media_1')=>({mediaId,url:'https://media.invalid/1',platform:binding.platform,visualRef:binding.visualRef,role:binding.role,sha256:binding.sha256,simulated:false})

describe('publish media recovery ledger',()=>{
  it('allows only one worker to claim a media upload intent',async()=>{
    const repo=new MemoryPublishMediaOrphanRepository()
    const results=await Promise.allSettled([
      repo.transition({...binding,state:'intent'}),
      repo.transition({...binding,state:'intent'}),
    ])
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1)
  })

  it('replays the same upload receipt idempotently and records safe orphan state',async()=>{
    const repo=new MemoryPublishMediaOrphanRepository()
    const intent=await repo.transition({...binding,state:'intent'})
    const uploaded=await repo.transition({...binding,state:'uploaded',receipt:receipt()})
    const replay=await repo.getByKey(binding.workspaceId,binding.publishJobId,binding.mediaIdempotencyKey)
    expect(intent.id).toBe(uploaded.id)
    expect(replay).toMatchObject({state:'uploaded',receipt:{mediaId:'remote_media_1'}})
    const orphan=await repo.transition({...binding,state:'orphaned',reason:'validation_rejected'})
    expect(orphan).toMatchObject({id:intent.id,state:'orphaned',reason:'validation_rejected'})
    expect(repo.listEvents()).toHaveLength(3)
  })

  it('treats exact later-state replays as no-ops and rejects same-state payload changes',async()=>{
    const repo=new MemoryPublishMediaOrphanRepository()
    await repo.transition({...binding,state:'intent'})
    const mediaReceipt=receipt()
    const uploaded=await repo.transition({...binding,state:'uploaded',receipt:mediaReceipt})
    const eventCount=repo.listEvents().length

    await expect(repo.transition({...binding,state:'uploaded',receipt:mediaReceipt})).resolves.toEqual(uploaded)
    await expect(repo.transition({...binding,state:'uploaded',receipt:mediaReceipt,reason:'unexpected_replay_change'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    expect(repo.listEvents()).toHaveLength(eventCount)
  })

  it('does not permit deleting media after an unknown publish commit or cross-tenant reads',async()=>{
    const repo=new MemoryPublishMediaOrphanRepository()
    await repo.transition({...binding,state:'intent'})
    await repo.transition({...binding,state:'uploaded',receipt:receipt()})
    await repo.transition({...binding,state:'unknown',reason:'write_commit_unknown'})
    await expect(repo.transition({...binding,state:'deleted'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    expect(await repo.getByKey('ws_b',binding.publishJobId,binding.mediaIdempotencyKey)).toBeUndefined()
  })

  it('keeps uploaded media orphaned until an independently verified deletion contract exists',async()=>{
    const repo=new MemoryPublishMediaOrphanRepository()
    const mediaReceipt=receipt()
    await repo.transition({...binding,state:'intent'})
    await expect(repo.transition({...binding,state:'deleted',receipt:mediaReceipt,reason:'discard_adapter_confirmed_delete'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    await repo.transition({...binding,state:'uploaded',receipt:mediaReceipt})
    await expect(repo.transition({...binding,state:'deleted',receipt:mediaReceipt,reason:'worker_claimed_deleted'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    await expect(repo.transition({...binding,state:'deleted',receipt:mediaReceipt,reason:'discard_adapter_confirmed_delete'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    expect(await repo.getByKey(binding.workspaceId,binding.publishJobId,binding.mediaIdempotencyKey)).toMatchObject({state:'uploaded',receipt:mediaReceipt})
  })

  it('requires a bound non-simulated receipt and never replaces a receipt already recorded',async()=>{
    const repo=new MemoryPublishMediaOrphanRepository()
    await expect(repo.transition({...binding,mediaIdempotencyKey:'job_a:media:direct_unknown',state:'unknown'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    await expect(repo.transition({...binding,mediaIdempotencyKey:'job_a:media:intent_receipt',state:'intent',receipt:receipt()})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    await repo.transition({...binding,state:'intent'})
    await expect(repo.transition({...binding,state:'uploaded'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    await expect(repo.transition({...binding,state:'uploaded',receipt:{...receipt(),visualRef:'another_visual'}})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    await expect(repo.transition({...binding,state:'uploaded',receipt:{...receipt(),simulated:true}})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    await repo.transition({...binding,state:'uploaded',receipt:receipt()})
    await expect(repo.transition({...binding,state:'orphaned',receipt:receipt('different_remote_id')})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    await expect(repo.transition({...binding,state:'orphaned',reason:'manual_review'})).resolves.toMatchObject({state:'orphaned',receipt:receipt()})
  })

  it('can durably orphan a confirmed upload when the uploaded-state write failed',async()=>{
    const repo=new MemoryPublishMediaOrphanRepository()
    await repo.transition({...binding,state:'intent'})
    const mediaReceipt=receipt()
    await expect(repo.transition({...binding,state:'orphaned',receipt:mediaReceipt,reason:'upload_receipt_persist_retry'})).resolves.toMatchObject({state:'orphaned',receipt:mediaReceipt})
  })
})
