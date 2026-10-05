import {describe, expect, it} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {assertCommercialRuntimeOperation, createCommercialRuntimePolicy, loadCommercialRuntimePolicy, COMMERCIAL_SALES_PROTOCOL, type CommercialRuntimePolicy} from './commercial-runtime-policy.js'
const sha = 'a'.repeat(64)
const sale: CommercialRuntimePolicy = {mode:'sale',policyRevision:'approved-rollout-1',approvedEvidenceRef:'approval-1',catalogManualAuditRef:'audit-1',runtimeAcceptanceRef:'acceptance-1',catalogAuditSha256:sha,candidateSha256:sha,schemaSha256:sha,fleetEvidenceRef:'fleet-1',deploymentEvidenceVerified:true,expiresAt:new Date(Date.now()+600000).toISOString(),activeInstances:[{instanceId:'api-1',salesProtocol:COMMERCIAL_SALES_PROTOCOL,candidateSha256:sha,schemaSha256:sha}]}
describe('commercial fleet rollout and compatibility rollback fence', () => {
  it('defaults closed for new purchases, quotes, upgrades and publication', () => {
    for (const operation of ['new_purchase','new_quote','new_upgrade','catalog_publish','new_recovery_intent'] as const) expect(() => assertCommercialRuntimeOperation(undefined, operation)).toThrow('NEW_WRITES_CLOSED')
    expect(() => assertCommercialRuntimeOperation(undefined,'read')).not.toThrow()
  })
  it('requires manual catalog audit and actual acceptance approval before sale', () => {
    for (const key of ['approvedEvidenceRef','catalogManualAuditRef','runtimeAcceptanceRef'] as const) expect(() => assertCommercialRuntimeOperation({...sale,[key]:undefined},'new_purchase')).toThrow('ROLLOUT_APPROVAL_EVIDENCE_REQUIRED')
    expect(() => assertCommercialRuntimeOperation(sale,'new_purchase')).not.toThrow()
  })
  it('rejects absent, duplicate or incompatible active fleet evidence', () => {
    for (const activeInstances of [[],[...sale.activeInstances!,{instanceId:'old-api',salesProtocol:'commercial.sales.v2',candidateSha256:sha,schemaSha256:sha}],[...sale.activeInstances!,...sale.activeInstances!]]) expect(() => assertCommercialRuntimeOperation({...sale,activeInstances},'catalog_publish')).toThrow('MIXED_VERSION_FLEET_NOT_APPROVED')
  })
  it('rollback blocks new writes while permitting valid persisted obligations and queries', () => {
    const rollback:CommercialRuntimePolicy = {mode:'rollback',policyRevision:'incident-1'}
    expect(() => assertCommercialRuntimeOperation(rollback,'new_upgrade')).toThrow('NEW_WRITES_CLOSED')
    expect(() => assertCommercialRuntimeOperation(rollback,'new_recovery_intent')).toThrow('NEW_WRITES_CLOSED')
    for (const operation of ['existing_fulfillment','existing_worker'] as const) {
      expect(() => assertCommercialRuntimeOperation(rollback,operation,{existingIntentId:'order-1',originalFulfillmentValid:true})).not.toThrow()
      expect(() => assertCommercialRuntimeOperation(rollback,operation,{existingIntentId:'order-1',originalFulfillmentValid:false})).toThrow('EXISTING_VALID_OBLIGATION_REQUIRED')
    }
  })
  it('continues approved refund recovery without creating fresh approvals', () => {
    const rollback:CommercialRuntimePolicy = {mode:'rollback',policyRevision:'incident-1'}
    expect(() => assertCommercialRuntimeOperation(rollback,'approved_refund_recovery',{existingIntentId:'refund-1',refundApprovalId:'approval-1'})).not.toThrow()
    expect(() => assertCommercialRuntimeOperation(rollback,'approved_refund_recovery',{existingIntentId:'refund-1'})).toThrow('PERSISTED_REFUND_APPROVAL_REQUIRED')
  })
  it('does not silently accept an unclassified write', () => {
    expect(() => assertCommercialRuntimeOperation(sale,'unknown' as never)).toThrow('UNKNOWN_WRITE_OPERATION')
  })
  it('requires the server factory to verify deployment evidence, rather than trusting an input boolean', async () => {
    await expect(createCommercialRuntimePolicy(sale)).rejects.toThrow('DEPLOYMENT_EVIDENCE_NOT_VERIFIED')
    await expect(createCommercialRuntimePolicy(sale,async()=>false)).rejects.toThrow('DEPLOYMENT_EVIDENCE_NOT_VERIFIED')
    const policy=await createCommercialRuntimePolicy(sale,async()=>true)
    expect(()=>assertCommercialRuntimeOperation(policy,'new_purchase')).not.toThrow()
    expect(()=>assertCommercialRuntimeOperation({...sale,activeInstances:[{...sale.activeInstances![0]!,schemaSha256:'b'.repeat(64)}]},'new_purchase')).toThrow('MIXED_VERSION_FLEET_NOT_APPROVED')
    expect(()=>assertCommercialRuntimeOperation({mode:'rollback',policyRevision:'incident-1'},'record_cash')).not.toThrow()
  })
  it('loads hash-pinned private evidence and compares the complete observed fleet', async () => {
    const dir=mkdtempSync(join(tmpdir(),'commercial-policy-')), path=join(dir,'evidence.json')
    try {
      const document={schema:'commercial.runtime.evidence.v1',issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),fleetAttesterRef:'trusted-ingress-inventory',policy:sale}
      const raw=JSON.stringify(document);writeFileSync(path,raw,{mode:0o600})
      const config={evidencePath:path,evidenceSha256:createHash('sha256').update(raw).digest('hex'),expectedCandidateSha256:sha,expectedSchemaSha256:sha,fleetAttesterRef:document.fleetAttesterRef}
      expect(()=>assertCommercialRuntimeOperation(undefined,'new_purchase')).toThrow()
      await expect(loadCommercialRuntimePolicy(config)).rejects.toThrow('DEPLOYMENT_EVIDENCE_NOT_VERIFIED')
      await expect(loadCommercialRuntimePolicy({...config,evidenceSha256:'b'.repeat(64)},async()=>sale.activeInstances!)).rejects.toThrow('EVIDENCE_HASH_MISMATCH')
      await expect(loadCommercialRuntimePolicy(config,async()=>[...sale.activeInstances!,{...sale.activeInstances![0]!,instanceId:'unlisted-live-api'}])).rejects.toThrow('DEPLOYMENT_EVIDENCE_NOT_VERIFIED')
      const policy=await loadCommercialRuntimePolicy(config,async()=>sale.activeInstances!)
      expect(()=>assertCommercialRuntimeOperation(policy,'catalog_publish')).not.toThrow()
      const pinPath=join(dir,'deployment-pin.sha256');writeFileSync(pinPath,`${config.evidenceSha256}\n`,{mode:0o600})
      const renewed=await loadCommercialRuntimePolicy({...config,evidenceSha256:undefined,evidenceSha256Path:pinPath},async()=>sale.activeInstances!)
      expect(()=>assertCommercialRuntimeOperation(renewed,'new_purchase')).not.toThrow()
      const expired=JSON.stringify({...document,expiresAt:new Date(Date.now()-1).toISOString()});writeFileSync(path,expired,{mode:0o600})
      await expect(loadCommercialRuntimePolicy({...config,evidenceSha256:createHash('sha256').update(expired).digest('hex')},async()=>sale.activeInstances!)).rejects.toThrow('EVIDENCE_BINDING_OR_EXPIRY_INVALID')
    }finally{rmSync(dir,{recursive:true,force:true})}
  })
})
