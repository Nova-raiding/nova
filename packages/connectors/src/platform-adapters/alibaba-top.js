import { createHash, createHmac } from 'node:crypto';
import { mapPlatformRejection } from './rejection.js';
/**
 * Alibaba TOP signer for Taobao/Tmall HTTP calls. The endpoint path must carry
 * the TOP `method` query parameter (for example
 * `?method=taobao.item.seller.get`). The access token is held in memory and
 * emitted as TOP's `session` form parameter for this request only.
 */
export function createAlibabaTopSigner(options) {
    if (!options.appKey.trim() || !options.appSecret.trim())
        throw new Error('TOP app key and app secret are required');
    return {
        kind: 'platform',
        sign(request) {
            const url = new URL(request.url);
            const params = {};
            for (const [key, value] of url.searchParams.entries())
                params[key] = value;
            if (!params.method)
                throw new Error('TOP request URL must include method');
            if (request.body) {
                try {
                    const body = JSON.parse(request.body);
                    for (const [key, value] of Object.entries(body))
                        if (value !== undefined && value !== null)
                            params[key] = typeof value === 'string' ? value : JSON.stringify(value);
                }
                catch { /* non-JSON bodies are signed as-is by their caller */ }
            }
            params.app_key = options.appKey;
            params.timestamp = formatTopTimestamp((options.now ?? (() => new Date()))());
            params.v = params.v ?? '2.0';
            params.format = params.format ?? 'json';
            params.sign_method = options.signMethod ?? 'hmac-sha256';
            if (request.credential?.accessToken)
                params.session = request.credential.accessToken;
            delete params.sign;
            const canonical = Object.keys(params).sort().map(key => `${key}${params[key]}`).join('');
            params.sign = signTop(options.signMethod ?? 'hmac-sha256', options.appSecret, canonical);
            url.search = '';
            request.url = url.toString();
            request.body = new URLSearchParams(params).toString();
            request.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
            return {};
        },
    };
}
function formatTopTimestamp(value) {
    const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(value);
    const read = (type) => parts.find(part => part.type === type)?.value ?? '00';
    return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}:${read('second')}`;
}
function signTop(method, secret, canonical) {
    if (method === 'md5')
        return createHash('md5').update(`${secret}${canonical}${secret}`, 'utf8').digest('hex').toUpperCase();
    return createHmac(method === 'hmac' ? 'sha1' : 'sha256', secret).update(canonical, 'utf8').digest('hex').toUpperCase();
}
export { formatTopTimestamp };
/** Conservative mapper for the common TOP item envelope. Unknown fields stay
 * in platformFields and are never promoted to confirmed facts automatically. */
export function mapAlibabaTopProducts(payload, platform) {
    const record = asRecord(payload);
    const itemEnvelope = asRecord(record?.items);
    const candidates = Array.isArray(record?.items) ? record.items : Array.isArray(itemEnvelope?.item) ? itemEnvelope.item : record?.item ? [record.item] : [];
    return candidates.filter(asRecord).map((item, index) => {
        const sku = Array.isArray(item.skus) ? item.skus.filter(asRecord).map((value, skuIndex) => ({ id: stringValue(value.sku_id) ?? `${index}-${skuIndex}`, name: stringValue(value.properties_name) ?? stringValue(value.name) ?? '', price: numberValue(value.price), stock: numberValue(value.quantity) })) : [];
        return {
            remoteId: stringValue(item.num_iid) ?? stringValue(item.item_id) ?? `${platform}-item-${index}`,
            title: stringValue(item.title) ?? '', description: stringValue(item.desc) ?? stringValue(item.description) ?? '',
            price: numberValue(item.price), stock: numberValue(item.num), sku, images: arrayStrings(item.pic_url ? [item.pic_url] : item.pics), category: stringValue(item.cid) ?? '', attributes: {}, platformFields: item, observedAt: new Date().toISOString(),
        };
    });
}
export function mapAlibabaTopWriteReceipt(payload, input, operation, platform) {
    const record = asRecord(payload);
    return { platform, operation, remoteId: stringValue(record?.num_iid) ?? stringValue(record?.item_id) ?? input.remoteId ?? '', requestId: stringValue(record?.request_id) ?? stringValue(record?.task_id) ?? `top-${Date.now()}`, status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey };
}
export function mapAlibabaTopWriteStatus(payload, request, platform) {
    const record = asRecord(payload);
    const state = ['submitted', 'published', 'rejected', 'unknown'].includes(String(record?.state)) ? String(record?.state) : record?.success === true ? 'submitted' : 'unknown';
    const rejection = state === 'rejected' ? mapPlatformRejection(payload) : undefined;
    return { found: record?.found === true || Boolean(stringValue(record?.num_iid) ?? stringValue(record?.item_id)) || state === 'rejected', state, ...(stringValue(record?.num_iid) ?? stringValue(record?.item_id) ? { remoteId: stringValue(record?.num_iid) ?? stringValue(record?.item_id) } : {}), ...(stringValue(record?.request_id) ? { requestId: stringValue(record?.request_id) } : { requestId: request.idempotencyKey }), simulated: false, ...(rejection ? { rejection } : {}) };
}
function asRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
function stringValue(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined; }
function numberValue(value) { const valueNumber = typeof value === 'number' ? value : Number(value); return Number.isFinite(valueNumber) ? valueNumber : 0; }
function arrayStrings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []; }
//# sourceMappingURL=alibaba-top.js.map