import { createHash, randomUUID } from 'node:crypto';
import { ConnectorFailure } from './fake-connector.js';
import { jdProfile } from './profiles/jd.js';
import { taobaoProfile } from './profiles/taobao.js';
import { tmallProfile } from './profiles/tmall.js';
import { pinduoduoProfile } from './profiles/pinduoduo.js';
import { xiaohongshuProfile } from './profiles/xiaohongshu.js';
import { douyinProfile } from './profiles/douyin.js';
import { validateConnectorAuthorizationReadiness, validateConnectorReadiness } from './readiness.js';
import { assertOutboundUrl, isSecureEnvironment, officialHostsFor } from './outbound-security.js';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PLATFORM_RESPONSE_BYTES = 4 * 1024 * 1024;
const CREDENTIAL_EXPIRY_SKEW_MS = 30_000;
const ERROR_CODES = new Set(['NOT_CONFIGURED', 'UNAUTHORIZED', 'RATE_LIMITED', 'TIMEOUT', 'CONFLICT', 'VALIDATION_FAILED', 'NOT_FOUND', 'REMOTE_ERROR']);
function isRecord(value) { return typeof value === 'object' && value !== null; }
function readString(value) { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function readFiniteNumber(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}
function readImageUrls(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap(item => {
        if (typeof item === 'string' && item.trim())
            return [item.trim()];
        if (!isRecord(item))
            return [];
        const url = readString(item.url) ?? readString(item.image_url) ?? readString(item.imageUrl);
        return url ? [url] : [];
    });
}
function joinUrl(base, path) { return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`; }
function safeJson(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    }
    catch {
        return undefined;
    }
}
async function readBoundedResponseText(response, maxBytes) {
    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw { code: 'VALIDATION_FAILED', message: 'platform response exceeded safety limit' };
    }
    if (!response.body) {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes)
            throw { code: 'VALIDATION_FAILED', message: 'platform response exceeded safety limit' };
        return text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done)
                break;
            total += next.value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw { code: 'VALIDATION_FAILED', message: 'platform response exceeded safety limit' };
            }
            chunks.push(next.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}
function pkceChallenge(verifier) {
    return createHash('sha256').update(verifier).digest('base64url');
}
function normalizeWriteStatus(value, request) {
    const state = ['submitted', 'published', 'rejected', 'unknown'].includes(value.state) ? value.state : 'unknown';
    const remoteId = readString(value.remoteId);
    const requestId = readString(value.requestId);
    const found = value.found === true;
    // A platform adapter may only promote a write to published when the remote
    // query found the write and returned an attributable remote identifier. An
    // HTTP response or an unqualified mapper result is not publish evidence.
    const publishEvidence = found && Boolean(remoteId || requestId);
    return {
        found,
        state: state === 'published' && !publishEvidence ? 'unknown' : state,
        ...(remoteId ? { remoteId } : {}),
        ...(requestId ? { requestId } : {}),
        simulated: false,
    };
}
const secretKey = /token|secret|authorization|password|credential|code|signature/i;
function redact(value, depth = 0) {
    if (depth > 4)
        return '[REDACTED]';
    if (Array.isArray(value))
        return value.map(item => redact(item, depth + 1));
    if (!isRecord(value))
        return typeof value === 'string' && value.length > 20 ? '[REDACTED]' : value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(item, depth + 1)]));
}
function defaultProducts(payload, platform) {
    const candidate = isRecord(payload) && Array.isArray(payload.items) ? payload.items : Array.isArray(payload) ? payload : [];
    return candidate.filter(isRecord).map((item, index) => ({
        remoteId: readString(item.remoteId) ?? readString(item.id) ?? `${platform}-remote-${index}`,
        title: readString(item.title) ?? '', description: readString(item.description) ?? '',
        price: readFiniteNumber(item.price) ?? 0, stock: readFiniteNumber(item.stock) ?? 0,
        sku: Array.isArray(item.sku) ? item.sku.filter(isRecord).map((sku, skuIndex) => ({ id: readString(sku.id) ?? `${index}-${skuIndex}`, name: readString(sku.name) ?? '', price: readFiniteNumber(sku.price) ?? 0, stock: readFiniteNumber(sku.stock) ?? 0 })) : [],
        images: readImageUrls(item.images),
        category: readString(item.category) ?? '', attributes: isRecord(item.attributes) ? Object.fromEntries(Object.entries(item.attributes).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v])) : {},
        platformFields: item, observedAt: new Date().toISOString(),
    }));
}
export class HttpPlatformConnector {
    profile;
    options;
    platform;
    readiness;
    authorizationReadiness;
    fetchImpl;
    writes = new Map();
    constructor(profile, options) {
        this.profile = profile;
        this.options = options;
        this.platform = profile.platform;
        this.fetchImpl = options.fetch ?? fetch;
        this.readiness = validateConnectorReadiness(this.platform, options.config, { allowTestAdapters: options.allowTestAdapters });
        this.authorizationReadiness = validateConnectorAuthorizationReadiness(this.platform, options.config);
    }
    get config() { return this.options.config; }
    mediaUploadReady() { return Boolean(this.config?.mediaUploadPath && this.config.mapMediaUpload && this.config.mediaUploadEvidence && this.readiness.ready); }
    mediaUploadReadiness() {
        const configured = Boolean(this.config?.mediaUploadPath && this.config.mapMediaUpload);
        const evidence = Boolean(this.config?.mediaUploadEvidence && this.readiness.ready);
        return { configured, evidence, ready: configured && evidence };
    }
    notConfigured() { throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: `${this.platform} HTTP connector is not ready` })); }
    requireConfig() { if (!this.config || !this.options.credentials || !this.readiness.ready)
        this.notConfigured(); return this.config; }
    requireOAuthConfig() { if (!this.config || !this.options.credentials || !this.authorizationReadiness.ready)
        this.notConfigured(); return this.config; }
    requireRevokeConfig() { if (!this.config || !this.options.credentials)
        this.notConfigured(); return this.config; }
    requireProvider() {
        const provider = this.options.credentials;
        if (!provider || !provider.store || !provider.kind || (provider.kind !== 'vault' && provider.kind !== 'external' && !(provider.kind === 'test' && this.options.allowTestCredentials)))
            this.notConfigured();
        return provider;
    }
    async authorize(input) {
        const config = this.config;
        if (!config || !this.authorizationReadiness.ready)
            return { ok: false, platform: this.platform, mode: 'not_configured', code: 'NOT_CONFIGURED', message: `${this.platform} OAuth connector is not ready` };
        const params = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: input.redirectUri, state: input.state });
        if (input.codeVerifier) {
            params.set('code_challenge', pkceChallenge(input.codeVerifier));
            params.set('code_challenge_method', 'S256');
        }
        if (config.oauth.scopes?.length)
            params.set('scope', config.oauth.scopes.join(' '));
        for (const [key, value] of Object.entries(config.oauth.extraAuthorizeParams ?? {}))
            params.set(key, value);
        return { ok: true, platform: this.platform, mode: 'real', authorizationUrl: `${config.oauth.authorizeUrl}${config.oauth.authorizeUrl.includes('?') ? '&' : '?'}${params.toString()}` };
    }
    async exchangeCode(input) {
        const config = this.requireOAuthConfig();
        const provider = this.requireProvider();
        const payload = await this.request('POST', config.oauth.tokenUrl, undefined, { grant_type: 'authorization_code', code: input.code, ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}), client_id: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}), ...config.oauth.extraTokenParams }, config.oauth.tokenBodyEncoding ?? 'form');
        const credential = this.parseCredential(payload);
        // The credential exists only for this call. A production provider must
        // persist it in Vault/KMS and return an opaque reference.
        const tokenPayload = isRecord(payload) ? payload : {};
        const remoteAccountId = readString(tokenPayload.account_id) ?? readString(tokenPayload.seller_id) ?? readString(tokenPayload.user_id) ?? readString(tokenPayload.uid);
        if (!remoteAccountId)
            throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: 'OAuth token response did not identify a remote merchant account' }));
        try {
            const stored = await provider.store({ ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), accountId: remoteAccountId, credential });
            return {
                ...stored,
                ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
                ...(stored.expiresAt ?? credential.expiresAt ? { expiresAt: stored.expiresAt ?? credential.expiresAt } : {}),
                ...(credential.scope ? { scope: credential.scope } : {}),
                refreshable: Boolean(credential.refreshToken),
            };
        }
        catch {
            throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: 'credential vault is unavailable' }));
        }
    }
    async refreshCredential(ref) {
        const config = this.requireOAuthConfig();
        const provider = this.requireProvider();
        const current = await provider.resolve(ref);
        if (!current?.refreshToken || !config.oauth.refreshUrl)
            throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'refresh credential or refresh endpoint is unavailable' }));
        const payload = await this.request('POST', config.oauth.refreshUrl, undefined, { grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) }, config.oauth.tokenBodyEncoding ?? 'form');
        const next = this.parseCredential(payload, current);
        try {
            const stored = await provider.store({ ...(ref.workspaceId ? { workspaceId: ref.workspaceId } : {}), accountId: ref.accountId, credential: next });
            return {
                ...stored,
                ...(ref.workspaceId ? { workspaceId: ref.workspaceId } : {}),
                ...(stored.expiresAt ?? next.expiresAt ? { expiresAt: stored.expiresAt ?? next.expiresAt } : {}),
                ...(next.scope ? { scope: next.scope } : {}),
                refreshable: Boolean(next.refreshToken),
            };
        }
        catch {
            throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: 'credential vault is unavailable' }));
        }
    }
    async revoke(ref) {
        // Revocation must remain available even when read/write capability evidence
        // is stale: local access is disabled first and remote credential invalidation
        // is then attempted with the minimally required connector configuration.
        const config = this.requireRevokeConfig();
        const provider = this.requireProvider();
        const credential = await provider.resolve(ref);
        if (!credential)
            throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'credential is unavailable' }));
        // Disable the local credential first. A remote revoke outage must never
        // leave the account usable through this connector instance.
        try {
            await provider.revoke?.(ref);
        }
        catch {
            throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: 'credential vault is unavailable' }));
        }
        if (config.oauth.revokeUrl)
            await this.request('POST', config.oauth.revokeUrl, credential, { token: credential.accessToken, client_id: config.clientId }, config.oauth.tokenBodyEncoding ?? 'form', true);
    }
    async syncProducts(ctx, cursor) {
        const config = this.requireConfig();
        const url = new URL(joinUrl(config.api.baseUrl, config.api.syncPath));
        if (cursor?.value)
            url.searchParams.set('cursor', cursor.value);
        const payload = await this.request('GET', url.toString(), await this.resolveCredential(ctx));
        const items = config.mapProducts?.(payload, this.platform) ?? defaultProducts(payload, this.platform);
        const nextCursor = isRecord(payload) && readString(payload.nextCursor) ? { value: readString(payload.nextCursor) } : undefined;
        return { items, nextCursor, source: 'official_api', simulated: false };
    }
    mapToCanonical(raw, mapping) { return this.profile.mapProduct(raw, mapping); }
    validateWrite(input) { return this.profile.validateWrite(input); }
    async createProduct(ctx, input) { return this.write('create', ctx, input); }
    async updateProduct(ctx, input) { return this.write('update', ctx, input); }
    async queryWrite(ctx, request) {
        const config = this.requireConfig();
        const payload = await this.request('POST', joinUrl(config.api.baseUrl, config.api.queryPath), await this.resolveCredential(ctx), request);
        const mapped = config.mapWriteStatus?.(payload, request, this.platform) ?? { found: isRecord(payload) && payload.found === true, state: isRecord(payload) && ['submitted', 'published', 'rejected', 'unknown'].includes(String(payload.state)) ? payload.state : 'unknown', remoteId: isRecord(payload) ? readString(payload.remoteId) : undefined, requestId: isRecord(payload) ? readString(payload.requestId) : undefined, simulated: false };
        const result = normalizeWriteStatus(mapped, request);
        this.writes.set(request.idempotencyKey, result);
        return result;
    }
    async uploadMedia(ctx, input) {
        const config = this.requireConfig();
        if (!config.mediaUploadPath)
            throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: 'media upload adapter is not configured' }));
        const payload = await this.request('POST', joinUrl(config.api.baseUrl, config.mediaUploadPath), await this.resolveCredential(ctx), {
            visualRef: input.visualRef, role: input.role, mimeType: input.mimeType, sha256: input.sha256, idempotencyKey: input.idempotencyKey, contentBase64: Buffer.from(input.bytes).toString('base64'),
        });
        const mapped = config.mapMediaUpload?.(payload, input, this.platform);
        const record = isRecord(payload) ? payload : {};
        const mediaId = mapped?.mediaId ?? readString(record.mediaId) ?? readString(record.id);
        if (!mediaId)
            throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: 'media upload response did not identify a media object' }));
        const url = mapped?.url ?? readString(record.url);
        return { platform: this.platform, visualRef: input.visualRef, role: input.role, mediaId, ...(url ? { url } : {}), sha256: input.sha256, simulated: false };
    }
    normalizeError(error) {
        if (isRecord(error) && isRecord(error.normalized))
            return error.normalized;
        const candidate = isRecord(error) ? error : {};
        const status = typeof candidate.status === 'number' ? candidate.status : undefined;
        const codeValue = readString(candidate.code);
        let code = ERROR_CODES.has(codeValue ?? '') ? codeValue : 'REMOTE_ERROR';
        if (status === 401 || status === 403)
            code = 'UNAUTHORIZED';
        else if (status === 404)
            code = 'NOT_FOUND';
        else if (status === 409)
            code = 'CONFLICT';
        else if (status === 429)
            code = 'RATE_LIMITED';
        else if (candidate.name === 'AbortError' || codeValue === 'TIMEOUT')
            code = 'TIMEOUT';
        const unknown = code === 'TIMEOUT' || candidate.unknown === true;
        const retryable = typeof candidate.retryable === 'boolean' ? candidate.retryable : ['RATE_LIMITED', 'TIMEOUT', 'REMOTE_ERROR'].includes(code);
        const safeMessage = readString(candidate.message);
        const message = code === 'TIMEOUT'
            ? `HTTP connector ${this.platform} request timed out`
            : code === 'VALIDATION_FAILED'
                ? safeMessage ?? 'Connector validation failed'
                : (code === 'UNAUTHORIZED' && safeMessage === 'access credential is unavailable')
                    || (code === 'NOT_CONFIGURED' && safeMessage === 'credential vault is unavailable')
                    ? safeMessage
                    : `HTTP connector ${this.platform} request failed`;
        const details = isRecord(candidate.details) ? redact(candidate.details) : undefined;
        return { code, message, retryable, unknown, status, platform: this.platform, ...(details ? { details } : {}) };
    }
    async write(operation, ctx, input) {
        const config = this.requireConfig();
        const findings = this.validateWrite(input);
        if (findings.some(finding => finding.severity === 'error'))
            throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: findings.map(finding => finding.message).join('; ') }));
        const existing = this.writes.get(input.idempotencyKey);
        if (existing?.requestId)
            return { platform: this.platform, operation, remoteId: existing.remoteId ?? input.remoteId ?? '', requestId: existing.requestId, status: existing.state === 'published' ? 'published' : 'submitted', simulated: false, idempotencyKey: input.idempotencyKey };
        const path = operation === 'create' ? config.api.createPath : config.api.updatePath;
        const payload = await this.request('POST', joinUrl(config.api.baseUrl, path), await this.resolveCredential(ctx), { ...input.fields, ...(input.remoteId ? { remoteId: input.remoteId } : {}), idempotencyKey: input.idempotencyKey });
        const mapped = config.mapWriteReceipt?.(payload, input, operation, this.platform) ?? { platform: this.platform, operation, remoteId: isRecord(payload) ? readString(payload.remoteId) ?? input.remoteId ?? '' : input.remoteId ?? '', requestId: isRecord(payload) ? readString(payload.requestId) ?? `http_req_${randomUUID()}` : `http_req_${randomUUID()}`, status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey };
        // A successful write response means the platform accepted the request.
        // It is never proof that the remote product is published; only queryWrite
        // with platform status evidence may transition to `published`.
        const receipt = { ...mapped, status: 'submitted' };
        this.writes.set(input.idempotencyKey, { found: true, state: 'submitted', remoteId: receipt.remoteId, requestId: receipt.requestId, simulated: false });
        return receipt;
    }
    async resolveCredential(ctx) {
        this.requireConfig();
        let credential;
        try {
            credential = await this.requireProvider().resolve(ctx);
        }
        catch {
            throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'access credential is unavailable' }));
        }
        if (!credential?.accessToken)
            throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'access credential is unavailable' }));
        const expiresAt = credential.expiresAt ? Date.parse(credential.expiresAt) : Number.NaN;
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + CREDENTIAL_EXPIRY_SKEW_MS) {
            if (!credential.refreshToken || !this.config?.oauth.refreshUrl) {
                throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'access credential is expired and cannot be refreshed' }));
            }
            try {
                const refreshed = await this.refreshCredential({ workspaceId: ctx.workspaceId, accountId: ctx.accountId, credentialRef: ctx.credentialRef ?? '' });
                credential = await this.requireProvider().resolve(refreshed);
            }
            catch {
                throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'access credential refresh failed' }));
            }
            if (!credential?.accessToken)
                throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'refreshed access credential is unavailable' }));
        }
        return credential;
    }
    parseCredential(payload, previous) {
        const tokenPayload = isRecord(payload) ? payload : {};
        const accessToken = readString(tokenPayload.access_token);
        if (!accessToken)
            throw new ConnectorFailure(this.normalizeError({ code: 'REMOTE_ERROR', message: 'token response did not contain an access token' }));
        const expiresIn = typeof tokenPayload.expires_in === 'number' ? tokenPayload.expires_in : undefined;
        return { accessToken, tokenType: readString(tokenPayload.token_type) ?? previous?.tokenType, refreshToken: readString(tokenPayload.refresh_token) ?? previous?.refreshToken, scope: readString(tokenPayload.scope) ?? previous?.scope, expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : previous?.expiresAt };
    }
    async request(method, url, credential, body, encoding = 'json', revokeOnly = false) {
        const config = revokeOnly ? this.requireRevokeConfig() : this.requireConfig();
        const headers = { accept: 'application/json' };
        if (credential)
            headers.authorization = `${credential.tokenType ?? 'Bearer'} ${credential.accessToken}`;
        let serialized;
        if (body !== undefined) {
            if (encoding === 'form' && isRecord(body)) {
                headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
                serialized = new URLSearchParams(Object.entries(body).reduce((result, [key, value]) => { if (value !== undefined && value !== null)
                    result[key] = String(value); return result; }, {})).toString();
            }
            else {
                headers['content-type'] = 'application/json';
                serialized = JSON.stringify(body);
            }
        }
        const descriptor = { method, url, headers: { ...headers }, ...(serialized ? { body: serialized } : {}), platform: this.platform, ...(credential ? { credential } : {}) };
        const signed = await config.signer?.sign(descriptor);
        Object.assign(headers, signed ?? {});
        Object.assign(headers, descriptor.headers);
        const requestUrl = descriptor.url;
        const requestBody = descriptor.body;
        if (isSecureEnvironment()) {
            await assertOutboundUrl(requestUrl, {
                environment: process.env.NODE_ENV,
                allowedHosts: config.allowedHosts ?? officialHostsFor(this.platform),
            });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        try {
            const response = await this.fetchImpl(requestUrl, { method, headers, ...(requestBody ? { body: requestBody } : {}), signal: controller.signal, redirect: 'error' });
            const text = await readBoundedResponseText(response, MAX_PLATFORM_RESPONSE_BYTES);
            let payload = undefined;
            try {
                payload = text ? JSON.parse(text) : undefined;
            }
            catch {
                payload = text;
            }
            if (!response.ok)
                throw { status: response.status, message: `platform HTTP ${response.status}`, details: isRecord(payload) ? { platformCode: payload.code, requestId: payload.requestId } : undefined };
            return payload;
        }
        catch (error) {
            const normalized = this.normalizeError(error);
            throw new ConnectorFailure(normalized);
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
export function createHttpConnector(platform, options) {
    // The constructor is intentionally usable with an incomplete config so the
    // runtime can expose a stable connector and fail closed per operation.
    const profile = { jd: jdProfile, taobao: taobaoProfile, tmall: tmallProfile, pinduoduo: pinduoduoProfile, xiaohongshu: xiaohongshuProfile, douyin: douyinProfile }[platform];
    return new HttpPlatformConnector(profile, options);
}
//# sourceMappingURL=http-connector.js.map