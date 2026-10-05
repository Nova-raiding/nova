import { randomUUID } from 'node:crypto'
import type { SqlPool } from './repository.js'
import { commercialCatalogContentHash, CommercialCatalogConflictError, CommercialCatalogUnavailableError, type CommercialCatalogBenefit } from './commercial-catalog-repository.js'
import { COMMERCIAL_BENEFIT_DEFINITIONS } from './commercial-benefit-definitions.js'

export interface CommercialBenefitBundleSnapshot {
  id: string; code: string; versionId: string; version: number; name: string
  usage: 'included' | 'standalone'; lifecycle: 'draft' | 'pending_business_approval' | 'approved' | 'rejected'
  benefits: CommercialCatalogBenefit[]; payload: Record<string, unknown>; checksum: string
  revision: number; state: 'active' | 'disabled' | 'archived' | 'deleted'
}
export interface CommercialBenefitBundleMutationInput {
  action: 'create' | 'submit' | 'approve' | 'reject' | 'retire' | 'archive' | 'delete_draft'
  code: string; versionId?: string; expectedRevision: number; idempotencyKey: string
  name?: string; usage?: CommercialBenefitBundleSnapshot['usage']; benefits?: CommercialCatalogBenefit[]
  payload?: Record<string, unknown>; actorId: string; reason: string; evidence: Record<string, unknown>
}
export interface CommercialBenefitBundlePageInput { code?: string; search?: string; afterId?: string; limit?: number }
export interface CommercialBenefitBundleReference {
  id: string; reference_kind: 'sku' | 'order'; bundle_version_id: string
  sku_version_id: string; sku_code: string; workspace_id: string | null; order_id: string | null
}
function pageLimit(limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CommercialCatalogConflictError('limit must be an integer from 1 to 100')
  return limit
}
const projection = `b.id,b.code,b.usage,b.state,b.revision,v.id AS "versionId",v.version,v.name,v.lifecycle,v.benefits,v.payload,v.checksum`
export class PostgresCommercialBenefitBundleRepository {
  constructor(private readonly pool: SqlPool) {}
  definitions() { return structuredClone(COMMERCIAL_BENEFIT_DEFINITIONS) }
  async list(): Promise<CommercialBenefitBundleSnapshot[]> { return (await this.listPage({limit:100})).items }
  async listPage(input: CommercialBenefitBundlePageInput = {}) {
    const limit = pageLimit(input.limit), c = await this.pool.connect()
    const params = [input.code ?? null, input.search ?? null]
    const filter = `($1::text IS NULL OR b.code=$1) AND ($2::text IS NULL OR strpos(b.code || ' ' || v.name,$2)>0)`
    try {
      if (input.afterId) {
        const cursor = await c.query(`SELECT v.id FROM commercial_benefit_bundles_v3 b JOIN commercial_benefit_bundle_versions_v3 v ON v.bundle_id=b.id WHERE ${filter} AND v.id=$3`, [...params,input.afterId])
        if (!cursor.rows.length) throw new CommercialCatalogConflictError('bundle cursor does not identify a record in this filter')
      }
      const rows = (await c.query<CommercialBenefitBundleSnapshot>(`SELECT ${projection} FROM commercial_benefit_bundles_v3 b JOIN commercial_benefit_bundle_versions_v3 v ON v.bundle_id=b.id WHERE ${filter} AND ($3::text IS NULL OR v.id COLLATE "C">$3::text COLLATE "C") ORDER BY v.id COLLATE "C" LIMIT $4`, [...params,input.afterId ?? null,limit+1])).rows
      const count = await c.query<{total:number}>(`SELECT count(*)::int AS total FROM commercial_benefit_bundles_v3 b JOIN commercial_benefit_bundle_versions_v3 v ON v.bundle_id=b.id WHERE ${filter}`,params)
      const items=rows.slice(0,limit)
      return {items,total:count.rows[0]?.total ?? 0,nextAfterId:rows.length>limit?items.at(-1)!.versionId:null}
    } finally { c.release?.() }
  }
  async referencesPage(input: {code:string;versionId?:string;afterId?:string;limit?:number}) {
    const limit=pageLimit(input.limit),c=await this.pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SELECT set_config('app.platform_scope','platform_ops',true)`)
      const result=await c.query<{page:{items:CommercialBenefitBundleReference[];total:number;next_after_id:string|null}}>(`SELECT public.merchant_ops_benefit_bundle_references_v3($1,$2,$3,$4) AS page`,[input.code,input.versionId??null,input.afterId??null,limit])
      await c.query('COMMIT')
      const page=result.rows[0]?.page
      if(!page)throw new CommercialCatalogUnavailableError('controlled bundle reference reader is unavailable')
      return {items:page.items,total:page.total,nextAfterId:page.next_after_id}
    }catch(error){await c.query('ROLLBACK');throw error}finally{c.release?.()}
  }
  /** Compatibility port: this is explicitly a single bounded page, never an all-history lookup. */
  async references(versionId: string) {
    const c=await this.pool.connect()
    let code:string|undefined
    try {code=(await c.query<{code:string}>(`SELECT b.code FROM commercial_benefit_bundles_v3 b JOIN commercial_benefit_bundle_versions_v3 v ON v.bundle_id=b.id WHERE v.id=$1`,[versionId])).rows[0]?.code}finally{c.release?.()}
    return code?(await this.referencesPage({code,versionId,limit:100})).items:[]
  }
  async mutate(input: CommercialBenefitBundleMutationInput): Promise<CommercialBenefitBundleSnapshot> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(input.code) || !input.idempotencyKey?.trim() || !input.actorId?.trim() || !input.reason?.trim() || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0) throw new CommercialCatalogConflictError('valid code, revision, idempotency key, actor and reason required')
    if (!['create','submit','approve','reject','retire','archive','delete_draft'].includes(input.action)) throw new CommercialCatalogUnavailableError('unknown bundle action')
    if (input.action !== 'create' && [input.name,input.usage,input.benefits,input.payload].some(v=>v!==undefined)) throw new CommercialCatalogConflictError('lifecycle actions cannot edit bundle content')
    const c=await this.pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('commercial_bundle_v3'),hashtext($1))`,[input.code])
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('commercial_bundle_request'),hashtext($1))`,[`${input.actorId}:${input.idempotencyKey}`])
      const hash=commercialCatalogContentHash(input)
      const replay=await c.query<{request_hash:string;result:CommercialBenefitBundleSnapshot}>(`SELECT request_hash,result FROM commercial_bundle_mutations_v3 WHERE actor_id=$1 AND idempotency_key=$2`,[input.actorId,input.idempotencyKey])
      if(replay.rows[0]) { if(replay.rows[0].request_hash!==hash) throw new CommercialCatalogConflictError('idempotency key reused'); await c.query('COMMIT');return replay.rows[0].result }
      const rows=(await c.query<CommercialBenefitBundleSnapshot>(`SELECT ${projection} FROM commercial_benefit_bundles_v3 b JOIN commercial_benefit_bundle_versions_v3 v ON v.bundle_id=b.id WHERE b.code=$1 ORDER BY v.version DESC`,[input.code])).rows
      const latest=rows[0], base=input.versionId?rows.find(v=>v.versionId===input.versionId):latest
      if(!base && (input.action!=='create'||input.versionId))throw new CommercialCatalogUnavailableError('bundle version not found')
      if((latest?.revision??0)!==input.expectedRevision||latest&&['archived','deleted'].includes(latest.state))throw new CommercialCatalogConflictError('bundle revision changed or archived')
      if(input.usage&&latest&&input.usage!==latest.usage)throw new CommercialCatalogConflictError('bundle usage is immutable')
      if(input.action==='submit'&&base!.lifecycle!=='draft')throw new CommercialCatalogConflictError('submission requires a draft')
      if(input.action==='reject'&&!['draft','pending_business_approval'].includes(base!.lifecycle))throw new CommercialCatalogConflictError('rejection requires a draft or submitted version')
      if(input.action==='approve'&&!['draft','pending_business_approval'].includes(base!.lifecycle))throw new CommercialCatalogConflictError('approval requires a draft or submitted version')
      if(input.action==='delete_draft'&&rows.some(v=>v.lifecycle==='approved'))throw new CommercialCatalogConflictError('approved bundles must be archived')
      const benefits=structuredClone(input.action==='create'?input.benefits??base?.benefits??[]:base!.benefits)
      for(const b of benefits)if(!b.code?.trim()||b.code.length>128||[b.quantity,b.normalizedValue].some(v=>v!==null&&(!Number.isSafeInteger(v)||v<0)))throw new CommercialCatalogUnavailableError('benefit quantities must be safe non-negative integers')
      if(benefits.length>100||new Set(benefits.map(b=>b.code)).size!==benefits.length)throw new CommercialCatalogUnavailableError('bundle benefits must be bounded and unique')
      if(input.action==='approve')for(const b of benefits){
        if(!COMMERCIAL_BENEFIT_DEFINITIONS.some(d=>d.code===b.code)||b.quantity===null||!Number.isSafeInteger(b.quantity)||b.quantity<0||!b.policyRef)throw new CommercialCatalogUnavailableError(`unregistered or unresolved benefit ${b.code}`)
        if(b.code.startsWith('feature.')&&b.quantity!==0&&b.quantity!==1)throw new CommercialCatalogUnavailableError('feature grant must be boolean 0/1')
        if(b.code==='cloud_storage'&&(!Number.isSafeInteger(b.normalizedValue)||b.normalizedValue!<0))throw new CommercialCatalogUnavailableError('storage normalized bytes required')
      }
      benefits.sort((a,b)=>a.code.localeCompare(b.code))
      const id=latest?.id??`bundle-${input.code}`,version=(latest?.version??0)+1,payload=structuredClone(input.action==='create'?{...base?.payload,...input.payload}:base!.payload)
      if(payload.bundleRefs!==undefined)throw new CommercialCatalogUnavailableError('nested bundle references are not supported')
      const name=input.action==='create'?input.name??base?.name??input.code:base!.name
      if(!name.trim()||name.length>128)throw new CommercialCatalogUnavailableError('bundle name must be 1–128 characters')
      const result:CommercialBenefitBundleSnapshot={id,code:input.code,versionId:`${id}-v${version}-${randomUUID()}`,version,name,usage:latest?.usage??input.usage??'included',lifecycle:input.action==='approve'?'approved':input.action==='submit'?'pending_business_approval':input.action==='reject'?'rejected':'draft',benefits,payload,checksum:commercialCatalogContentHash({name,benefits,payload}),revision:(latest?.revision??0)+1,state:input.action==='retire'?'disabled':input.action==='archive'?'archived':input.action==='delete_draft'?'deleted':latest?.state??'active'}
      if(!latest)await c.query(`INSERT INTO commercial_benefit_bundles_v3(id,code,usage) VALUES($1,$2,$3)`,[id,input.code,result.usage])
      await c.query(`SELECT id FROM commercial_benefit_bundles_v3 WHERE id=$1 FOR UPDATE`,[id])
      await c.query(`INSERT INTO commercial_benefit_bundle_versions_v3(id,bundle_id,version,name,lifecycle,benefits,payload,checksum,actor_id,reason,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb)`,[result.versionId,id,version,name,result.lifecycle,JSON.stringify(benefits),JSON.stringify(payload),result.checksum,input.actorId,input.reason,JSON.stringify(input.evidence)])
      await c.query(`UPDATE commercial_benefit_bundles_v3 SET revision=$2,state=$3 WHERE id=$1`,[id,result.revision,result.state])
      await c.query(`INSERT INTO commercial_bundle_mutations_v3(actor_id,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)`,[input.actorId,input.idempotencyKey,hash,JSON.stringify(result)])
      await c.query('COMMIT');return result
    }catch(e){try{await c.query('ROLLBACK')}catch{/* preserve original */}throw e}finally{c.release?.()}
  }
}
