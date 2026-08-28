/** Read an untrusted HTTP response without allowing an unbounded body allocation. */
export async function readBoundedResponseText(response, maxBytes, label = 'remote response') {
    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
        throw new Error(`${label} exceeded safety limit`);
    if (!response.body) {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes)
            throw new Error(`${label} exceeded safety limit`);
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
                throw new Error(`${label} exceeded safety limit`);
            }
            chunks.push(next.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}
//# sourceMappingURL=bounded-response.js.map