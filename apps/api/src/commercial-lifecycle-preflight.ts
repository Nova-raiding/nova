import {ContinuousFeatureEntitlementService,type ContinuousFeatureEntitlementPort} from '../../../packages/application/src/continuous-feature-entitlement.js'
import {DomainError} from '../../../packages/application/src/service.js'

/** Diagnostic ordering for an unavailable lifecycle implementation only.
 * This is not paid admission: no qualification, reservation, grant or mutation
 * is performed. The caller MUST still return ASSET_LIFECYCLE_UNAVAILABLE after
 * a successful diagnostic. An available lifecycle uses full commercial access. */
export async function requireCommercialLifecycleDiagnostic(input:{workspaceId:string;projection:ContinuousFeatureEntitlementPort;now?:()=>Date}):Promise<{diagnosticOnly:true;snapshotId:string}> {
  const service=new ContinuousFeatureEntitlementService({projection:input.projection,...(input.now?{now:input.now}:{})})
  const decision=await service.decide({workspace_id:input.workspaceId})
  if(!decision.allowed)throw new DomainError(decision.code,'当前无法核验该工作区的有效套餐合同',decision.code==='COMMERCIAL_ENTITLEMENT_REQUIRED'?402:503,{retryable:decision.code==='COMMERCIAL_ENTITLEMENT_UNAVAILABLE',next_actions:['commercial.subscription.get']})
  return {diagnosticOnly:true,snapshotId:decision.snapshot_id}
}
