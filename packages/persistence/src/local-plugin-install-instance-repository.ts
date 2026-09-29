import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import type { SqlClient, SqlPool } from './repository.js'

export type LocalPluginPlatform = 'macos' | 'windows'

export interface LocalPluginInstallInstance {
  id: string
  accountId?: string
  identityId?: string
  workspaceId?: string
  platform: LocalPluginPlatform
  publicKey: string
  publicKeyFingerprint: string
  createdAt: string
  lastSeenAt: string
}

export interface LocalPluginInstallChallenge {
  id: string
  instanceId: string
  requestId: string
  nonce: string
  createdAt: string
  expiresAt: string
}

type Owner = { accountId: string; identityId: string; workspaceId: string }
type ChallengeProof = Owner & { id: string; instanceId: string; requestId: string; nonce: string; issuedAt: string; expiresAt: string; message: string; signature: string }

export interface LocalPluginInstallInstanceRepository {
  register(input: { platform: LocalPluginPlatform; publicKey: string }): Promise<{ instance: LocalPluginInstallInstance; pairingToken: string; pairingExpiresAt: string }>
  pair(input: Owner & { instanceId: string; pairingToken: string }): Promise<LocalPluginInstallInstance>
  getForOwner(input: Owner & { id: string }): Promise<LocalPluginInstallInstance | undefined>
  issueChallenge(input: Owner & { instanceId: string; requestId: string }): Promise<LocalPluginInstallChallenge>
  verifyAndConsumeChallenge(input: ChallengeProof): Promise<LocalPluginInstallInstance>
  recordTokenExchange(input: Owner & { instanceId: string; requestId: string; tokenId: string }): Promise<void>
  completeLocalBinding(input: Owner & { instanceId: string; requestId: string; tokenId: string }): Promise<void>
  hasLocalBindingCompletion(input: Owner & { requestId: string }): Promise<boolean>
}

export class LocalPluginInstallInstanceError extends Error {
  readonly code = 'LOCAL_PLUGIN_INSTALL_INSTANCE_INVALID'
  constructor() { super('local plugin install instance or challenge is invalid, expired, or already consumed') }
}

