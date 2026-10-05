import {createHash} from 'node:crypto'
import {lstatSync} from 'node:fs'
import {dirname,isAbsolute} from 'node:path'
import {readSafeRuntimeEvidenceFile} from './safe-evidence-file.js'
/** Deployment-owned policy. Never construct this from HTTP/MCP parameters.
 * A rollout approval is evidence about the whole active fleet, not this process.
 */
export const COMMERCIAL_SALES_PROTOCOL = 'commercial.sales.v3' as const
export type CommercialRuntimeOperation = 'read' | 'record_cash' | 'new_purchase' | 'new_upgrade' | 'new_quote' | 'catalog_publish' | 'new_recovery_intent' | 'existing_fulfillment' | 'existing_worker' | 'approved_refund_recovery'
export interface CommercialRuntimePolicy {
  mode: 'compatibility' | 'sale' | 'rollback'
  policyRevision: string
  approvedEvidenceRef?: string
  catalogManualAuditRef?: string
  runtimeAcceptanceRef?: string
  catalogAuditSha256?: string
  candidateSha256?: string
  schemaSha256?: string
  fleetEvidenceRef?: string
  deploymentEvidenceVerified?: boolean
  expiresAt?: string
  activeInstances?: readonly {instanceId: string; salesProtocol: string; candidateSha256: string; schemaSha256: string}[]
}
export interface CommercialExistingIntentEvidence {
  /** Derived from persisted facts by the caller, never a client assertion. */
  existingIntentId: string
  originalFulfillmentValid?: boolean
  refundApprovalId?: string
}
export class CommercialRuntimePolicyError extends Error {
  readonly code = 'COMMERCIAL_RUNTIME_WRITE_BLOCKED'
  readonly status = 503
  constructor(readonly reason: string) { super(`商业写入被发布门禁阻断：${reason}`); this.name = 'CommercialRuntimePolicyError' }
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
export const DEFAULT_COMMERCIAL_RUNTIME_POLICY: Readonly<CommercialRuntimePolicy> = Object.freeze({mode:'compatibility',policyRevision:'commercial.runtime.v1'})

/** Compatibility and rollback preserve legitimate historical obligations. They
 * do not create replacement orders, new quotes or new refund approvals.
 */
export function assertCommercialRuntimeOperation(policy: CommercialRuntimePolicy | undefined, operation: CommercialRuntimeOperation, intent?: CommercialExistingIntentEvidence): void {
  const state = policy ?? DEFAULT_COMMERCIAL_RUNTIME_POLICY
  if (!['compatibility','sale','rollback'].includes(state.mode) || !nonempty(state.policyRevision)) throw new CommercialRuntimePolicyError('INVALID_POLICY')
  if (operation === 'read' || operation === 'record_cash') return
  if (operation === 'existing_fulfillment' || operation === 'existing_worker') {
    if (!intent || !nonempty(intent.existingIntentId) || intent.originalFulfillmentValid !== true) throw new CommercialRuntimePolicyError('EXISTING_VALID_OBLIGATION_REQUIRED')
    return
  }
  if (operation === 'approved_refund_recovery') {
    if (!intent || !nonempty(intent.existingIntentId) || !nonempty(intent.refundApprovalId)) throw new CommercialRuntimePolicyError('PERSISTED_REFUND_APPROVAL_REQUIRED')
    return
  }
  if (!['new_purchase','new_upgrade','new_quote','catalog_publish','new_recovery_intent'].includes(operation)) throw new CommercialRuntimePolicyError('UNKNOWN_WRITE_OPERATION')
  if (state.mode !== 'sale') throw new CommercialRuntimePolicyError('NEW_WRITES_CLOSED')
  if (!nonempty(state.approvedEvidenceRef) || !nonempty(state.catalogManualAuditRef) || !nonempty(state.runtimeAcceptanceRef) || !nonempty(state.fleetEvidenceRef) || ![state.catalogAuditSha256,state.candidateSha256,state.schemaSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) || state.deploymentEvidenceVerified !== true || !state.expiresAt || !Number.isFinite(Date.parse(state.expiresAt)) || Date.parse(state.expiresAt) <= Date.now()) throw new CommercialRuntimePolicyError('ROLLOUT_APPROVAL_EVIDENCE_REQUIRED')
  const instances = state.activeInstances
  if (!instances?.length || instances.some(i => !nonempty(i.instanceId) || i.salesProtocol !== COMMERCIAL_SALES_PROTOCOL || i.candidateSha256 !== state.candidateSha256 || i.schemaSha256 !== state.schemaSha256) || new Set(instances.map(i => i.instanceId)).size !== instances.length) throw new CommercialRuntimePolicyError('MIXED_VERSION_FLEET_NOT_APPROVED')
}

/** Server factory: the verifier must resolve authenticated deployment evidence
 * and compare the live fleet. An environment boolean is not a verifier.
 */
export async function createCommercialRuntimePolicy(input: CommercialRuntimePolicy | undefined, verifyDeploymentEvidence?: (policy: Readonly<CommercialRuntimePolicy>) => Promise<boolean>): Promise<Readonly<CommercialRuntimePolicy>> {
  if (!input) return DEFAULT_COMMERCIAL_RUNTIME_POLICY
  const state = structuredClone(input)
  state.deploymentEvidenceVerified = false
  if (state.mode === 'sale') {
    if (!verifyDeploymentEvidence || !await verifyDeploymentEvidence(state)) throw new CommercialRuntimePolicyError('DEPLOYMENT_EVIDENCE_NOT_VERIFIED')
    state.deploymentEvidenceVerified = true
    assertCommercialRuntimeOperation(state,'new_purchase')
  } else assertCommercialRuntimeOperation(state,'read')
  return Object.freeze(state)
}

export type CommercialFleetObserver = () => Promise<NonNullable<CommercialRuntimePolicy['activeInstances']>>
export interface CommercialRuntimeEvidenceConfig {
  evidencePath?: string
  evidenceSha256?: string
  expectedCandidateSha256?: string
  expectedSchemaSha256?: string
  fleetAttesterRef?: string
  evidenceSha256Path?: string
  production?: boolean
}
export function assertCommercialDeploymentPath(path:string,production:boolean):void {
  if(!isAbsolute(path))throw new CommercialRuntimePolicyError('FLEET_PATH_NOT_ABSOLUTE')
  if(!production)return
  for(let current=path;;current=dirname(current)){
    const stat=lstatSync(current)
    if(stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022)!==0)throw new CommercialRuntimePolicyError('FLEET_PATH_NOT_DEPLOYMENT_OWNED')
    if(current===dirname(current))break
  }
}
export function commercialRuntimeEvidenceConfig(env: Record<string,string|undefined>): CommercialRuntimeEvidenceConfig {
  return {evidencePath:env.COMMERCIAL_RUNTIME_EVIDENCE_PATH,evidenceSha256:env.COMMERCIAL_RUNTIME_EVIDENCE_SHA256,evidenceSha256Path:env.COMMERCIAL_RUNTIME_EVIDENCE_SHA256_PATH,production:env.NODE_ENV==='production',expectedCandidateSha256:env.COMMERCIAL_RUNTIME_CANDIDATE_SHA256,expectedSchemaSha256:env.COMMERCIAL_RUNTIME_SCHEMA_SHA256,fleetAttesterRef:env.COMMERCIAL_RUNTIME_FLEET_ATTESTER_REF}
}
/** Reload before each new-write decision; never cache beyond expiry. The
 * observer enumerates the whole ingress-active fleet from deployment-owned
 * inventory. A caller-selected subset of URLs is not a fleet observer.
 */
