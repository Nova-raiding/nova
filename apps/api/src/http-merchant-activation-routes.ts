import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { PasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'

export const merchantActivationPath = '/v1/auth/merchant-activation'
export interface MerchantAccountInvitationDependencies {
  repository: PasswordAuthRepository
  requireOperationsRole: (request: IncomingMessage, roles: readonly string[]) => string
  requestActor: (request: IncomingMessage) => string
  readBody: (limit: number) => Promise<Record<string, unknown>>
  publicOrigin: string
  production: boolean
  /** Merchant Nginx strips /api; direct isolated API uses an empty prefix. */
  publicApiPathPrefix?: '/api' | ''
}
function safeOrigin(origin: string, production: boolean): string {
  let parsed: URL
  try { parsed = new URL(origin) } catch { throw new DomainError('AUTH_ACTIVATION_ORIGIN_UNAVAILABLE', '商家邀请入口未配置，联系安装或运营负责人', 503) }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || (production ? parsed.protocol !== 'https:' : !['http:', 'https:'].includes(parsed.protocol))) throw new DomainError('AUTH_ACTIVATION_ORIGIN_UNAVAILABLE', '商家邀请入口配置不符合安全要求', 503)
  return parsed.origin
}
const errorCode = (error: unknown): string => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error && error.message === 'PASSWORD_POLICY_INVALID' ? 'AUTH_PASSWORD_POLICY_INVALID' : 'AUTH_ACCOUNT_INVITATION_FAILED'

export async function inviteMerchantAccount(req: IncomingMessage, deps: MerchantAccountInvitationDependencies): Promise<{ status: number; data: unknown }> {
  deps.requireOperationsRole(req, ['platform_ops', 'platform_admin', 'ops_admin'])
  const origin = safeOrigin(deps.publicOrigin, deps.production)
  if (!deps.repository.createMerchantInvitation) throw new DomainError('AUTH_ACTIVATION_REPOSITORY_UNAVAILABLE', '安全邀请仓储未配置，账号未创建', 503)
  const input = await deps.readBody(64 * 1024)
  if (Object.keys(input).some(key => !['login', 'enterprise_name', 'contact_name', 'workspace_ids', 'create_workspace', 'reason', 'idempotency_key', 'action'].includes(key))) throw new DomainError('AUTH_ACCOUNT_INVITATION_INVALID', '邀请开户不接受密码、金额或付款核验字段，请更新客户端', 400)
  if (['login', 'enterprise_name', 'contact_name', 'reason', 'idempotency_key'].some(key => typeof input[key] !== 'string')) throw new DomainError('AUTH_ACCOUNT_INVITATION_INVALID', '登录邮箱、企业、联系人、原因及请求标识需有效填写', 400)
  if ((input.action !== undefined && !['create', 'reissue'].includes(String(input.action))) || (input.create_workspace !== undefined && typeof input.create_workspace !== 'boolean') || !Array.isArray(input.workspace_ids) || input.workspace_ids.some(value => typeof value !== 'string') || input.workspace_ids.length > 1) throw new DomainError('AUTH_ACCOUNT_INVITATION_INVALID', '请选择一个现有企业，或明确创建一个新企业', 400)
  try {
    const result = await deps.repository.createMerchantInvitation({ login: String(input.login ?? ''), enterpriseName: String(input.enterprise_name ?? ''), contactName: String(input.contact_name ?? ''),
      workspaceIds: input.workspace_ids as string[], createWorkspace: input.create_workspace === true, actorId: deps.requestActor(req), reason: String(input.reason ?? ''), idempotencyKey: String(input.idempotency_key ?? ''), action: input.action as 'create' | 'reissue' | undefined })
    const { token, ...invitation } = result.invitation
    return { status: result.invitation.replayed ? 200 : 201, data: { account: result.account,
      invitation: { id: invitation.id, expires_at: invitation.expiresAt, status: invitation.status, replayed: invitation.replayed,
        ...(token ? { activation_link: `${origin}${deps.publicApiPathPrefix ?? (deps.production ? '/api' : '')}${merchantActivationPath}#token=${encodeURIComponent(token)}` } : {}), delivery_status: 'not_sent',
        ...(invitation.replayed && invitation.status !== 'activated' ? { next_action: 'reissue_invitation' } : {}) },
      commercial_qualification_granted: false, capabilities_granted: [] } }
  } catch (error) {
    if (error instanceof DomainError) throw error
    const code = errorCode(error)
    const status = ['AUTH_LOGIN_ALREADY_EXISTS', 'AUTH_ACTIVATION_IDEMPOTENCY_CONFLICT', 'AUTH_ACTIVATION_REISSUE_UNAVAILABLE'].includes(code) ? 409 : ['AUTH_LOGIN_INVALID', 'AUTH_REGISTRATION_INVALID', 'AUTH_ACCOUNT_PROVISIONING_INVALID', 'AUTH_WORKSPACE_NOT_FOUND'].includes(code) ? 400 : 503
    throw new DomainError(code, status === 409 ? '账号或邀请意图已存在，请查询原结果；只有尚未激活的邀请可以重新签发' : status === 400 ? '邀请信息或绑定企业无效，请核对输入' : '邀请创建结果未确认，请沿用原幂等标识查询，勿重复创建账号', status, { retryable: status === 503, commercial_qualification_granted: false })
  }
}