const decode = (value: string, bytes: number) => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new LocalPluginInstallInstanceError()
  const result = Buffer.from(value, 'base64url')
  if (result.length !== bytes || result.toString('base64url') !== value) throw new LocalPluginInstallInstanceError()
  return result
}
const keyBytes = (key: string) => { const der=Buffer.from(key,'base64url'); if(!der.length||der.toString('base64url')!==key) throw new LocalPluginInstallInstanceError(); const parsed=createPublicKey({key:der,format:'der',type:'spki'}); if(parsed.asymmetricKeyType!=='ec'||parsed.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw new LocalPluginInstallInstanceError(); return der }
const fingerprint = (key: string) => createHash('sha256').update(keyBytes(key)).digest('base64url')
const challengeHash = (challenge: string) => createHash('sha256').update(decode(challenge, 32)).digest('base64url')
const verifies = (key: string, message: string, signature: string) => {
  const signatureBytes=Buffer.from(signature,'base64url'); if(!signatureBytes.length||signatureBytes.toString('base64url')!==signature) throw new LocalPluginInstallInstanceError()
  return verify('sha256', Buffer.from(message,'utf8'), createPublicKey({ key:keyBytes(key), format: 'der', type: 'spki' }), signatureBytes)
}
const copy = (value: LocalPluginInstallInstance): LocalPluginInstallInstance => ({ ...value })

type MemoryChallenge = Omit<LocalPluginInstallChallenge, 'nonce'> & { challengeHash: string; consumedAt?: string }
export class MemoryLocalPluginInstallInstanceRepository implements LocalPluginInstallInstanceRepository {
  private readonly instances = new Map<string, LocalPluginInstallInstance>()
  private readonly pairing = new Map<string, { hash: string; expiresAt: string; consumed: boolean }>()
  private readonly challenges = new Map<string, MemoryChallenge>()
  readonly auditEvents: Array<{ eventType: string; instanceId: string; requestId?: string; accountId?: string; identityId?: string; workspaceId?: string; tokenId?: string }> = []
  constructor(private readonly now: () => number = Date.now, private readonly challengeTtlMs = 2 * 60_000) {}
  async register(input: { platform: LocalPluginPlatform; publicKey: string }) {
    if (input.platform !== 'macos' && input.platform !== 'windows') throw new LocalPluginInstallInstanceError()
    const now = new Date(this.now()).toISOString()
    const record: LocalPluginInstallInstance = { id: randomUUID(), ...input, publicKeyFingerprint: fingerprint(input.publicKey), createdAt: now, lastSeenAt: now }
    const pairingToken = randomBytes(32).toString('base64url'), pairingExpiresAt = new Date(this.now() + 5 * 60_000).toISOString()
    this.instances.set(record.id, record); this.pairing.set(record.id, { hash: challengeHash(pairingToken), expiresAt: pairingExpiresAt, consumed: false }); this.auditEvents.push({ eventType: 'auth.local_plugin_install_registered', instanceId: record.id }); return { instance: copy(record), pairingToken, pairingExpiresAt }
  }
  async pair(input: Owner & { instanceId: string; pairingToken: string }) { const record=this.instances.get(input.instanceId), token=this.pairing.get(input.instanceId); if(!record||record.accountId||!token||token.consumed||Date.parse(token.expiresAt)<=this.now()||token.hash!==challengeHash(input.pairingToken)) throw new LocalPluginInstallInstanceError(); Object.assign(record,{accountId:input.accountId,identityId:input.identityId,workspaceId:input.workspaceId,lastSeenAt:new Date(this.now()).toISOString()}); token.consumed=true; this.auditEvents.push({eventType:'auth.local_plugin_install_paired',instanceId:record.id}); return copy(record) }
  async getForOwner(input: Owner & { id: string }) {
    const value = this.instances.get(input.id)
    return value && value.accountId === input.accountId && value.identityId === input.identityId && value.workspaceId === input.workspaceId ? copy(value) : undefined
  }
  async issueChallenge(input: Owner & { instanceId: string; requestId: string }) {
    if (!await this.getForOwner({ ...input, id: input.instanceId })) throw new LocalPluginInstallInstanceError()
    for (const item of this.challenges.values()) if (item.instanceId === input.instanceId && item.requestId === input.requestId && !item.consumedAt) item.consumedAt = new Date(this.now()).toISOString()
    const nonce = randomBytes(32).toString('base64url'), now = this.now()
    const result: LocalPluginInstallChallenge = { id: randomUUID(), instanceId: input.instanceId, requestId: input.requestId, nonce, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.challengeTtlMs).toISOString() }
    this.challenges.set(result.id, { id: result.id, instanceId: result.instanceId, requestId: result.requestId, challengeHash: challengeHash(nonce), createdAt: result.createdAt, expiresAt: result.expiresAt })
    this.auditEvents.push({ eventType: 'auth.local_plugin_challenge_issued', instanceId: input.instanceId, requestId: input.requestId }); return { ...result }
  }
  async verifyAndConsumeChallenge(input: ChallengeProof) {
    const instance = await this.getForOwner({ ...input, id: input.instanceId }), item = this.challenges.get(input.id)
    if (!instance || !item || item.instanceId !== input.instanceId || item.requestId !== input.requestId || item.createdAt !== input.issuedAt || item.expiresAt !== input.expiresAt || item.consumedAt || Date.parse(item.expiresAt) <= this.now() || item.challengeHash !== challengeHash(input.nonce) || !verifies(instance.publicKey, input.message, input.signature)) throw new LocalPluginInstallInstanceError()
    item.consumedAt = new Date(this.now()).toISOString(); instance.lastSeenAt = item.consumedAt
    this.auditEvents.push({ eventType: 'auth.local_plugin_challenge_verified', instanceId: input.instanceId, requestId: input.requestId, accountId: input.accountId, identityId: input.identityId, workspaceId: input.workspaceId }); return copy(instance)
  }
  async recordTokenExchange(input: Owner & { instanceId: string; requestId: string; tokenId: string }) {
    if (!await this.getForOwner({ ...input, id: input.instanceId }) || !this.auditEvents.some(event => event.eventType === 'auth.local_plugin_challenge_verified' && event.instanceId === input.instanceId && event.requestId === input.requestId && event.accountId === input.accountId && event.identityId === input.identityId && event.workspaceId === input.workspaceId)) throw new LocalPluginInstallInstanceError()
    if (!this.auditEvents.some(event => event.eventType === 'auth.local_plugin_connection_token_exchanged' && event.instanceId === input.instanceId && event.requestId === input.requestId && event.accountId === input.accountId && event.identityId === input.identityId && event.workspaceId === input.workspaceId && event.tokenId === input.tokenId)) this.auditEvents.push({ eventType: 'auth.local_plugin_connection_token_exchanged', instanceId: input.instanceId, requestId: input.requestId, accountId: input.accountId, identityId: input.identityId, workspaceId: input.workspaceId, tokenId: input.tokenId })
  }
  async completeLocalBinding(input: Owner & { instanceId: string; requestId: string; tokenId: string }) {
    if (!await this.getForOwner({ ...input, id: input.instanceId }) || !this.auditEvents.some(event => event.eventType === 'auth.local_plugin_challenge_verified' && event.instanceId === input.instanceId && event.requestId === input.requestId && event.accountId === input.accountId && event.identityId === input.identityId && event.workspaceId === input.workspaceId) || !this.auditEvents.some(event => event.eventType === 'auth.local_plugin_connection_token_exchanged' && event.instanceId === input.instanceId && event.requestId === input.requestId && event.accountId === input.accountId && event.identityId === input.identityId && event.workspaceId === input.workspaceId && event.tokenId === input.tokenId)) throw new LocalPluginInstallInstanceError()
    if (!this.auditEvents.some(event => event.eventType === 'auth.local_plugin_local_binding_completed' && event.instanceId === input.instanceId && event.requestId === input.requestId && event.accountId === input.accountId && event.identityId === input.identityId && event.workspaceId === input.workspaceId && event.tokenId === input.tokenId)) this.auditEvents.push({ eventType: 'auth.local_plugin_local_binding_completed', instanceId: input.instanceId, requestId: input.requestId, accountId: input.accountId, identityId: input.identityId, workspaceId: input.workspaceId, tokenId: input.tokenId })
  }
  async hasLocalBindingCompletion(input: Owner & { requestId: string }) {
    return this.auditEvents.some(event => event.eventType === 'auth.local_plugin_local_binding_completed' && event.requestId === input.requestId && event.accountId === input.accountId && event.identityId === input.identityId && event.workspaceId === input.workspaceId && this.auditEvents.some(proof => proof.eventType === 'auth.local_plugin_challenge_verified' && proof.instanceId === event.instanceId && proof.requestId === input.requestId && proof.accountId === input.accountId && proof.identityId === input.identityId && proof.workspaceId === input.workspaceId) && this.auditEvents.some(token => token.eventType === 'auth.local_plugin_connection_token_exchanged' && token.instanceId === event.instanceId && token.requestId === input.requestId && token.accountId === input.accountId && token.identityId === input.identityId && token.workspaceId === input.workspaceId && token.tokenId === event.tokenId))
  }
}