export async function loadCommercialRuntimePolicy(config: CommercialRuntimeEvidenceConfig, observeFleet?: CommercialFleetObserver): Promise<Readonly<CommercialRuntimePolicy>> {
  if (!config.evidencePath) return DEFAULT_COMMERCIAL_RUNTIME_POLICY
  const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
  let pinnedHash=config.evidenceSha256
  assertCommercialDeploymentPath(config.evidencePath,config.production===true)
  if(config.evidenceSha256Path){assertCommercialDeploymentPath(config.evidenceSha256Path,config.production===true);pinnedHash=readSafeRuntimeEvidenceFile(config.evidenceSha256Path).trim()}
  if (!hash(pinnedHash) || !hash(config.expectedCandidateSha256) || !hash(config.expectedSchemaSha256) || !nonempty(config.fleetAttesterRef)) throw new CommercialRuntimePolicyError('DEPLOYMENT_BINDINGS_REQUIRED')
  let raw: string, doc: {schema?:string;issuedAt?:string;expiresAt?:string;fleetAttesterRef?:string;policy?:CommercialRuntimePolicy}
  try {raw=readSafeRuntimeEvidenceFile(config.evidencePath);doc=JSON.parse(raw)} catch {throw new CommercialRuntimePolicyError('EVIDENCE_FILE_UNREADABLE')}
  if (createHash('sha256').update(raw).digest('hex') !== pinnedHash) throw new CommercialRuntimePolicyError('EVIDENCE_HASH_MISMATCH')
  const issued = Date.parse(doc.issuedAt ?? ''), expires = Date.parse(doc.expiresAt ?? ''), now=Date.now()
  if (doc.schema !== 'commercial.runtime.evidence.v1' || !doc.policy || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now || expires-issued > 15*60*1000 || doc.fleetAttesterRef !== config.fleetAttesterRef || doc.policy.candidateSha256 !== config.expectedCandidateSha256 || doc.policy.schemaSha256 !== config.expectedSchemaSha256) throw new CommercialRuntimePolicyError('EVIDENCE_BINDING_OR_EXPIRY_INVALID')
  return createCommercialRuntimePolicy({...doc.policy,expiresAt:doc.expiresAt},async policy => {
    if (!observeFleet) return false
    const actual = await observeFleet(), expected=policy.activeInstances
    if (!Array.isArray(actual) || !actual.length || !expected?.length || actual.length!==expected.length || new Set(actual.map(i=>i.instanceId)).size!==actual.length) return false
    const canonical = (rows:NonNullable<CommercialRuntimePolicy['activeInstances']>) => JSON.stringify(rows.map(i=>[i.instanceId,i.salesProtocol,i.candidateSha256,i.schemaSha256]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))
    return canonical(actual)===canonical(expected)
  })
}
