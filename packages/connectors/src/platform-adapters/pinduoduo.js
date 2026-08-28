import { createHash } from 'node:crypto';
import { mapPlatformRejection } from './rejection.js';
/** Pinduoduo router signer. The generic connector supplies the API `type` in the URL. */
export function createPinduoduoSigner(options) {
    if (!options.clientId.trim() || !options.clientSecret.trim())
        throw new Error('PDD client id and client secret are required');
    return {
        kind: 'platform',
        sign(request) {
            const url = new URL(request.url);
            const params = {};
            for (const [key, value] of url.searchParams.entries())
                params[key] = value;
            if (request.body) {
                try {
                    const body = JSON.parse(request.body);
                    for (const [key, value] of Object.entries(body))
                        if (value !== undefined && value !== null)
                            params[key] = typeof value === 'string' ? value : JSON.stringify(value);
                }
                catch { /* form body is already represented by query parameters */ }
            }
            params.client_id = options.clientId;
            params.timestamp = String(Math.floor((options.now ?? (() => new Date()))().getTime() / 1000));
            params.data_type = params.data_type ?? 'JSON';
            if (request.credential?.accessToken)
                params.access_token = request.credential.accessToken;
            delete params.sign;
            const canonical = Object.keys(params).sort().map(key => `${key}${params[key]}`).join('');
            params.sign = createHash('md5').update(`${options.clientSecret}${canonical}${options.clientSecret}`, 'utf8').digest('hex').toUpperCase();
            url.search = '';
            request.url = url.toString();
            request.body = new URLSearchParams(params).toString();
            request.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
            return {};
        },
    };
}
export function mapPinduoduoProducts(payload) {
    const root = record(payload);
    const envelope = firstRecord(root?.goods_search_response, root?.goods_detail_response, root?.result);
    const candidates = arrayOf(envelope?.goods_list ?? envelope?.goods_detail_list ?? root?.goods_list ?? root?.items);
    return candidates.map((item, index) => ({
        remoteId: stringValue(item.goods_sign) ?? stringValue(item.goods_id) ?? `pdd-item-${index}`,
        title: stringValue(item.goods_name) ?? stringValue(item.title) ?? '', description: stringValue(item.goods_desc) ?? stringValue(item.description) ?? '',
        price: numberValue(item.min_group_price ?? item.min_normal_price ?? item.price) / (Number(item.min_group_price ?? item.min_normal_price ?? item.price) > 1000 ? 100 : 1),
        stock: numberValue(item.stock ?? item.quantity), sku: [], images: strings(item.goods_image_url ? [item.goods_image_url] : item.goods_image_urls), category: stringValue(item.cat_id) ?? '', attributes: {}, platformFields: item, observedAt: new Date().toISOString(),
    }));
}
export function mapPinduoduoWriteReceipt(payload, input, operation) {
    const root = record(payload);
    return { platform: 'pinduoduo', operation, remoteId: stringValue(root?.goods_sign) ?? stringValue(root?.goods_id) ?? input.remoteId ?? '', requestId: stringValue(root?.request_id) ?? stringValue(root?.task_id) ?? `pdd-${Date.now()}`, status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey };
}
export function mapPinduoduoWriteStatus(payload, request) {
    const root = record(payload);
    const remoteId = stringValue(root?.goods_sign) ?? stringValue(root?.goods_id);
    const state = ['submitted', 'published', 'rejected', 'unknown'].includes(String(root?.state)) ? String(root?.state) : root?.success === true ? 'submitted' : 'unknown';
    const rejection = state === 'rejected' ? mapPlatformRejection(payload) : undefined;
    return { found: root?.found === true || Boolean(remoteId) || state === 'rejected', state, ...(remoteId ? { remoteId } : {}), requestId: stringValue(root?.request_id) ?? request.idempotencyKey, simulated: false, ...(rejection ? { rejection } : {}) };
}
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
function firstRecord(...values) { return values.map(record).find(Boolean); }
function stringValue(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined; }
function numberValue(value) { const result = typeof value === 'number' ? value : Number(value); return Number.isFinite(result) ? result : 0; }
function arrayOf(value) { return Array.isArray(value) ? value.filter((item) => Boolean(record(item))) : []; }
function strings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []; }
//# sourceMappingURL=pinduoduo.js.map