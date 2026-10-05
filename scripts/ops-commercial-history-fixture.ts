import {createHash,randomBytes} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {Pool} from 'pg'
import type {IsolatedOpsFixture} from '../tests/isolated-ops-fixture.js'
import {PostgresCommercialCatalogRepository,type CommercialCatalogBenefit,type CommercialCatalogSkuSnapshot} from '../packages/persistence/src/commercial-catalog-repository.js'
import {PostgresCommercialContractRepository} from '../packages/persistence/src/commercial-contract-repository.js'
import {PostgresPasswordAuthRepository} from '../packages/persistence/src/password-auth-repository.js'
import {PostgresMembersRepository} from '../packages/persistence/src/members-repository.js'
/** Called only inside the dedicated runner-owned disposable DB, never API wire input.
 * Historical times create genuine immutable facts; no UPDATE of an order/period. */
export async function prepareOwnedCommercialHistoryFixture(fixture:IsolatedOpsFixture,evidenceDir:string) {
  const admin=new Pool({connectionString:fixture.adminDatabaseUrl,max:1}),ops=new Pool({connectionString:fixture.opsDatabaseUrl,max:1}),app=new Pool({connectionString:fixture.databaseUrl,max:1})
  try {
    const db=await admin.query<{role:string;database:string}>(`SELECT current_user AS role,current_database() AS database`)
    if(db.rows[0]?.role!=='merchant'||db.rows[0]?.database!=='merchant'||!fixture.workspaceId.startsWith('ws_ops_fixture_'))throw new Error('OPS_E2E_COMMERCIAL_HISTORY_NOT_OWNED')
    const suffix=fixture.runId.replaceAll('-','').slice(0,16),workspaceId=`ws-owned-history-${suffix}`
    const login=`history-${suffix}@fixture.invalid`,password=`A1${randomBytes(24).toString('hex')}`
    await admin.query(`INSERT INTO workspaces(id,status) VALUES($1,'active')`,[workspaceId])
    const account=await new PostgresPasswordAuthRepository(ops).createMerchantAccount({login,password,enterpriseName:'owned-test 半期历史企业',contactName:'owned-test 历史商家',workspaceIds:[workspaceId],actorId:`owned-test-controller:${fixture.runId}`,reason:'owned-test declared historical source scenario, not a live bank transfer'})
    const members=new PostgresMembersRepository(admin)
    await members.upsert({workspaceId,externalSubject:login,displayName:'owned-test 历史商家',role:'merchant_admin',status:'active',invitedBy:'owned-test-history-bootstrap'})
    if(account.identityId)await members.bindIdentity({workspaceId,externalSubject:login,identityId:account.identityId})
    const clock=Date.now(),verifiedAt=new Date(clock-15*86400000).toISOString(),publishedAt=new Date(Date.parse(verifiedAt)-60_000)
    const catalog=new PostgresCommercialCatalogRepository(ops,()=>publishedAt),contracts=new PostgresCommercialContractRepository(app)
    const ref=`owned-test:${fixture.runId}:historical-policy`
    const benefit=(code:string,quantity:number):CommercialCatalogBenefit=>({code,quantity,rawValue:null,rawUnit:null,normalizedValue:null,policyRef:ref,metadata:{scope:'owned-test'}})
    const publish=async(code:string,kind:CommercialCatalogSkuSnapshot['kind'],priceFen:number,rank?:number)=>{
      const payload={blockers:[],name:`owned-test ${kind==='onboarding'?'历史开通费':rank===1?'历史基础':'历史成长'}`,purchasePolicy:{approved:true,version:ref,expiresInSeconds:3600},...(kind==='onboarding'?{policyRef:{policyId:'commercial.onboarding',version:'v2'},grantSchedule:{policyRef:{policyId:'commercial.onboarding',version:'v2'},grantCount:6,pointsPerGrant:500,cadence:'monthly',timezone:'UTC',startsAt:'payment_verified',grantExpiresAtRule:'next_monthly_anniversary',schedulingStatus:'resolved'}}:{cycle:{unit:'month',count:1},planFamily:`owned-history-${suffix}`,tierRank:rank,upgradePolicy:{approved:true,version:ref}})}
      const benefits=kind==='onboarding'?[benefit('creative_points',500)]:[benefit('monthly_creative_points',rank===1?5000:12500),benefit('max_brands',rank!),benefit('max_stores',rank!*5)]
      let result=await catalog.mutate({action:'create',code,kind,priceFen,payload,benefits,expectedRevision:0,idempotencyKey:`${code}:create`,actorId:'owned-test-historical-maker',reason:ref,evidence:{scope:'owned-test'}})
      for(const [action,actorId] of [['submit','owned-test-historical-maker'],['approve','owned-test-historical-independent-approver'],['publish','owned-test-history-controller']] as const)result=await catalog.mutate({action,code,versionId:result.versionId,expectedRevision:result.saleRevision!,idempotencyKey:`${code}:${action}`,actorId,reason:ref,evidence:{scope:'owned-test',approval_ref:ref}})
      return result
    }
    const opening=await publish(`owned_history_open_${suffix}`,'onboarding',500000),basic=await publish(`owned_history_basic_${suffix}`,'monthly',200000,1),growth=await publish(`owned_history_growth_${suffix}`,'monthly',500000,2)
    const checkout=await contracts.createFirstCheckout({workspaceId,actorId:'owned-test-historical-maker',onboardingSku:opening,subscriptionSku:basic,paymentProvider:'manual_transfer',idempotencyKey:`owned-history:${fixture.runId}`,reason:ref,now:verifiedAt})
    for(const order of [checkout.onboarding,checkout.subscription])await contracts.recordVerifiedPaymentAndGrant({workspaceId,orderId:order.id,provider:'manual_transfer',providerEventId:`owned-historical-bank:${order.id}`,providerOrderId:order.id,nonce:`owned-historical-bank:${order.id}`,payloadHash:createHash('sha256').update(`owned-history:${order.id}`).digest('hex'),amountFen:order.amountFen,currency:'CNY',paidAt:verifiedAt,verifiedAt,paymentSubjectRef:'owned-test-historical-bank-no-external-money'})
    const portfolio=await contracts.getSubscriptionSummary({workspaceId})
    if(!portfolio.onboardingQualified||!portfolio.current||portfolio.current.skuCode!==basic.code)throw new Error('OPS_E2E_COMMERCIAL_HISTORY_NOT_ACTIVE')
    const current=portfolio.current as typeof portfolio.current & {periodStart:string;periodEnd:string}
    const fraction=(Date.parse(current.periodEnd)-clock)/(Date.parse(current.periodEnd)-Date.parse(current.periodStart))
    if(fraction<0.4||fraction>0.6)throw new Error('OPS_E2E_COMMERCIAL_HISTORY_NOT_HALF_PERIOD')
    const path=resolve(evidenceDir,'owned-commercial-history.json')
    writeFileSync(path,JSON.stringify({scope:'owned-test-historical-seed',runId:fixture.runId,workspaceId,basicCode:basic.code,growthCode:growth.code,growthName:growth.payload.name,sourceOrderId:checkout.subscription.id,periodStart:current.periodStart,periodEnd:current.periodEnd,remainingFraction:fraction,verifiedAt,publishedAt:publishedAt.toISOString(),immutableDatesUpdated:false,externalBankTransfer:false},null,2),{mode:0o600,flag:'wx'})
    return {OPS_E2E_COMMERCIAL_HISTORY_FIXTURE:path,OPS_E2E_HISTORY_MERCHANT_USERNAME:login,OPS_E2E_HISTORY_MERCHANT_PASSWORD:password,OPS_E2E_HISTORY_WORKSPACE_ID:workspaceId}
  } finally {await Promise.all([admin.end(),ops.end(),app.end()])}
}

