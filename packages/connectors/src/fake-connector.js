import { createHash, randomUUID } from 'node:crypto';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class FakePlatformConnector {
    profile;
    platform;
    writes = new Map();
    revoked = false;
    options;
    constructor(profile, options = {}) {
        this.profile = profile;
        this.platform = profile.platform;
        this.options = { configured: options.configured ?? false, allowFakeWrites: options.allowFakeWrites ?? true, fault: options.fault };
    }
    throwFault(operation) { if (this.options.fault) {
        const fault = this.options.fault(operation);
        if (fault)
            throw fault;
    } }
    notConfigured() { throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: `${this.platform} official API is not configured` })); }
    async authorize(input) {
        this.throwFault('authorize');
        if (!this.options.configured)
            return { ok: false, platform: this.platform, mode: 'not_configured', code: 'NOT_CONFIGURED', message: `${this.platform} official API is not configured` };
        return { ok: true, platform: this.platform, mode: 'fixture', authorizationUrl: `https://fixture.invalid/${this.platform}/authorize?state=${encodeURIComponent(input.state)}` };
    }
    async exchangeCode(input) {
        this.throwFault('exchangeCode');
        if (!this.options.configured)
            this.notConfigured();
        this.revoked = false;
        return {
            accountId: `acct_${this.platform}_${hash(input.state).slice(0, 8)}`,
            credentialRef: `fixture-secret/${this.platform}/${randomUUID()}`,
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
            scope: 'fixture.product.read fixture.product.write',
            refreshable: true,
        };
    }
    async refreshCredential(ref) { this.throwFault('refreshCredential'); if (!this.options.configured)
        this.notConfigured(); if (this.revoked)
        this.unauthorized(); return { ...ref, expiresAt: new Date(Date.now() + 3600_000).toISOString() }; }
    async revoke(_ref) { this.throwFault('revoke'); if (!this.options.configured)
        this.notConfigured(); this.revoked = true; }
    async syncProducts(_ctx, cursor) {
        this.throwFault('syncProducts');
        if (this.revoked)
            this.unauthorized();
        return { items: cursor?.value ? [] : [structuredClone(this.profile.fixture)], source: 'fixture', simulated: true };
    }
    mapToCanonical(raw, mapping) { return this.profile.mapProduct(raw, mapping); }
    validateWrite(input) { return this.profile.validateWrite(input); }
    async createProduct(ctx, input) { return this.write('create', ctx, input); }
    async updateProduct(ctx, input) { return this.write('update', ctx, input); }
    async queryWrite(_ctx, request) {
        this.throwFault('queryWrite');
        if (this.revoked)
            this.unauthorized();
        return this.writes.get(request.idempotencyKey) ?? { found: false, state: 'unknown', simulated: true };
    }
    normalizeError(error) {
        const candidate = error;
        const code = candidate?.code;
        const normalizedCode = ['NOT_CONFIGURED', 'UNAUTHORIZED', 'RATE_LIMITED', 'TIMEOUT', 'CONFLICT', 'VALIDATION_FAILED', 'NOT_FOUND', 'REMOTE_ERROR'].includes(code ?? '') ? code : 'UNKNOWN';
        const unknown = candidate?.unknown === true || normalizedCode === 'TIMEOUT';
        const retryable = candidate?.retryable ?? ['RATE_LIMITED', 'TIMEOUT', 'REMOTE_ERROR'].includes(normalizedCode);
        return { code: normalizedCode, message: candidate?.message ?? 'Unknown connector failure', retryable, unknown, status: candidate?.status, platform: this.platform };
    }
    async write(operation, _ctx, input) {
        this.throwFault(operation);
        if (this.revoked)
            this.unauthorized();
        if (!this.options.configured && !this.options.allowFakeWrites)
            this.notConfigured();
        const findings = this.validateWrite(input);
        if (findings.some(finding => finding.severity === 'error'))
            throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: findings.map(finding => finding.message).join('; '), retryable: false }));
        const existing = this.writes.get(input.idempotencyKey);
        if (existing?.requestId)
            return { platform: this.platform, operation, remoteId: existing.remoteId ?? input.remoteId ?? `${this.platform}-fake-created`, requestId: existing.requestId, status: existing.state === 'published' ? 'published' : 'submitted', simulated: true, idempotencyKey: input.idempotencyKey };
        const receipt = { platform: this.platform, operation, remoteId: input.remoteId ?? `${this.platform}-fake-created`, requestId: `fake_req_${randomUUID()}`, status: 'submitted', simulated: true, idempotencyKey: input.idempotencyKey };
        this.writes.set(input.idempotencyKey, { found: true, state: 'submitted', remoteId: receipt.remoteId, requestId: receipt.requestId, simulated: true });
        return receipt;
    }
    unauthorized() {
        throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: `${this.platform} fixture credential has been revoked` }));
    }
}
export class ConnectorFailure extends Error {
    normalized;
    constructor(normalized) {
        super(normalized.message);
        this.normalized = normalized;
    }
}
//# sourceMappingURL=fake-connector.js.map