/** Public activation page contains no user data or token. The fragment is
 * read only in the customer's browser and sent in a no-store HTTPS POST. */
export async function handleMerchantActivationRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: Pick<MerchantAccountInvitationDependencies, 'repository' | 'readBody'> & { send: (status: number, data: unknown) => void }): Promise<boolean> {
  if (path !== merchantActivationPath || !['GET', 'POST'].includes(req.method ?? '')) return false
  res.setHeader('cache-control', 'no-store')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('x-content-type-options', 'nosniff')
  if (req.method === 'GET') {
    const nonce = randomBytes(18).toString('base64url')
    const style = 'body{font:16px system-ui,sans-serif;margin:48px auto;padding:0 24px;max-width:520px;color:#172b4d}label,input,button{display:block;margin:16px 0}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box}input[type=checkbox]{display:inline;width:auto}button{min-height:44px}#status{line-height:1.6}'
    const styleHash = createHash('sha256').update(style).digest('base64')
    res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'sha256-${styleHash}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`)
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.statusCode = 200
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>激活商家登录</title><style>${style}</style><main><h1>激活商家登录账号</h1><p>请由账号本人设置密码。激活仅开放登录与订单查询，付费功能仍须企业真实开通及有效套餐。</p><form id="activation"><label for="password">设置密码（8–256位，包含字母和数字）</label><input id="password" type="password" minlength="8" maxlength="256" autocomplete="new-password" required><label for="confirmation">再次输入密码</label><input id="confirmation" type="password" autocomplete="new-password" required><label><input id="terms" type="checkbox" required>我确认本人使用此账号，已阅读并同意项目服务条款与隐私约定</label><button type="submit">确认设密并激活登录</button></form><p id="status" role="status" aria-live="polite"></p><script nonce="${nonce}">const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';history.replaceState(null,'',location.pathname);const form=document.getElementById('activation'),status=document.getElementById('status');if(!token){status.textContent='邀请缺失，请联系运营重新签发。';form.querySelector('button').disabled=true;}form.addEventListener('submit',async event=>{event.preventDefault();const password=document.getElementById('password').value;if(password!==document.getElementById('confirmation').value){status.textContent='两次密码不一致。';return;}const button=form.querySelector('button');button.disabled=true;status.textContent='正在核验邀请并激活登录…';try{const response=await fetch(location.pathname,{method:'POST',credentials:'omit',headers:{'content-type':'application/json'},body:JSON.stringify({token,password,terms_agreed:document.getElementById('terms').checked})});const result=await response.json();if(!response.ok)throw Error(result.error?.message||'邀请无效或已过期，请联系运营重新签发。');form.reset();form.hidden=true;status.textContent='登录账号已激活。请返回商家后台登录；付费开通状态以企业订单核验结果为准。';}catch(error){status.textContent=error.message||'激活结果待确认。请尝试商家登录或请运营查询原邀请，勿重复开户。';button.disabled=false;}});</script></main></html>`)
    return true
  }
  if (!deps.repository.confirmMerchantInvitation) throw new DomainError('AUTH_ACTIVATION_REPOSITORY_UNAVAILABLE', '安全激活仓储未配置，联系运营负责人', 503)
  const input = await deps.readBody(32 * 1024)
  if (Object.keys(input).some(key => !['token', 'password', 'terms_agreed'].includes(key)) || typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/u.test(input.token) || typeof input.password !== 'string' || input.password.length > 256 || input.terms_agreed !== true) throw new DomainError('AUTH_ACTIVATION_INVALID', '有效邀请、本人密码及条款确认均为必填', 400)
  try {
    await deps.repository.confirmMerchantInvitation({ token: input.token, password: input.password, termsAgreed: true })
    deps.send(200, { activated: true, login_required: true, commercial_qualification_granted: false })
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'AUTH_ACCOUNT_INVITATION_FAILED') throw new DomainError('AUTH_ACTIVATION_OUTCOME_UNKNOWN', '激活结果待确认，请尝试商家登录或让运营查询原邀请，勿重新开户', 503, { retryable: true, commercial_qualification_granted: false })
    throw new DomainError(code, code === 'AUTH_PASSWORD_POLICY_INVALID' ? '密码须8–256位并包含字母和数字' : code === 'AUTH_ACTIVATION_MEMBERSHIP_CHANGED' ? '企业或成员状态已变化，请联系运营核对' : '邀请无效、已使用或已过期，请由运营查询并重新签发', 400, { commercial_qualification_granted: false })
  }
}
