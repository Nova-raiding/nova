import { describe, expect, it } from 'vitest'
import { MemoryPublishMediaOrphanRepository } from './publish-media-orphan-repository.js'

const binding={workspaceId:'ws_a',publishJobId:'job_a',eventId:'event_a',mediaIdempotencyKey:'job_a:media:visual_a',platform:'taobao',accountId:'account_a',visualRef:'visual_a',role:'main' as const,sha256:'a'.repeat(64)}

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
    const uploaded=await repo.transition({...binding,state:'uploaded',receipt:{mediaId:'remote_media_1',url:'https://media.invalid/1'}})
    const replay=await repo.getByKey(binding.workspaceId,binding.publishJobId,binding.mediaIdempotencyKey)
    expect(intent.id).toBe(uploaded.id)
    expect(replay).toMatchObject({state:'uploaded',receipt:{mediaId:'remote_media_1'}})
    const orphan=await repo.transition({...binding,state:'orphaned',reason:'validation_rejected'})
    expect(orphan).toMatchObject({id:intent.id,state:'orphaned',reason:'validation_rejected'})
  })

  it('does not permit deleting media after an unknown publish commit or cross-tenant reads',async()=>{
    const repo=new MemoryPublishMediaOrphanRepository()
    await repo.transition({...binding,state:'intent'})
    await repo.transition({...binding,state:'uploaded',receipt:{mediaId:'remote_media_1'}})
    await repo.transition({...binding,state:'unknown',reason:'write_commit_unknown'})
    await expect(repo.transition({...binding,state:'deleted'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    expect(await repo.getByKey('ws_b',binding.publishJobId,binding.mediaIdempotencyKey)).toBeUndefined()
  })

  it('requires a previously uploaded receipt and the confirmed adapter reason before recording deletion',async()=>{
    const repo=new MemoryPublishMediaOrphanRepository()
    const receipt={mediaId:'remote_media_1',url:'https://media.invalid/1'}
    await expect(repo.transition({...binding,state:'deleted',receipt,reason:'discard_adapter_confirmed_delete'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    await repo.transition({...binding,state:'uploaded',receipt})
    await expect(repo.transition({...binding,state:'deleted',receipt,reason:'worker_claimed_deleted'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    const deleted=await repo.transition({...binding,state:'deleted',receipt,reason:'discard_adapter_confirmed_delete'})
    expect(deleted).toMatchObject({state:'deleted',receipt,reason:'discard_adapter_confirmed_delete'})
    await expect(repo.transition({...binding,state:'deleted',receipt,reason:'discard_adapter_confirmed_delete'})).resolves.toMatchObject({state:'deleted',receipt,reason:'discard_adapter_confirmed_delete'})
  })
})