/** Third account self-activates through the real invitation repository, without buying qualification. */
export async function prepareOwnedCommercialPendingFixture(fixture:IsolatedOpsFixture,evidenceDir:string) {
  const admin=new Pool({connectionString:fixture.adminDatabaseUrl,max:1}),ops=new Pool({connectionString:fixture.opsDatabaseUrl,max:1}),app=new Pool({connectionString:fixture.databaseUrl,max:1})
  try {
    const identity=await admin.query<{role:string;database:string}>(`SELECT current_user AS role,current_database() AS database`)
    if(identity.rows[0]?.role!=='merchant'||identity.rows[0]?.database!=='merchant'||!fixture.workspaceId.startsWith('ws_ops_fixture_'))throw new Error('OPS_E2E_COMMERCIAL_PENDING_NOT_OWNED')
    const suffix=fixture.runId.replaceAll('-','').slice(0,16),workspaceId=`ws-owned-pending-${suffix}`,login=`pending-${suffix}@fixture.invalid`,password=`A1${randomBytes(24).toString('hex')}`
    await admin.query(`INSERT INTO workspaces(id,status) VALUES($1,'active')`,[workspaceId])
    const auth=new PostgresPasswordAuthRepository(ops)
    const invitation=await auth.createMerchantInvitation({login,enterpriseName:'owned-test 未开通企业',contactName:'owned-test 未开通商家',workspaceIds:[workspaceId],createWorkspace:false,actorId:`owned-test-controller:${fixture.runId}`,reason:'owned-test self-activation without commercial qualification',idempotencyKey:`owned-pending:${fixture.runId}`})
    if(!invitation.invitation.token||invitation.account.status!=='merchant_pending')throw new Error('OPS_E2E_COMMERCIAL_PENDING_INVITE_INVALID')
    const account=await auth.confirmMerchantInvitation({token:invitation.invitation.token,password,termsAgreed:true})
    if(account.status!=='active'||account.workspaceIds.length!==1||account.workspaceIds[0]!==workspaceId)throw new Error('OPS_E2E_COMMERCIAL_PENDING_ACTIVATION_INVALID')
    const portfolio=await new PostgresCommercialContractRepository(app).getSubscriptionSummary({workspaceId})
    if(portfolio.onboardingQualified||portfolio.current||portfolio.future.length)throw new Error('OPS_E2E_COMMERCIAL_PENDING_ALREADY_OPENED')
    writeFileSync(resolve(evidenceDir,'owned-commercial-pending.json'),JSON.stringify({scope:'owned-test-self-activated-not-opened',workspaceId,accountId:account.id,invitationId:invitation.invitation.id,termsAccepted:true,commercialQualificationGranted:false,externalBankTransfer:false}),{mode:0o600,flag:'wx'})
    return {OPS_E2E_PENDING_MERCHANT_USERNAME:login,OPS_E2E_PENDING_MERCHANT_PASSWORD:password,OPS_E2E_PENDING_WORKSPACE_ID:workspaceId}
  } finally {await Promise.all([admin.end(),ops.end(),app.end()])}
}