type InstanceRow = { id:string; account_id:string|null; identity_id:string|null; workspace_id:string|null; platform:LocalPluginPlatform; public_key:string; public_key_fingerprint:string; created_at:Date|string; last_seen_at:Date|string }
const projection = 'id,account_id,identity_id,workspace_id,platform,public_key,public_key_fingerprint,created_at,last_seen_at'
const fromRow = (r: InstanceRow): LocalPluginInstallInstance => ({ id:r.id, ...(r.account_id?{accountId:r.account_id}:{}), ...(r.identity_id?{identityId:r.identity_id}:{}), ...(r.workspace_id?{workspaceId:r.workspace_id}:{}), platform:r.platform, publicKey:r.public_key, publicKeyFingerprint:r.public_key_fingerprint, createdAt:new Date(r.created_at).toISOString(), lastSeenAt:new Date(r.last_seen_at).toISOString() })

export class PostgresLocalPluginInstallInstanceRepository implements LocalPluginInstallInstanceRepository {
  constructor(private readonly pool: SqlPool) {}
  private async tx<T>(fn:(client:SqlClient)=>Promise<T>) { const client=await this.pool.connect(); try { await client.query('BEGIN'); await client.query(`SELECT set_config('app.platform_scope','platform_ops',true)`); const value=await fn(client); await client.query('COMMIT'); return value } catch(error) { try { await client.query('ROLLBACK') } catch {} throw error } finally { client.release?.() } }
  private audit(client:SqlClient, instance:LocalPluginInstallInstance, type:string, requestId?:string, tokenId?:string) { return client.query(`INSERT INTO local_plugin_install_audit (id,instance_id,event_type,account_id,identity_id,workspace_id,request_id,evidence_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[randomUUID(),instance.id,type,instance.accountId??null,instance.identityId??null,instance.workspaceId??null,requestId??null,JSON.stringify({platform:instance.platform,public_key_fingerprint:instance.publicKeyFingerprint,...(tokenId?{token_id:tokenId}:{})})]) }
  async register(input:{platform:LocalPluginPlatform;publicKey:string}) { if(input.platform!=='macos'&&input.platform!=='windows') throw new LocalPluginInstallInstanceError(); const pairingToken=randomBytes(32).toString('base64url'); return this.tx(async c=>{ const q=await c.query<InstanceRow>(`INSERT INTO local_plugin_install_instances (id,platform,public_key,public_key_fingerprint,pairing_token_hash,pairing_expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '5 minutes') RETURNING ${projection}`,[randomUUID(),input.platform,input.publicKey,fingerprint(input.publicKey),challengeHash(pairingToken)]); const record=fromRow(q.rows[0]!); await this.audit(c,record,'auth.local_plugin_install_registered'); return {instance:record,pairingToken,pairingExpiresAt:new Date(Date.now()+5*60_000).toISOString()} }) }
  async pair(input:Owner & {instanceId:string;pairingToken:string}) { return this.tx(async c=>{ const q=await c.query<InstanceRow>(`UPDATE local_plugin_install_instances SET account_id=$2,identity_id=$3,workspace_id=$4,pairing_token_hash=NULL,pairing_expires_at=NULL,last_seen_at=now() WHERE id=$1 AND account_id IS NULL AND pairing_token_hash=$5 AND pairing_expires_at>now() RETURNING ${projection}`,[input.instanceId,input.accountId,input.identityId,input.workspaceId,challengeHash(input.pairingToken)]); if(!q.rows[0]) throw new LocalPluginInstallInstanceError(); const record=fromRow(q.rows[0]); await this.audit(c,record,'auth.local_plugin_install_paired'); return record }) }
  async getForOwner(input:Owner & {id:string}) { return this.tx(async c=>{ const q=await c.query<InstanceRow>(`SELECT ${projection} FROM local_plugin_install_instances WHERE id=$1 AND account_id=$2 AND identity_id=$3 AND workspace_id=$4`,[input.id,input.accountId,input.identityId,input.workspaceId]); return q.rows[0]?fromRow(q.rows[0]):undefined }) }
  async issueChallenge(input:Owner & {instanceId:string;requestId:string}) { const nonce=randomBytes(32).toString('base64url'); return this.tx(async c=>{ const i=await c.query<InstanceRow>(`SELECT ${projection} FROM local_plugin_install_instances WHERE id=$1 AND account_id=$2 AND identity_id=$3 AND workspace_id=$4 FOR UPDATE`,[input.instanceId,input.accountId,input.identityId,input.workspaceId]); if(!i.rows[0]) throw new LocalPluginInstallInstanceError(); await c.query(`UPDATE local_plugin_install_challenges SET consumed_at=now() WHERE instance_id=$1 AND request_id=$2 AND consumed_at IS NULL`,[input.instanceId,input.requestId]); const id=randomUUID(); const q=await c.query<{created_at:Date|string;expires_at:Date|string}>(`INSERT INTO local_plugin_install_challenges (id,instance_id,request_id,challenge_hash,expires_at) VALUES ($1,$2,$3,$4,now()+interval '2 minutes') RETURNING created_at,expires_at`,[id,input.instanceId,input.requestId,challengeHash(nonce)]); const record=fromRow(i.rows[0]); await this.audit(c,record,'auth.local_plugin_challenge_issued',input.requestId); return {id,instanceId:input.instanceId,requestId:input.requestId,nonce,createdAt:new Date(q.rows[0]!.created_at).toISOString(),expiresAt:new Date(q.rows[0]!.expires_at).toISOString()} }) }
  async verifyAndConsumeChallenge(input:ChallengeProof) { return this.tx(async c=>{ const i=await c.query<InstanceRow>(`SELECT ${projection} FROM local_plugin_install_instances WHERE id=$1 AND account_id=$2 AND identity_id=$3 AND workspace_id=$4 FOR UPDATE`,[input.instanceId,input.accountId,input.identityId,input.workspaceId]); if(!i.rows[0]) throw new LocalPluginInstallInstanceError(); const instance=fromRow(i.rows[0]); if(!verifies(instance.publicKey,input.message,input.signature)) throw new LocalPluginInstallInstanceError(); const q=await c.query(`UPDATE local_plugin_install_challenges SET consumed_at=now() WHERE id=$1 AND instance_id=$2 AND request_id=$3 AND challenge_hash=$4 AND created_at=$5::timestamptz AND expires_at=$6::timestamptz AND consumed_at IS NULL AND expires_at>now() RETURNING id`,[input.id,input.instanceId,input.requestId,challengeHash(input.nonce),input.issuedAt,input.expiresAt]); if(!q.rows[0]) throw new LocalPluginInstallInstanceError(); const updated=await c.query<InstanceRow>(`UPDATE local_plugin_install_instances SET last_seen_at=now() WHERE id=$1 RETURNING ${projection}`,[input.instanceId]); const record=fromRow(updated.rows[0]!); await this.audit(c,record,'auth.local_plugin_challenge_verified',input.requestId); return record }) }
  async recordTokenExchange(input:Owner & {instanceId:string;requestId:string;tokenId:string}) { return this.tx(async c=>{ const i=await c.query<InstanceRow>(`SELECT ${projection} FROM local_plugin_install_instances WHERE id=$1 AND account_id=$2 AND identity_id=$3 AND workspace_id=$4 FOR UPDATE`,[input.instanceId,input.accountId,input.identityId,input.workspaceId]); if(!i.rows[0]) throw new LocalPluginInstallInstanceError(); const proof=await c.query(`SELECT 1 FROM local_plugin_install_audit WHERE instance_id=$1 AND request_id=$2 AND account_id=$3 AND identity_id=$4 AND workspace_id=$5 AND event_type='auth.local_plugin_challenge_verified' LIMIT 1`,[input.instanceId,input.requestId,input.accountId,input.identityId,input.workspaceId]); if(!proof.rows[0]) throw new LocalPluginInstallInstanceError(); const existing=await c.query(`SELECT 1 FROM local_plugin_install_audit WHERE instance_id=$1 AND request_id=$2 AND account_id=$3 AND identity_id=$4 AND workspace_id=$5 AND event_type='auth.local_plugin_connection_token_exchanged' AND evidence_json->>'token_id'=$6 LIMIT 1`,[input.instanceId,input.requestId,input.accountId,input.identityId,input.workspaceId,input.tokenId]); if(!existing.rows[0]) await this.audit(c,fromRow(i.rows[0]),'auth.local_plugin_connection_token_exchanged',input.requestId,input.tokenId) }) }
  async completeLocalBinding(input:Owner & {instanceId:string;requestId:string;tokenId:string}) { return this.tx(async c=>{ const i=await c.query<InstanceRow>(`SELECT ${projection} FROM local_plugin_install_instances WHERE id=$1 AND account_id=$2 AND identity_id=$3 AND workspace_id=$4 FOR UPDATE`,[input.instanceId,input.accountId,input.identityId,input.workspaceId]); if(!i.rows[0]) throw new LocalPluginInstallInstanceError(); const proof=await c.query(`SELECT 1 FROM local_plugin_install_audit WHERE instance_id=$1 AND request_id=$2 AND account_id=$3 AND identity_id=$4 AND workspace_id=$5 AND event_type='auth.local_plugin_challenge_verified' LIMIT 1`,[input.instanceId,input.requestId,input.accountId,input.identityId,input.workspaceId]); const token=await c.query(`SELECT 1 FROM local_plugin_install_audit WHERE instance_id=$1 AND request_id=$2 AND account_id=$3 AND identity_id=$4 AND workspace_id=$5 AND event_type='auth.local_plugin_connection_token_exchanged' AND evidence_json->>'token_id'=$6 LIMIT 1`,[input.instanceId,input.requestId,input.accountId,input.identityId,input.workspaceId,input.tokenId]); if(!proof.rows[0]||!token.rows[0]) throw new LocalPluginInstallInstanceError(); const existing=await c.query(`SELECT 1 FROM local_plugin_install_audit WHERE instance_id=$1 AND request_id=$2 AND account_id=$3 AND identity_id=$4 AND workspace_id=$5 AND event_type='auth.local_plugin_local_binding_completed' AND evidence_json->>'token_id'=$6 LIMIT 1`,[input.instanceId,input.requestId,input.accountId,input.identityId,input.workspaceId,input.tokenId]); if(!existing.rows[0]) await this.audit(c,fromRow(i.rows[0]),'auth.local_plugin_local_binding_completed',input.requestId,input.tokenId) }) }
  async hasLocalBindingCompletion(input:Owner & {requestId:string}) { return this.tx(async c=>{ const q=await c.query(`SELECT 1 FROM local_plugin_install_audit completed WHERE completed.request_id=$1 AND completed.account_id=$2 AND completed.identity_id=$3 AND completed.workspace_id=$4 AND completed.event_type='auth.local_plugin_local_binding_completed' AND EXISTS (SELECT 1 FROM local_plugin_install_audit proof WHERE proof.instance_id=completed.instance_id AND proof.request_id=completed.request_id AND proof.account_id=completed.account_id AND proof.identity_id=completed.identity_id AND proof.workspace_id=completed.workspace_id AND proof.event_type='auth.local_plugin_challenge_verified') AND EXISTS (SELECT 1 FROM local_plugin_install_audit token WHERE token.instance_id=completed.instance_id AND token.request_id=completed.request_id AND token.account_id=completed.account_id AND token.identity_id=completed.identity_id AND token.workspace_id=completed.workspace_id AND token.event_type='auth.local_plugin_connection_token_exchanged' AND token.evidence_json->>'token_id'=completed.evidence_json->>'token_id') LIMIT 1`,[input.requestId,input.accountId,input.identityId,input.workspaceId]); return Boolean(q.rows[0]) }) }
}
